import { randomUUID } from "crypto";
import { Citation, TurnMode, getMessages, insertMessage, insertTurnMetric } from "../db";
import { chatWithFallback, runWithTools } from "../providers";
import { ChatMessage, ToolEvent, ToolRun } from "../providers/types";
import { SearchOutcome, WEB_SEARCH_TOOL, formatForTool, groundingTool, webSearch } from "../search";
import { ClaimView } from "./claims";
import { planTurn } from "./plan";

const SYSTEM_PROMPT = `You are Minimi, a sharp, direct, conversational AI assistant.

Style:
- Be concise and genuinely helpful, not padded. Talk like a knowledgeable person, not a press release.

Memory:
- The "What you already know" block is your durable memory of facts, each with when it was last verified.
- Never restate a fact marked STALE as if it were current. If fresh evidence is supplied above, use it and
  cite it. If it isn't, say plainly that you could not confirm it just now — do not guess.
- When you can see both an older value and a newer one, say what changed and when it changed.
- Never claim to remember something that is not in your context. If the user refers to something you don't
  have, say so instead of inventing it.

Search:
- If live web results are supplied, ground your answer in them and cite inline as [1], [2], etc. matching the
  numbered list. Do not invent URLs or facts.
- If no live web results are supplied this turn, do not emit citation markers at all — say the fact comes from
  what you already know, instead of implying a source you can't show.
- You may call web_search at most once per turn, and only when the answer depends on current facts you cannot
  already see. Do not search for things that are already in your context.
- If no search was run and the question could be out of date, say so plainly rather than guessing.

Honesty:
- Clearly separate verified facts (from search results or stored memory) from your own inference.
  Flag assumptions explicitly, e.g. "I don't have a confirmed source for this, but...".`;

export type AgentEvent =
  | {
      type: "meta";
      mode: TurnMode;
      claims: ClaimView[];
      usedSearch: boolean;
      citations: Citation[];
      model: string | null;
      searchNote?: string;
      /**
       * Subjects the planner attached to this turn, including ones inherited from
       * an earlier message ("since then"). Extraction uses them to know which
       * entities the user pointed at without naming.
       */
      entities?: string[];
    }
  | { type: "status"; label: string }
  | { type: "delta"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

/**
 * How long a pre-dispatched search may take before we stop waiting and let the
 * model pull it through the tool instead. Waiting is the cheaper option: the
 * tool path costs a whole extra model round trip (~10–25s on a free tier),
 * while a search usually lands in 1–3s.
 *
 * This is deliberately a little longer than the provider's own 6s request
 * timeout: at 5s the wait could give up on a search that was about to succeed,
 * turning a grounded answer into "I couldn't confirm that just now".
 */
const SEARCH_WAIT_MS = 6500;

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

export async function* runAgent(
  conversationId: string,
  userMessage: string,
  userId: string
): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();

  // 1. Persist the user's turn immediately — it must survive even if the rest fails.
  const userMsgId = randomUUID();
  insertMessage({ id: userMsgId, conversation_id: conversationId, role: "user", content: userMessage });

  // 2. Plan the turn from local state only: no model call, no network.
  const plan = planTurn({ userId, message: userMessage, conversationId });

  yield {
    type: "meta",
    mode: plan.mode,
    claims: plan.claimViews,
    usedSearch: false,
    citations: [],
    model: null,
    entities: plan.entities.map((e) => e.canonical_name),
  };

  // 3. When the planner already knows a live lookup is needed, start it before
  //    the model call and let the two overlap instead of running back to back.
  //    VERIFY means "a stored claim is stale"; presearch means "the question is
  //    inherently live and we hold no claim". Both save a full model round trip.
  let searchP: Promise<SearchOutcome> | null = null;
  if (plan.mode === "verify" && plan.query) {
    searchP = webSearch({ userId, query: plan.query });
    yield { type: "status", label: "Checking whether that's still true…" };
  } else if (plan.presearchQuery) {
    searchP = webSearch({ userId, query: plan.presearchQuery });
    yield { type: "status", label: "Checking live sources…" };
  }

  // A fast search is injected into the prompt directly — one model call, grounded.
  // Only a search that overruns the budget is left for the model to pull via the
  // tool (served from this same promise, so it is never fetched twice).
  const searchStarted = Date.now();
  const evidence: SearchOutcome | null = searchP ? await Promise.race([searchP, delay(SEARCH_WAIT_MS)]) : null;
  const searchMs = evidence ? Date.now() - searchStarted : 0;

  let citations: Citation[] = evidence?.ok ? evidence.results : [];
  let usedSearch = Boolean(evidence?.ok);
  let searchSource = evidence?.source ?? "none";
  let searchNote: string | undefined = evidence && !evidence.ok ? evidence.reason : undefined;

  // 4. Assemble the prompt.
  const parts: string[] = [];
  if (plan.claimsBlock) parts.push(plan.claimsBlock);
  if (plan.anchored) {
    parts.push(
      `This message is a follow-up about ${plan.entities
        .map((e) => e.canonical_name)
        .join(", ")} — read "that"/"it" as referring to it.`
    );
  }
  if (plan.contextBlock) parts.push(plan.contextBlock);
  if (plan.compare) {
    parts.push(
      "The user is asking whether this changed. If you can see an earlier value and a current one, state what changed and when."
    );
  }
  if (evidence?.ok) {
    parts.push("Live web results (cite as [1], [2]...):\n" + formatForTool(evidence.results));
  } else if (evidence && !evidence.ok) {
    parts.push(
      `(Live verification was needed but unavailable: ${evidence.reason}. Tell the user you couldn't confirm this just now instead of guessing.)`
    );
  }

  const history = getMessages(conversationId)
    .filter((m) => m.id !== userMsgId)
    .slice(-12);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
    ...(parts.length > 0 ? [{ role: "system" as const, content: parts.join("\n\n") }] : []),
    { role: "user", content: userMessage },
  ];

  /**
   * Tools are offered only when they can change the answer:
   * - RECALL (fresh claims): no tools. Searching invites needless hedging.
   * - VERIFY with evidence in hand: no tools. The evidence is already in the prompt.
   * - VERIFY where the search is still in flight: tool, served from that same promise.
   * - ANSWER: tool, so the model can decide.
   */
  const tools: unknown[] = [];
  if (plan.mode !== "recall" && !evidence?.ok) {
    tools.push(WEB_SEARCH_TOOL);
    const grounding = groundingTool();
    if (grounding) tools.push(grounding);
  }

  let modelUsed: string | null = null;
  let fullText = "";
  let ttftMs: number | null = null;
  let toolMs: number | null = null;

  try {
    const run = tools.length > 0 ? await runWithTools({ messages, tools }) : null;

    if (!run) {
      // Fast path: one streaming call, no tool machinery.
      const result = await chatWithFallback(messages);
      modelUsed = `${result.providerName}:${result.modelUsed}`;
      // Re-emit meta now that the model is known: the client uses this for the
      // model badge and to reconcile usedSearch/citations after a search-failed turn.
      yield {
        type: "meta",
        mode: plan.mode,
        claims: plan.claimViews,
        usedSearch,
        citations,
        model: modelUsed,
        ...(searchNote ? { searchNote } : {}),
      };
      for await (const chunk of result.stream) {
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        fullText += chunk;
        yield { type: "delta", text: chunk };
      }
    } else {
      modelUsed = `${run.providerName}:${run.modelUsed}`;
      yield {
        type: "meta",
        mode: plan.mode,
        claims: plan.claimViews,
        usedSearch,
        citations,
        model: modelUsed,
        ...(searchNote ? { searchNote } : {}),
      };
      let current: ToolRun | null = run;
      let rounds = 0;
      let pending: Extract<ToolEvent, { kind: "tool_call" }> | null = null;

      while (current) {
        // Bind the generator to an explicit type: assigning `current` inside this
        // loop from `current.resume` otherwise makes TS infer the event type circularly.
        const events: AsyncGenerator<ToolEvent, void, unknown> = current.events;
        for await (const evt of events) {
          if (evt.kind === "text") {
            if (ttftMs === null) ttftMs = Date.now() - startedAt;
            fullText += evt.text;
            yield { type: "delta", text: evt.text };
          } else {
            pending = evt;
            break;
          }
        }

        if (!pending) break;
        if (rounds >= 1) break; // one tool cycle, hard cap
        rounds += 1;

        const query = typeof pending.args.query === "string" ? pending.args.query : plan.query;
        yield { type: "status", label: "Searching the web…" };

        const toolStart = Date.now();
        // A pre-dispatched search is already about this user's question, so reuse
        // it rather than paying for a second identical lookup. The model's own
        // query only matters when no search was started ahead of time.
        const res = searchP ? await searchP : await webSearch({ userId, query });
        toolMs = Date.now() - toolStart;
        searchSource = res.source;

        if (res.ok) {
          usedSearch = true;
          citations = res.results;
        } else {
          searchNote = res.reason;
        }

        yield {
          type: "meta",
          mode: plan.mode,
          claims: plan.claimViews,
          usedSearch,
          citations,
          model: modelUsed,
          ...(searchNote ? { searchNote } : {}),
        };

        const payload = res.ok
          ? formatForTool(res.results)
          : `Search failed (${res.reason}). Answer without live data and tell the user you could not verify this.`;

        const call = pending;
        pending = null;
        current = current.resume
          ? await current.resume([{ name: call.name, callId: call.id, text: payload }])
          : null;
      }
    }

    // Safety net: if a tool round produced no text at all, still answer.
    if (!fullText.trim()) {
      const withEvidence = citations.length
        ? [...messages, { role: "system" as const, content: "Live web results:\n" + formatForTool(citations) }]
        : messages;
      const result = await chatWithFallback(withEvidence);
      modelUsed = `${result.providerName}:${result.modelUsed}`;
      for await (const chunk of result.stream) {
        if (ttftMs === null) ttftMs = Date.now() - startedAt;
        fullText += chunk;
        yield { type: "delta", text: chunk };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A free-tier stream can stall after headers and then abort, which surfaces
    // mid-generator rather than as a failed request. If nothing has been shown
    // yet, answer from the text-only provider instead of failing the turn.
    if (!fullText.trim()) {
      try {
        const withEvidence = citations.length
          ? [...messages, { role: "system" as const, content: "Live web results:\n" + formatForTool(citations) }]
          : messages;
        const result = await chatWithFallback(withEvidence, { skip: ["gemini"] });
        modelUsed = `${result.providerName}:${result.modelUsed}`;
        yield {
          type: "meta",
          mode: plan.mode,
          claims: plan.claimViews,
          usedSearch,
          citations,
          model: modelUsed,
          ...(searchNote ? { searchNote } : {}),
        };
        for await (const chunk of result.stream) {
          if (ttftMs === null) ttftMs = Date.now() - startedAt;
          fullText += chunk;
          yield { type: "delta", text: chunk };
        }
      } catch {
        yield { type: "error", message };
        yield { type: "done" };
        return;
      }
    } else {
      yield { type: "error", message };
      yield { type: "done" };
      return;
    }
  }

  // 5. Persist the assistant turn (even partial text, so history stays honest).
  const assistantId = randomUUID();
  insertMessage({
    id: assistantId,
    conversation_id: conversationId,
    role: "assistant",
    content: fullText,
    citations: citations.length > 0 ? citations : null,
    model_used: modelUsed,
    used_search: usedSearch,
    mode: plan.mode,
  });

  insertTurnMetric({
    id: randomUUID(),
    conversation_id: conversationId,
    mode: plan.mode,
    ttft_ms: ttftMs,
    search_ms: searchMs || null,
    tool_ms: toolMs,
    total_ms: Date.now() - startedAt,
    search_source: searchSource,
  });

  yield { type: "done" };
}

/** Exposed for tests and for the route's post-response extraction. */
export function lastAssistantMessageId(conversationId: string): string | null {
  const rows = getMessages(conversationId);
  const last = rows[rows.length - 1];
  return last && last.role === "assistant" ? last.id : null;
}
