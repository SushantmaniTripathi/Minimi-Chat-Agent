import {
  ChatMessage,
  ProviderError,
  ProviderResult,
  ToolCapableProvider,
  ToolEvent,
  ToolResult,
  ToolRun,
} from "./types";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
// "minimal" runs with zero thought tokens. That is the right trade here: the
// planner does the routing deterministically, so we don't need the model to
// think before it speaks, and thoughts are billed *and* paid for in latency.
const THINKING_LEVEL = process.env.GEMINI_THINKING || "minimal";

interface GeminiState {
  interactionId: string | null;
}

/** Gemini wants the system prompt as a separate string, not a message. */
function splitSystem(messages: ChatMessage[]): { system: string; turns: ChatMessage[] } {
  return {
    system: messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n"),
    turns: messages.filter((m) => m.role !== "system"),
  };
}

/**
 * The Interactions API takes a step list, so roles stay intact instead of being
 * flattened into one blob. A leading assistant turn is dropped: the API expects
 * the input to start with a user step.
 */
function toSteps(turns: ChatMessage[]): Array<Record<string, unknown>> {
  const usable = [...turns];
  while (usable.length > 0 && usable[0].role === "assistant") usable.shift();
  return usable.map((m) =>
    m.role === "assistant"
      ? { type: "model_output", content: [{ type: "text", text: m.content }] }
      : { type: "user_input", content: [{ type: "text", text: m.content }] }
  );
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY ?? "" },
    body: JSON.stringify(body),
    // A free tier can stall for a long time; failing over at 60s beats making the
    // user wait 90s for a request that may never stream.
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
    throw new ProviderError(`Gemini ${res.status}: ${text.slice(0, 240)}`, retryable, res.status);
  }
  return res;
}

/** SSE frames carry complete JSON payloads on single `data:` lines. */
async function* frames(res: Response): AsyncGenerator<any> {
  const reader = res.body?.getReader();
  if (!reader) throw new ProviderError("Gemini returned an empty body", true);

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // A frame split across reads; the next chunk completes it.
      }
    }
  }
}

async function* pump(res: Response, state: GeminiState): AsyncGenerator<ToolEvent, void, unknown> {
  let toolName: string | null = null;
  let toolId: string | null = null;
  let toolIndex = -1;
  let argsBuffer = "";
  let emitted = false;

  const flush = (): ToolEvent | null => {
    if (!toolName || emitted) return null;
    emitted = true;
    let args: Record<string, unknown> = {};
    try {
      args = argsBuffer ? JSON.parse(argsBuffer) : {};
    } catch {
      args = {};
    }
    return { kind: "tool_call", id: toolId ?? "", name: toolName, args };
  };

  for await (const frame of frames(res)) {
    if (frame?.error) {
      throw new ProviderError(frame.error.message ?? "Gemini stream error", true);
    }

    switch (frame.event_type) {
      case "interaction.created":
        state.interactionId = frame.interaction?.id ?? state.interactionId;
        break;

      case "step.start":
        if (frame.step?.type === "function_call") {
          toolName = frame.step.name ?? null;
          toolId = frame.step.id ?? null;
          toolIndex = frame.index ?? -1;
          argsBuffer = "";
        }
        break;

      case "step.delta": {
        const delta = frame.delta;
        if (delta?.type === "text" && typeof delta.text === "string" && delta.text.length > 0) {
          yield { kind: "text", text: delta.text };
        } else if (delta?.type === "arguments_delta" && typeof delta.arguments === "string") {
          argsBuffer += delta.arguments;
        }
        break;
      }

      case "step.stop": {
        if (frame.index === toolIndex) {
          const evt = flush();
          if (evt) yield evt;
        }
        break;
      }

      case "interaction.completed": {
        // Belt and braces: emit a pending tool call even if step.stop was missed.
        const evt = flush();
        if (evt) yield evt;
        break;
      }

      case "error":
        throw new ProviderError(frame.error?.message ?? "Gemini stream error", true);
    }
  }
}

function makeRun(res: Response, state: GeminiState, tools: unknown[]): ToolRun {
  return {
    events: pump(res, state),
    modelUsed: MODEL,
    providerName: "gemini",
    resume: async (results: ToolResult[]) => {
      const previous = state.interactionId;
      if (!previous) return null;
      const res2 = await post({
        model: MODEL,
        stream: true,
        previous_interaction_id: previous,
        generation_config: { thinking_level: THINKING_LEVEL },
        input: results.map((r) => ({
          type: "function_result",
          name: r.name,
          call_id: r.callId,
          result: [{ type: "text", text: r.text }],
        })),
        ...(tools.length > 0 ? { tools } : {}),
      });
      return makeRun(res2, state, tools);
    },
  };
}

async function start(opts: { messages: ChatMessage[]; tools: unknown[] }): Promise<ToolRun> {
  if (!API_KEY) throw new ProviderError("GEMINI_API_KEY not set", false);

  const { system, turns } = splitSystem(opts.messages);
  const state: GeminiState = { interactionId: null };

  const res = await post({
    model: MODEL,
    stream: true,
    input: toSteps(turns),
    generation_config: { thinking_level: THINKING_LEVEL },
    ...(system ? { system_instruction: system } : {}),
    ...(opts.tools.length > 0 ? { tools: opts.tools } : {}),
  });

  return makeRun(res, state, opts.tools);
}

export const geminiProvider: ToolCapableProvider = {
  name: "gemini",
  enabled: Boolean(API_KEY),

  async runWithTools(opts) {
    return start(opts);
  },

  async chat(messages: ChatMessage[]): Promise<ProviderResult> {
    const run = await start({ messages, tools: [] });
    return {
      stream: (async function* () {
        for await (const evt of run.events) {
          if (evt.kind === "text") yield evt.text;
        }
      })(),
      modelUsed: run.modelUsed,
      providerName: run.providerName,
    };
  },
};

export const geminiSupportsTools = true;
