# Minimi

AI chat agent — one tool (web search), persistent SQLite memory, date-based
history recall, old-vs-current comparison, source citations. See
[DESIGN.md](./DESIGN.md) for architecture and [design-system.md](./design-system.md)
for the visual design reference this UI follows.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in at least GEMINI_API_KEY or GROQ_API_KEY
npm run dev
```

Open http://localhost:3000.

## Env vars

| Var | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | one of Gemini/Groq | primary provider |
| `GEMINI_MODEL` | no | defaults to `gemini-2.0-flash` |
| `GROQ_API_KEY` | one of Gemini/Groq | fallback provider |
| `GROQ_MODEL` | no | defaults to `llama-3.3-70b-versatile` |
| `WEB_SEARCH_API_KEY` | no | Exa key — without it the agent still runs, it just tells you it can't search live |
| `WEB_SEARCH_PROVIDER` | no | defaults to `exa`, only `exa` is implemented |
| `DATABASE_URL` | no | defaults to `file:./data/minimi.db` |

`OPENROUTER_API_KEY` / `OPENROUTER_MODEL` are in `.env.example` for parity
with the spec but not wired into the fallback chain yet — see DESIGN.md.

No API key configured at all → the app still runs; every chat turn returns
a clear "all providers failed" error instead of crashing.
