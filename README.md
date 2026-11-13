# Minimi

A chat agent with one tool — web search — and a durable, structured memory.
Ask it what you discussed last week, and whether any of it is still true.

Built for the Minimi hiring challenge. Architecture and trade-offs are in
[DESIGN.md](./DESIGN.md).

## Setup

```bash
npm install
cp .env.example .env    # fill in GEMINI_API_KEY and GROQ_API_KEY
npm run dev
```

Open http://localhost:3000.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | one of Gemini/Groq | primary model, the only one that can call tools |
| `GEMINI_MODEL` | no | defaults to `gemini-3.1-flash-lite` |
| `GEMINI_THINKING` | no | defaults to `minimal` (zero thought tokens; the planner does the routing) |
| `GEMINI_GROUNDING` | no | `1` adds Google's built-in search. Often quota-blocked on free-tier projects, and a blocked request fails wholesale — leave unset until you've confirmed it works for your key |
| `GROQ_API_KEY` | one of Gemini/Groq | text-only fallback and post-response claim extraction |
| `GROQ_MODEL` | no | defaults to `openai/gpt-oss-20b`; Groq rotates its free catalogue, so `GET /openai/v1/models` if it 404s |
| `WEB_SEARCH_API_KEY` | no | Exa key. Without it the agent still runs, it just says it can't search live |
| `WEB_SEARCH_PROVIDER` | no | `exa` (default) or `tavily`; both are implemented, the other is the fallback |
| `TAVILY_API_KEY` | no | second search provider |
| `DATABASE_URL` | no | defaults to `file:./data/minimi.db` |

`OPENROUTER_API_KEY` / `OPENROUTER_MODEL` are in `.env.example` for parity with the
spec but are not wired into the fallback chain — see DESIGN.md.

With no API key at all the app still runs; every turn returns a clear "all
providers failed" error instead of crashing.

## Seeded history

A memory agent is only testable if it has memory, so the first request from a new
browser seeds three dated conversations into **that browser's own tenant**:

- a Postgres hosting shortlist from last Tuesday, with price claims for Neon,
  Supabase and Railway;
- a five-tool CRM shortlist from Monday, with a seat price for each and two
  "shipped something" entries;
- a Notion AI pricing question from the 3rd of the month.

They are ordinary rows — same schema, same timestamps, same claims as a real turn.
Nothing is shared between browsers, nothing is faked at answer time, and
`GET /api/demo` restores them if you delete them.

Then try the questions the challenge lists:

```
Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?

On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them
changed pricing or shipped something big since?

What did I ask you on 3 November? Is your answer still correct today?
```

Each should answer the recall *and* check the live data, showing the claim, its
age and a citation. Typing them in a brand-new chat works too — memory is
per-tenant, not per-conversation.

## Identity

There is no sign-in. The first request mints a UUID in an httpOnly cookie
(`minimi_uid`, one year) and every row is scoped to it. Consequences worth
knowing:

- Same browser next week → same memory. Restarting the server changes nothing.
- Clearing cookies, another browser, or `127.0.0.1` instead of `localhost` →
  a new empty tenant (seeded again). There is no recovery path yet.
- Deleting `data/` deletes every conversation, claim and cache entry.

The DB runs in WAL mode, so a backup is `minimi.db` **plus** `minimi.db-wal` and
`minimi.db-shm` — copying only the first file gets you an empty database.
