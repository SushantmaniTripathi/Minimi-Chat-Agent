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
 * `then` carries "has anything changed since then?", which is the canonical
 * temporal follow-up and names nothing at all.
 */
const DANGLING_REFERENCE =
  /\b(that|this|it|those|these|they|them|its|their|the same|there|again|still true|still the case|then|back then|last time|earlier)\b/i;

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
  /**
   * One query per claim worth checking, so a turn about five shortlisted tools
   * verifies five, not the first one. `query` is always `queries[0]`.
   */
  queries: string[];
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

/**
 * Enough breadth for a shortlist: five tools with a price and a news line each is
 * seven claims, and a subject dropped by the cap is a subject the answer silently
 * omits. Beyond this it is noise and rate-limit risk.
 */
const MAX_VERIFY_QUERIES = 8;

function searchQueryFor(claim: ClaimRow, topic?: string): string {
  const name = claim.entity_name ?? "";
  const predicate = claim.predicate.replace(/_/g, " ");
  // Disambiguate against the conversation's subject: "Neon price" finds a crypto
  // token, "Neon price Postgres hosting providers" finds the database. News
  // queries are already specific, and a topic suffix makes them worse.
  const suffix = predicate === "price" || predicate === "availability" ? topic : undefined;
  return [name, predicate, suffix].filter(Boolean).join(" ").slice(0, 160);
}

/**
 * The claim names one entity; the conversation names the subject. Anchoring
 * usually returns only the most recent subject, so fall back to the opening turns,
 * where the topic is normally stated — that's the context the query is missing.
 */
function conversationTopic(
  userId: string,
  entities: EntityRow[],
  conversationId?: string
): string | undefined {
  const direct = entities.find((e) => e.kind === "topic");
  if (direct) return direct.canonical_name;
  if (!conversationId) return undefined;
  for (const m of getMessages(conversationId).slice(0, 3)) {
    const topic = resolveEntities(userId, m.content).find((e) => e.kind === "topic");
    if (topic) return topic.canonical_name;
  }
  return undefined;
}

/**
 * Subjects mentioned in retrieved history. This is what makes a *new* chat about
 * "last Tuesday" work at all: the current conversation contains no subject, but
 * the tenant's history does.
 */
function entitiesFromHistory(userId: string, matches: { content: string }[]): EntityRow[] {
  const seen = new Set<string>();
  const out: EntityRow[] = [];
  for (const m of matches) {
    for (const e of resolveEntities(userId, m.content)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

function mergeEntities(a: EntityRow[], b: EntityRow[]): EntityRow[] {
  const seen = new Set(a.map((e) => e.id));
  return [...a, ...b.filter((e) => !seen.has(e.id))];
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
  const context = retrieveHistoryContext(opts.userId, opts.message, now);

  // "Is that still true", "has any of them changed since" — cues that the subject
  // is not in this sentence.
  const cues = DANGLING_REFERENCE.test(opts.message) || EXPLICIT_VERIFY.test(opts.message);
  const claimsFor = (list: EntityRow[]) =>
    activeClaimsForEntities(
      opts.userId,
      list.map((e) => e.id)
    );

  let entities = resolveEntities(opts.userId, opts.message);
  let anchored = false;
  let claims = claimsFor(entities);

  // 1. Named nothing: inherit the subject of the current conversation.
  if (entities.length === 0 && opts.conversationId && cues) {
    const fromConversation = anchorEntities(opts.userId, opts.conversationId, opts.message);
    if (fromConversation.length > 0) {
      entities = fromConversation;
      anchored = true;
      claims = claimsFor(entities);
    }
  }

  // 2. Still no facts: take the subject from the tenant's history. A new chat
  //    asking "what did I ask on 3 November" has no local subject at all, and
  //    cross-conversation recall is the whole point of a memory ledger.
  if (claims.length === 0 && cues) {
    const fromHistory = entitiesFromHistory(opts.userId, context.matches);
    if (fromHistory.length > 0) {
      entities = mergeEntities(entities, fromHistory);
      anchored = true;
      claims = claimsFor(entities);
    }
  }

  const verifiable = claims.filter((c) => c.verify_policy !== "never");
  const staleClaims = verifiable.filter((c) => isStale(c, now));
  const explicit = EXPLICIT_VERIFY.test(opts.message);

  let mode: TurnMode = "answer";
  if (claims.length > 0) {
    if (staleClaims.length > 0) mode = "verify";
    else if (explicit) mode = "verify";
    else mode = "recall";
  }

  const contextBlock = formatContextForPrompt(context);
  const claimsBlock = formatClaimsForPrompt(claims, now);

  // Which claims the search is *about*. Stale ones always win; otherwise prefer
  // facts that can actually change (price/availability) over ones that never go
  // stale. One query per claim, capped: a five-tool shortlist verifies five.
  const targets = (
    staleClaims.length > 0 ? staleClaims : verifiable.length > 0 ? verifiable : claims
  ).slice(0, MAX_VERIFY_QUERIES);
  const topic = conversationTopic(opts.userId, entities, opts.conversationId);
  const queries = [...new Set(targets.map((c) => searchQueryFor(c, topic)).filter(Boolean))];
  const query = queries[0] ?? "";

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
    queries,
    compare: mode === "verify" && context.matches.length > 0,
    context,
    contextBlock,
    claimsBlock,
    anchored,
    presearchQuery,
  };
}
