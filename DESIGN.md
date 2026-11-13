# DESIGN.md — Minimi

## How it works

Memory is a **claim ledger**, not a chat log. SQLite holds `entities` and
`claims(entity, predicate) = value`, each with `asserted_at`, `verified_at`,
`source_url`, `message_id` and `superseded_by`, plus a `freshness_policy` table
that stores TTLs as data (price 24 h, availability 12 h, news 48 h, ceo 30 d,
`release_date` never). A turn keeps the turns themselves only for rendering and
provenance. A new value supersedes the old rather than overwriting it, which is
what makes "it changed since then" answerable later.

One turn is: persist the user message → **plan locally** → search what the plan
says is stale, in parallel, before the model call → one streaming model call with
the evidence inlined → persist the answer → extract new claims in `after()` on
Groq, off the user's clock.

The planner is a pure function over local state (< 5 ms, no network, no model).
It resolves entities by exact alias match, adds the subject of the current
conversation for a dangling "that", and for a dated question retrieves by **date
rather than keywords** — "what did I ask on 3 November" shares almost no words
with the answer it wants, and the reply that holds the facts rarely echoes the
question. A bare weekday resolves forward in chrono, so a future weekday is pulled
back a week ("On Monday we shortlisted…" asked on Friday means this week's
Monday). The subjects of that day's turns then supply the claims, which is how a
brand-new chat can answer "last Tuesday we discussed Postgres".

Each stale claim becomes its own search query (cap 8; a five-tool shortlist with
prices and news is seven claims), all dispatched at once. Results are interleaved
two-per-query and grouped under the claim they were fetched for, so the first
query's five pages cannot crowd out the other four tools. Then mode is
`RECALL` (claims fresh, no search), `VERIFY` (a claim is past its window, or the
user asks "is that still true") or `ANSWER` (nothing stored; pre-search only when
the phrasing is inherently live). The model never decides *whether* a known-stale
fact needs checking; SQL already did.

A first visit seeds three dated conversations into that browser's own tenant, so
the example questions have something to recall on a fresh `npm install`. They are
ordinary rows — same schema, same timestamps, same claims as a real turn — and
`GET /api/demo` restores them. Without that, a memory challenge is untestable, not
memory-complete.

Measured on the three challenge questions, fresh install, free tier:

| Question | Plan | Result |
|---|---|---|
| Postgres, last Tuesday | `VERIFY`, 3 claims, 3 searches | 10.2 s TTFT, search 1.5 s |
| 5 CRM tools, Monday | `VERIFY`, 7 claims, 7 searches | 7.8 s TTFT, search 0.3 s |
| "What did I ask on 3 Nov?" | recall + 1 stale price re-check | answered with the original turn and a citation |

Planner < 5 ms; cold search 0.3–5.1 s; cache hit 1–2 ms; healthy TTFT 6–10 s;
worst observed 63 s when Gemini returned 503 and Groq finished the turn. Provider
variance is the dominant cost and cannot be designed away, only failed over.

## Why

**Messages can tell you what was said; only a ledger can tell you whether it is
still true.** Retrieval over chat text can answer "what did I ask", but it cannot
distinguish a price quoted in March from one quoted this morning, and it cannot
show why it believes either. A claim with a timestamp and a source can do both,
and staleness becomes a query instead of a judgement call.

**Routing in code, not in a second model.** The original design put a JSON router
in front of every turn — a whole round trip to decide something SQL decides for
verify and regexes decide for "look this up". Removing it also makes
`thinking_level: "minimal"` safe (measured 0 vs 173 thought tokens), worth 2–3× on
TTFT. Deterministic routing is also testable: the planner is a table of inputs and
modes.

**Search before the model, not through the tool.** A tool cycle on a free tier is
model → search → resume: 26–40 s measured versus 8–15 s for one grounded call. The
tool stays for what the heuristics miss.

**Exact matching over embeddings.** A wrong staleness predicate or a wrongly
attached claim, stated confidently, is worse than "I don't have that". Aliases are
auditable and free.

## Considered and rejected

- **Vector RAG over transcripts.** Good at topical similarity, bad at "as of when"
  and at showing provenance. Revisit only if fuzzy recall becomes a requirement.
- **LLM router / agent framework (LangChain et al.).** An extra round trip to
  reproduce a rule, plus a framework around one loop with one branch.
- **Always search.** Burns quota, adds seconds, and makes answers worse: a model
  that searched for something it already knew starts hedging.
- **Letting the model decide verification.** Non-deterministic re-checking of a
  known-stale claim is a correctness bug that looks like a personality trait.
- **Google `google_search` grounding as a dependency.** On this project's free tier
  it 429s the whole request, taking the turn down; kept opt-in behind
  `GEMINI_GROUNDING=1`.
- **`max_output_tokens`.** Counts thought tokens and truncated answers with
  `status: "incomplete"`; length is bounded by the prompt instead.
- **ORM, queue, worker.** Four tables and one process; `better-sqlite3` in WAL mode
  with prepared statements is enough.
- **Stateless tool calling.** Requires replaying thought signatures exactly — a
  correctness surface for a privacy property a single-user demo does not need.

Failure is treated as information, not an exception: a missing search key or 429
answers with "I couldn't confirm that just now"; a provider 503 falls over to Groq
once; a dead stream keeps the partial answer.

## With another week

- **Scheduled re-verification** of claims the user cares about, instead of only on
  demand, and a visible "last checked" per subject.
- **Corroboration, not just verification** — one source agreeing is not three, and
  the UI should say which it has.
- **Topic → conversation index.** Date-first recall works; "the Postgres thing"
  without a date still relies on alias matching.
- **Retention and privacy controls.** Tenants are cookie-scoped with no sign-in, so
  clearing cookies loses everything; that needs to be a stated choice, plus delete
  and export.
- **Planner tests as a table** (message, ledger state, expected mode) — the thing
  that makes deterministic routing worth having — and swapping Groq extraction for
  a local classifier once the predicate vocabulary settles.
