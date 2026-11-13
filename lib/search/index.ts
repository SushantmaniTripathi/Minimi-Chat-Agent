import { Citation } from "../db";
import { ToolDecl } from "../providers/types";
import { getCachedSearch, putCachedSearch } from "./cache";
import { exaSearch, ProviderSearch } from "./exa";
import { tavilySearch } from "./tavily";

export const MAX_RESULTS = 5;

type ProviderName = "exa" | "tavily";

const PREFERRED: ProviderName = (process.env.WEB_SEARCH_PROVIDER as ProviderName) || "exa";

export interface SearchOutcome {
  ok: boolean;
  results: Citation[];
  reason?: string;
  cached: boolean;
  source: "cache" | ProviderName | "none";
  durationMs: number;
}

function providersInOrder(): Array<{ name: ProviderName; run: (q: string, n: number) => Promise<ProviderSearch> }> {
  const exa = { name: "exa" as const, run: exaSearch };
  const tavily = { name: "tavily" as const, run: tavilySearch };
  return PREFERRED === "tavily" ? [tavily, exa] : [exa, tavily];
}

export function searchConfigured(): boolean {
  return Boolean(process.env.WEB_SEARCH_API_KEY || process.env.EXA_API_KEY || process.env.TAVILY_API_KEY);
}

/**
 * One search entry point: cache, then providers in preference order. Never throws
 * and never blocks the turn on a missing key — a failed search is a fact the agent
 * can report, not an exception that kills the answer.
 */
export async function webSearch(opts: {
  userId: string;
  query: string;
  bypassCache?: boolean;
}): Promise<SearchOutcome> {
  const started = Date.now();
  const query = opts.query.trim();

  if (!query) {
    return { ok: false, results: [], reason: "Empty search query.", cached: false, source: "none", durationMs: 0 };
  }

  if (!opts.bypassCache) {
    for (const p of providersInOrder()) {
      const hit = getCachedSearch(opts.userId, query, p.name);
      if (hit) {
        return {
          ok: true,
          results: hit.citations,
          cached: true,
          source: "cache",
          durationMs: Date.now() - started,
        };
      }
    }
  }

  const failures: string[] = [];
  for (const p of providersInOrder()) {
    const res = await p.run(query, MAX_RESULTS);
    if (res.ok && res.results.length > 0) {
      putCachedSearch(opts.userId, query, p.name, res.results);
      return { ok: true, results: res.results, cached: false, source: p.name, durationMs: Date.now() - started };
    }
    failures.push(`${p.name}: ${res.reason ?? "no results"}`);
  }

  return {
    ok: false,
    results: [],
    reason: failures.join(" | ") || "No search provider configured.",
    cached: false,
    source: "none",
    durationMs: Date.now() - started,
  };
}

/** Tool declaration for the model-driven path (ANSWER mode). */
export const WEB_SEARCH_TOOL: ToolDecl & { type: "function" } = {
  // The Interactions API needs an explicit tool kind; a bare function schema is
  // rejected with "The 'type' parameter is required at 'tools[0]'".
  type: "function",
  name: "web_search",
  description:
    "Search the live web. Use this whenever the answer depends on current, external or checkable facts " +
    "(prices, availability, recent events, releases, statistics) rather than your own knowledge. " +
    "Returns numbered results to cite as [1], [2], ...",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A short, specific search query." },
    },
    required: ["query"],
  },
};

/**
 * Google's built-in grounding tool is OPT-IN. It is genuinely good, but on a free
 * tier it can be quota-blocked per project, and a request containing it fails
 * wholesale rather than just skipping the search. Off by default; set
 * GEMINI_GROUNDING=1 after confirming it works on your project.
 */
export function groundingTool(): Record<string, unknown> | null {
  return process.env.GEMINI_GROUNDING === "1" ? { type: "google_search" } : null;
}

export function formatForTool(citations: Citation[]): string {
  return citations
    .slice(0, MAX_RESULTS)
    .map((c, i) => `[${i + 1}] ${c.title} — ${c.url}\n${(c.snippet ?? "").slice(0, 300)}`)
    .join("\n\n");
}
