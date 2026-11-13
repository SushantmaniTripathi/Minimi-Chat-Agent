import { Citation } from "../db";
import { ProviderSearch } from "./exa";

const API_KEY = process.env.TAVILY_API_KEY;

/**
 * Tavily adapter (1,000 free credits/month, no card). Included because Exa's
 * free credit is a one-off: when it runs out, verification should degrade to a
 * different free provider rather than to silence.
 */
export async function tavilySearch(query: string, numResults: number): Promise<ProviderSearch> {
  if (!API_KEY) return { ok: false, results: [], reason: "No Tavily API key configured." };

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: API_KEY,
        query,
        max_results: numResults,
        search_depth: "basic",
        include_answer: false,
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, results: [], reason: `Tavily ${res.status}: ${body.slice(0, 160)}` };
    }

    const data = await res.json();
    const results: Citation[] = (data.results ?? []).map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: (r.content || "").slice(0, 400),
    }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, results: [], reason: err instanceof Error ? err.message : String(err) };
  }
}
