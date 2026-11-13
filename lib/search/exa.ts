import { Citation } from "../db";

const API_KEY = process.env.WEB_SEARCH_API_KEY || process.env.EXA_API_KEY;

export interface ProviderSearch {
  ok: boolean;
  results: Citation[];
  reason?: string;
}

/**
 * Exa adapter. Returns ok:false instead of throwing on a missing key or a bad
 * response — the agent treats that as information for the user, not a crash.
 */
export async function exaSearch(query: string, numResults: number): Promise<ProviderSearch> {
  if (!API_KEY) return { ok: false, results: [], reason: "No Exa API key configured." };

  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        query,
        numResults,
        type: "auto",
        contents: { text: { maxCharacters: 800 }, highlights: true },
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, results: [], reason: `Exa ${res.status}: ${body.slice(0, 160)}` };
    }

    const data = await res.json();
    const results: Citation[] = (data.results ?? []).map((r: any) => ({
      title: r.title || r.url,
      url: r.url,
      snippet: (r.highlights?.[0] || r.text || "").slice(0, 400),
    }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, results: [], reason: err instanceof Error ? err.message : String(err) };
  }
}
