import { ClaimRow, EntityRow, TurnMode, getMessages } from "../db";
import {
  ClaimView,
  activeClaimsForEntities,
  formatClaimsForPrompt,
  isStale,
  resolveEntities,
  toClaimView,
} from "./claims";
import { RetrievedContext, formatContextForPrompt, retrieveHistoryContext } from "./retrieval";

/** Phrasing that signals the user is asking about currentness, not just recall. */
const EXPLICIT_VERIFY =
  /\b(still|changed|change|current|currently|now|latest|today|as of|up to date|up-to-date|out of date|verify|check|again)\b/i;

/**
 * A follow-up like "is that still true?" names no entity. Without anchoring it
 * would fall through to ANSWER with an empty memory block — the exact case the
 * ledger exists for. These cues mean "the thing we were just talking about".
 */
const DANGLING_REFERENCE =
  /\b(that|this|it|those|these|they|them|its|their|the same|there|again|still true|still the case)\b/i;

const ANCHOR_WINDOW = 4;

/**
 * High-precision signals that the answer depends on live data even when we hold
 * no stored claim. Used to pre-dispatch a search so the model gets evidence in
 * its first call instead of spending a whole round trip deciding to ask for it.
 * Deliberately narrow: a wrong presearch costs a credit, a missed one costs
 * latency only.
 */
const LIVE_INTENT =
  /\b(price|pricing|cost|costs|how much|latest|current|currently|right now|today|this (week|month|year)|release[ds]?|available|availability|in stock|version|news|ceo|headcount|how many (users|customers|employees))\b/i;

/** A message that is nothing but a greeting shouldn't trigger a search. */
const GREETING_ONLY = /^\s*(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool)\b[\s!.?]*$/i;

export interface TurnPlan {
  mode: TurnMode;
  entities: EntityRow[];
  claims: ClaimRow[];
  claimViews: ClaimView[];
  staleClaims: ClaimRow[];
  /** Search query derived from the claim that needs checking. */
  query: string;
  compare: boolean;
  context: RetrievedContext;
  contextBlock: string;
  claimsBlock: string;
  /** true when the topic came from an earlier turn rather than this message. */
  anchored: boolean;
  /**
   * The planner is confident this turn needs live data but has no claim to check,
   * so the search should start before the model call. Empty = don't pre-search.
   */
  presearchQuery: string;
}

function searchQueryFor(claim: ClaimRow): string {
  const name = claim.entity_name ?? "";
  const predicate = claim.predicate.replace(/_/g, " ");
  return `${name} ${predicate}`.trim();
}

/**
 * Inherit the subject of the conversation when the current message only has a
 * pronoun. Walks backwards and takes the *most recent* turn that resolves an
 * entity, so a topic switch is picked up before an older, still-live subject.
 */
function anchorEntities(userId: string, conversationId: string, message: string): EntityRow[] {
  const history = getMessages(conversationId)
    .filter((m) => !(m.role === "user" && m.content === message))
    .slice(-ANCHOR_WINDOW)
    .reverse();

  for (const m of history) {
    const found = resolveEntities(userId, m.content);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * The deterministic planner. Pure, local, no model call — this is what replaced
 * the routing LLM. `VERIFY` is decided by a freshness predicate, not an opinion,
 * so a stale claim can never be silently restated as current.
 */
export function planTurn(opts: {
  userId: string;
  message: string;
  conversationId?: string;
  now?: Date;
}): TurnPlan {
  const now = opts.now ?? new Date();

  let entities = resolveEntities(opts.userId, opts.message);
  let anchored = false;
  if (entities.length === 0 && opts.conversationId && DANGLING_REFERENCE.test(opts.message)) {
    entities = anchorEntities(opts.userId, opts.conversationId, opts.message);
    anchored = entities.length > 0;
  }

  const claims = activeClaimsForEntities(
    opts.userId,
    entities.map((e) => e.id)
  );

  const verifiable = claims.filter((c) => c.verify_policy !== "never");
  const staleClaims = verifiable.filter((c) => isStale(c, now));
  const explicit = EXPLICIT_VERIFY.test(opts.message);

  let mode: TurnMode = "answer";
  if (claims.length > 0) {
    if (staleClaims.length > 0) mode = "verify";
    else if (explicit) mode = "verify";
    else mode = "recall";
  }

  const context = retrieveHistoryContext(opts.userId, opts.message, now);
  const contextBlock = formatContextForPrompt(context);
  const claimsBlock = formatClaimsForPrompt(claims, now);

  // Which claim the search is *about*. A stale claim always wins; otherwise
  // prefer one that can actually change (price/availability) over a fact that
  // never goes stale (release date), because "is that still true?" is almost
  // never asking us to re-confirm a release date.
  const target = staleClaims[0] ?? verifiable[0] ?? claims[0];
  const query = target ? searchQueryFor(target) : "";

  // Only pre-search when memory has nothing to say. If we hold a claim, VERIFY
  // already owns the query; if the topic is fresh, searching would be noise.
  const presearchQuery =
    claims.length === 0 && LIVE_INTENT.test(opts.message) && !GREETING_ONLY.test(opts.message)
      ? opts.message.trim().slice(0, 200)
      : "";

  return {
    mode,
    entities,
    claims,
    claimViews: claims.map((c) => toClaimView(c, now)),
    staleClaims,
    query,
    compare: mode === "verify" && context.matches.length > 0,
    context,
    contextBlock,
    claimsBlock,
    anchored,
    presearchQuery,
  };
}
