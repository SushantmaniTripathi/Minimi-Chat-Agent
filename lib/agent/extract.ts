import { groqProvider } from "../providers/groq";
import { activeClaimsForEntity, recordClaim, upsertEntity } from "./claims";

const PREDICATES = new Set([
  "price",
  "availability",
  "version",
  "ceo",
  "address",
  "headcount",
  "user_role",
  "user_preference",
  "release_date",
]);

const KINDS = new Set(["product", "org", "person", "place", "topic", "self"]);

/** Cheap gate: don't spend a model call (or quota) on turns with nothing durable in them. */
const CONCRETE =
  /(\$|₹|€|£|\b\d+(\.\d+)?\s*(%|percent|k|m|gb|tb|hours?|days?|months?|users?|usd|inr|eur|gbp|per month|mo)\b|\b(19|20)\d{2}\b|\bv?\d+(\.\d+)+|\bceo\b|\bfounder\b|\bmy\b|\bi(?:'m| am)\b)/i;

export function shouldExtract(userMessage: string, answer: string, usedSearch: boolean): boolean {
  if (usedSearch) return true;
  return CONCRETE.test(userMessage) || CONCRETE.test(answer);
}

const EXTRACT_SYSTEM = `You extract durable, checkable facts from ONE chat turn.

Return ONLY compact JSON, no prose and no code fences:
{"claims":[{"entity":"...","kind":"...","predicate":"...","value":"..."}]}

Rules:
- entity: the concrete thing the fact is about (product, company, person, place). Use the surface form the user used.
  It must be something the USER named or asked about — never an incidental item the answer happened to list.
- kind: one of product | org | person | place | topic | self
- predicate: one of price | availability | version | ceo | address | headcount | user_role | user_preference | release_date
- value: the shortest standalone value, e.g. "$20/mo", "2026-11-03", "Satya Nadella", "founder"
- Use kind "self" and predicate "user_role"/"user_preference" for facts the USER states about themselves.
- Only facts explicitly stated in the turn. No opinions, no predictions, no facts about the assistant.
- At most 3 claims. If there is nothing durable, return {"claims":[]}.`;

interface ExtractedClaim {
  entity: string;
  kind: string;
  predicate: string;
  value: string;
}

function parseClaims(raw: string): ExtractedClaim[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed?.claims)) return [];
    return parsed.claims
      .filter((c: any) => c && typeof c.entity === "string" && typeof c.value === "string")
      .map((c: any) => ({
        entity: c.entity.trim().slice(0, 80),
        kind: typeof c.kind === "string" && KINDS.has(c.kind) ? c.kind : "topic",
        predicate: typeof c.predicate === "string" ? c.predicate.trim() : "",
        value: c.value.trim().slice(0, 120),
      }))
      .filter((c: ExtractedClaim) => c.entity.length >= 2 && c.value.length > 0 && PREDICATES.has(c.predicate))
      // Only one active claim may exist per (entity, predicate). The extractor
      // often lists several figures (monthly and annual price); keeping the first
      // preserves the headline value instead of letting the last one overwrite it.
      .filter(
        (c: ExtractedClaim, i: number, all: ExtractedClaim[]) =>
          all.findIndex(
            (o: ExtractedClaim) =>
              o.entity.toLowerCase() === c.entity.toLowerCase() && o.predicate === c.predicate
          ) === i
      );
  } catch {
    return [];
  }
}

/**
 * An entity is only worth remembering if the turn was actually *about* it. The
 * extractor otherwise happily records every plan tier the answer happened to
 * list ("Enterprise Plan → price = custom"), which pollutes future recall.
 */
function mentionedByUser(entity: string, userMessage: string): boolean {
  const haystack = userMessage.toLowerCase();
  const words = entity
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

/**
 * Runs in `after()` — after the response is flushed, so it costs the user zero
 * latency, and on Groq's separate quota so it can't starve the chat path.
 * Must never throw: a failed extraction loses one fact, a thrown error loses the run.
 */
export async function extractClaims(opts: {
  userId: string;
  messageId: string;
  userMessage: string;
  answer: string;
  usedSearch: boolean;
  sourceUrl?: string | null;
}): Promise<void> {
  if (!groqProvider.enabled) return;
  if (!shouldExtract(opts.userMessage, opts.answer, opts.usedSearch)) return;
  if (opts.answer.trim().length < 20) return;

  try {
    const result = await groqProvider.chat([
      { role: "system", content: EXTRACT_SYSTEM },
      {
        role: "user",
        content: `USER: ${opts.userMessage.slice(0, 1200)}\n\nASSISTANT: ${opts.answer.slice(0, 2000)}`,
      },
    ]);

    let raw = "";
    for await (const chunk of result.stream) raw += chunk;
    const claims = parseClaims(raw).filter(
      (c) => c.kind === "self" || mentionedByUser(c.entity, opts.userMessage)
    );
    if (claims.length === 0) return;

    for (const c of claims.slice(0, 3)) {
      const isSelf = c.kind === "self";
      const entity = upsertEntity(
        opts.userId,
        isSelf ? "self" : c.kind,
        isSelf ? "user" : c.entity,
        isSelf ? ["user", "me", "myself"] : [c.entity]
      );

      // An answer that ran no search is the model's own recall, not evidence.
      // It may fill a gap, but it must never overwrite a claim we actually
      // verified — otherwise memory quietly degrades itself over time.
      if (!opts.usedSearch) {
        const existing = activeClaimsForEntity(opts.userId, entity.id);
        if (existing.some((e) => e.predicate === c.predicate)) continue;
      }

      recordClaim({
        userId: opts.userId,
        entityId: entity.id,
        predicate: c.predicate,
        value: c.value,
        sourceKind: c.predicate.startsWith("user_")
          ? "user"
          : opts.usedSearch
            ? "web"
            : "model_inference",
        sourceUrl: opts.usedSearch ? opts.sourceUrl ?? null : null,
        messageId: opts.messageId,
        justVerified: opts.usedSearch,
        confidence: opts.usedSearch ? 0.85 : 0.65,
      });
    }
  } catch {
    // Best effort by design. Claims are an optimisation for future turns, never
    // a dependency of the current one.
  }
}
