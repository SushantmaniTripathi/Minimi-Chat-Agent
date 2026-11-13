# DESIGN.md — Minimi

## The problem, stated properly

Three requirements pull against each other:

1. **Recall** — be accurate about what was said, and *when* it was said.
2. **Verification** — be current when "current" is what the question is about.
3. **Latency** — feel instant, on a free tier with no dedicated search budget.

The current build satisfies (1) weakly and (2) not at all: history is recalled as
raw message strings and search happens *before* the answer, decided by a separate
model call. That third thing is the expensive part — it puts a whole extra model
round trip in front of every turn, including the turns that don't need it.

The fix is not "add a tool". It's a change in what memory *is*.

## Core insight

> A message archive can tell you **what was said**. Only a claim ledger can tell
> you **whether it's still true**.

So memory splits into two layers with different owners:

| Layer | What it holds | Owner | Lifetime |
|---|---|---|---|
| **Model conversation state** | turns, tool calls, thought signatures | Gemini (`previous_interaction_id`) | one conversation |
| **Product memory** | entities, claims, citations, freshness | SQLite | forever |

SQLite is *not* the model's context window and should stop trying to be. It is the
system of record for **assertions**: `(entity, predicate) = value`, asserted at a
timestamp, from a named source, verified at a timestamp. The model conversation
is a rendering detail that Google already persists and can resume.

That split is what makes verification deterministic. A claim carries a TTL. When
`now - verified_at > ttl`, the claim is *known* stale — and a known-stale claim is
a **search trigger that doesn't require asking a model anything**. This is the
bridge between historical context and real-time data: it's a SQL predicate, not
a vibe in a prompt.

Why this matters more than it sounds: correctness must not depend on the model
choosing the tool on a given Tuesday. "Verify stale claims" is a rule; "decide
whether to search" is a coin flip with a system prompt. Rules go in code.

## Architecture

```
app/page.tsx                  client: NDJSON reader, now renders tool/verify status
app/api/chat/route.ts         POST — streams AgentEvent, owns `after()` for post-work

lib/agent/
  run.ts                      the loop: plan → one model call → tool cycle → persist
  plan.ts                     deterministic planner (RECALL | VERIFY | ANSWER), no model
  claims.ts                   entity resolution, freshness policy, claim upsert/supersede
  extract.ts                  claim extraction, post-response, gated, off the hot path
  retrieval.ts                chrono + FTS5 date/keyword recall (kept, narrowed)

lib/providers/
  gemini.ts                   Interactions API, SSE step events, tools, resume
  groq.ts                     text-only fallback used for failover and extraction
  types.ts                    ToolRun / ToolEvent / ProviderError contracts
  index.ts                    fallback chain; tool runs only where supported

lib/search/
  index.ts                    tool router: exa | tavily | none (+ opt-in google_search)
  cache.ts                    SQLite result cache, TTL by query class
  exa.ts, tavily.ts           provider adapters that never throw

lib/auth.ts                   tenant cookie + one-time legacy adoption
lib/db.ts                     + entities, claims, freshness_policy, search_cache, turn_metrics
```

Still one process, still no queue/worker, still no ORM, still no vector index.
The agent remains a plain async generator you can read top to bottom — there is
now one more branch in it (tool call) and one new thing outside it (`after()`).

## Turn lifecycle

Three modes, chosen by a **pure function** over local state. No network, no model,
`< 5 ms`.

| Mode | Trigger | Search |
|---|---|---|
| `RECALL` | message resolves to an entity/claim, all active claims fresh | never |
| `VERIFY` | a resolved claim is past its freshness window, or the user asks "is that still true?" | always, pre-dispatched |
| `ANSWER` | no claim involvement | presearch if the intent is inherently live, else the model's choice via tool |

```
onMessage(msg):
  persistUserMessage(msg)                        // 1 ms, survives a failed turn
  ctx = localContext(msg)                        // 3 ms: FTS5 + chrono + entity resolve

  plan = planTurn(msg, ctx)                      // pure, no model
  // RECALL   → inject tight claim lines
  // VERIFY   → searchP = webSearch(entity, predicate)   ← starts now
  // ANSWER   → searchP = webSearch(msg) when LIVE_INTENT matches
  //            (price/current/latest/release/…), else no search

  evidence = searchP ? await race(searchP, 5s) : null
  // Resolved in time → evidence goes straight into the prompt. No tool call.
  // Still running     → tool offered; executor is served from the same promise.

  stream = gemini.interactions.create({
    model, stream: true,
    input: compose(plan, ctx, evidence),
    tools: evidence ? [] : [WEB_SEARCH_FN],
    generation_config: { thinking_level: "minimal" },
  })

  for await (e of stream):
    text          → yield to client
    function_call → result = await (searchP ?? webSearch(args.query))
                    resume(previous_interaction_id, function_result)  // ≤ 1 cycle

  persistAssistantMessage(text, citations, model)
  after(() => extractClaims(...))                // zero perceived latency
```

Three things worth calling out.

**Every mode that needs live data starts the search before the model.** The old
design had `ANSWER` let the model decide, which costs a whole extra round trip
(model asks → we search → model resumes). On a free tier that round trip is
10–25 s. So the planner now recognises inherently-live phrasing (`price`,
`current`, `latest`, `release`, `ceo`, …) and pre-dispatches the search itself.
The model still keeps the tool for anything the heuristics miss.

**Waiting beats tooling.** For both `VERIFY` and presearch we wait up to 5 s for
the search and inject the results. A search lands in 1–3 s (0 ms on a cache hit),
so the common turn is *one* model call with evidence in hand. The tool path
remains as the fallback for a slow search, not the default.

**One tool cycle, hard cap.** A second cycle means re-running the prompt and
paying TTFT again; on a free tier that's the difference between "feels fine" and
"feels broken". If the model wants a third search, we answer with what we have
and say so.

**`google_search` is opt-in, and currently off.** Verified against the live API:
on this project's free tier a request containing `google_search` fails wholesale
with a 429 quota error — it takes the whole turn down, not just the search. So
the function tool (Exa/Tavily, which we control and can cache) is the workhorse,
and grounding is enabled only with `GEMINI_GROUNDING=1` once a project is known
to support it.

**Dangling references are anchored locally.** "is that still true?" names no
entity. Resolving it against the message alone would produce an empty memory
block — the exact case the ledger exists for. If the message carries a pronoun
and resolves nothing, the planner walks back over the last four turns and adopts
the most recent topic, then tells the model what "that" refers to. Deterministic,
no embeddings.


## Claim ledger

```sql
entities(
  id, kind, canonical_name, aliases JSON           -- local alias matching, no embeddings
)

claims(
  id, entity_id, predicate,                        -- 'price' | 'ceo' | 'release_date' | 'user_role'
  value, value_num, unit,
  asserted_at,                                     -- when the turn happened
  source_kind,                                     -- 'user' | 'web' | 'model_inference'
  source_url, message_id,                          -- provenance back to the exact turn
  verified_at,                                     -- last confirmed against the web
  confidence,
  status,                                          -- 'active' | 'superseded' | 'retracted'
  superseded_by, superseded_at
)

freshness_policy(
  predicate PRIMARY KEY,
  ttl_hours,                                       -- price 24, ceo 720, immutable NULL
  verify_policy                                    -- 'always' | 'on_stale' | 'never'
)

search_cache(query_norm, provider, day_bucket, payload, fetched_at)
```

Freshness TTLs are the whole point, so they're data, not code:

| predicate | ttl | why |
|---|---|---|
| `price`, `availability`, `version` | 24 h | changes weekly at best |
| `ceo`, `user_role`, `address` | 30 d | changes quarterly |
| `release_date` (past) | ∞ | fixed once it happened |
| `user_preference` | ∞ | the user is the source of truth; never web-verify |

`source_kind = 'user'` claims are never web-verified. When the user says "my
budget is $50", searching the web for it is not just wasteful, it's wrong.

**Extraction is gated and asynchronous.** It runs in `after()` on Groq's small
model, and only when a turn is plausible evidence: `used_search = 1`, or the text
contains a number/currency/date/version pattern, or the user made a first-person
statement. That gate keeps it to roughly a third of turns, which is the difference
between a free-tier app and a 429 page.

**Entity resolution is local and exact.** Alias dictionary → lowercase n-gram scan.
If nothing matches exactly, no claims are injected and the model answers normally.
A wrong past claim, confidently restated, is worse than "I don't have that".

## What the user actually sees

The bridge, made visible:

> On 3 Nov I told you the Pro plan was $20/mo [1]. That's 9 days old and pricing
> moves fast, so I checked just now: it's $24/mo [2].

That sentence is only possible because `asserted_at`, `verified_at`, `superseded_by`,
and two citation sets all exist as columns. `VERIFY` returns this shape; the UI
renders the lossy parts (old value struck through, new value, "verified 2 min ago").
That is the demo. It is also the thing a reviewer checks by asking the same
question twice, a week apart.

## Latency

Target: **one model round trip per turn, and never a round trip spent deciding
whether to search.** Measured on this project's free tier, not modelled — the
public numbers below come from `turn_metrics` rows.

| Leg | Measured |
|---|---|
| Local retrieval + staleness + entity resolve | 1–5 ms |
| Search, cache hit | 1–2 ms |
| Search, cold (Exa) | 1.4–2.7 s |
| Model TTFT, `gemini-3.1-flash-lite`, thinking `minimal` | 4–8 s warm, bursts to 25 s |
| Model TTFT, `gemini-3.5-flash-lite`, thinking `low` | 14–26 s |
| Full grounded answer, one model call | 8–15 s |
| Same turn via the tool path (decide → search → resume) | 26–40 s |

Free-tier Gemini latency is the dominant term and it is **not stable** — the same
prompt measured 4.4 s and 25.9 s minutes apart. The design can remove round trips
and thinking tokens; it cannot remove provider variance.

Decisions that actually moved the number, in order of payoff:

1. **`thinking_level: "minimal"`.** Measured 0 thought tokens vs 173 on `low` for
   the same prompt. The deterministic planner is what makes this safe: the model
   no longer has to reason about routing. This was worth roughly 2–3× on TTFT.
2. **No separate routing call.** Removed outright, not optimised.
3. **Pre-dispatched search, injected rather than tooled.** Turns the common
   live-data turn from two model calls into one. On a free tier that is 10–25 s.
4. **`previous_interaction_id` on the tool continuation.** Measured 89 input
   tokens for the resume leg — no context re-upload.
5. **Prompt diet.** Three claim lines replace six truncated message dumps. Fewer
   input tokens, lower TTFT.
6. **Warm DB.** `better-sqlite3` in-process, WAL, prepared statements cached at
   module scope.
7. **Cold start is the real tail in production.** On Cloud Run with
   `min-instances=0`, 1–3 s dwarfs all of the above.

Explicitly **not** doing: `max_output_tokens`. Measured — it counts thought
tokens and produced `status: "incomplete"` with the answer truncated. Length is
bounded by the prompt instead.

`turn_metrics(ttft_ms, search_ms, tool_ms, total_ms, search_source, mode)` is
written on every turn. Without it, all of the above is opinion.


## Free-tier budget

Exact limits are per project and live in AI Studio — don't hardcode them. Design
against the *shape*: single-digit RPM, low-hundreds RPD, and a hard daily reset.

At 50 turns/day (~1,500/mo):

| Resource | Volume | Notes |
|---|---|---|
| Gemini calls | ~1,500/mo + ~300 tool continuations | 1 per turn; presearch keeps it at 1 |
| Search | ~300–600/mo | mostly cached; Exa free credit is a one-off, Tavily is the fallback |
| Groq extraction | ~450/mo | separate quota, so it can't starve chat |

The binding constraint is **RPM during a burst**, not monthly volume. Mitigations
already in the design: search cache, one tool cycle, gated extraction, and
degrading to an honest "I couldn't verify this just now" instead of retrying.

Two hard rules that follow:
- **Never fail over to a paid path.** Free tier is a constraint, not a phase.
- **Never block the answer on a quota error.** A missing search key or a 429 is
  information for the user, not an exception for the client.

## Failure modes and what each one does

| Failure | Behaviour |
|---|---|
| Search key absent / 429 | Answer without it, say it's unverified. Never throw. |
| Search times out (6 s per provider) | Same path; claim stays `active`, not `verified`. |
| Provider dies before any text | Re-ask the text-only provider (Groq) once; the turn still answers. |
| Provider dies mid-stream | Keep and persist the partial answer. A stream can't be replayed. |
| Provider stalls past 60 s | Abort, then the same one-shot failover as above. |
| Tool returns junk JSON | Skip injection, record the failure in `turn_metrics`. |
| Extractor names an entity the user never mentioned | Dropped before it reaches the ledger (precision over recall). |
| Entity resolves ambiguously | Inject nothing. Silence beats a wrong memory. |
| Grounding unavailable on free tier | `google_search` is opt-in and off; the function tool carries the load. |

Also worth stating plainly: **free-tier prompts may be used to improve the
product.** If a conversation contains personal or health information, that's a
terms issue, not a latency issue, and it should be a deliberate choice rather
than something discovered in review.

## Decisions considered and rejected

- **LangChain / an agent framework.** Still rejected, still for the same reason:
  one loop, one branch. The branch is now a tool call instead of an `if`.
- **Vector embeddings for memory.** Still rejected. Entities + predicates beat
  cosine similarity for "what was the price I was quoted", and they're auditable
  and free. Revisit only if fuzzy topical recall becomes a requirement.
- **Keeping the JSON router as the primary path.** Rejected. It is a second model
  call to decide something SQL can decide for `VERIFY`, and heuristics decide for
  `ANSWER`. Kept as an offline eval target, not a runtime dependency.
- **Stateless tool calling (`store: false`).** Rejected. It requires replaying
  thought steps and signatures *exactly* on every continuation — a large correctness
  surface for a privacy property we don't need on a single-user demo.
- **Always search.** Rejected. Burns quota, adds latency, and paradoxically makes
  answers worse: a model that searched for something it already knew starts hedging.
- **Letting the model decide when to verify.** Rejected for `VERIFY` specifically.
  Non-deterministic verification of a known-stale claim is a correctness bug that
  looks like a personality trait.
- **Relying on `google_search` grounding.** Rejected as a dependency after measuring
  it: on a free-tier project the request 429s wholesale, so one unavailable tool
  would take out every turn. Kept as an opt-in extra.
- **ORM (Prisma/Drizzle).** Still rejected. Four tables, one join.

## As built

All four phases are implemented and running. Where each piece lives:

| Concern | File |
|---|---|
| Schema, migrations, every query | `lib/db.ts` |
| Tenant identity + first-visit adoption | `lib/auth.ts` |
| Deterministic planner (`RECALL`/`VERIFY`/`ANSWER`, anchoring, presearch) | `lib/agent/plan.ts` |
| Entities, freshness predicate, claim supersede | `lib/agent/claims.ts` |
| History/FTS retrieval + date parsing | `lib/agent/retrieval.ts` |
| Orchestrator: search overlap, tool loop, metrics | `lib/agent/run.ts` |
| Post-response extraction (Groq) | `lib/agent/extract.ts` |
| Search router + cache + tool declaration | `lib/search/*` |
| Gemini Interactions streaming + resume | `lib/providers/gemini.ts` |
| Fallback chain and failover | `lib/providers/index.ts` |
| Streaming route + `after()` extraction | `app/api/chat/route.ts` |
| Memory chips / mode footer | `components/Message.tsx` |

Three maintenance notes:

- **`local` is a migration marker, not a tenant.** Before tenants existed, every
  browser was handed the literal cookie value `local`. When `lib/auth.ts` sees it,
  it mints a real id and calls `adoptLegacyRows` *once*, then the browser holds a
  UUID forever. A first-time visitor with no cookie must never adopt anything: doing
  so let any new arrival reassign another browser's conversations, which surfaced as
  every old chat returning 404. Both list/detail responses also send
  `Cache-Control: no-store`, because a cached tenant-scoped list is the same bug in
  a different disguise.
- **Groq rotates its free catalogue.** `llama-3.3-70b-versatile` was gone by the
  time this was built; `openai/gpt-oss-20b` is the current default. If extraction
  silently stops, check `GET https://api.groq.com/openai/v1/models` first.
- `scripts/inspect-db.cjs` dumps the ledger, metrics and cache;
  `scripts/backdate-claim.cjs 48` ages a claim so the `VERIFY` path can be
  exercised without waiting two days.

## With another week

- Follow-up verification: re-check a claim on a schedule the user set, not just on demand.
- Multi-claim turns (`VERIFY` two entities in one answer) with parallel searches —
  the cache makes this cheap.
- Server-side `store: false` if a privacy requirement ever appears; the ledger
  doesn't depend on it.
- Swap Groq extraction for a local classifier once the predicate vocabulary settles.
- Distinguish `verified` from `corroborated`: one source is not the same as three.
