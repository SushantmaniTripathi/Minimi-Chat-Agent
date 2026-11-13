import db, { Citation } from "../db";

const VOLATILE_TTL_MS = 6 * 60 * 60 * 1000; // prices, news, "latest"
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // docs, releases, specs

const VOLATILE = /\b(price|pricing|cost|stock|news|today|right now|latest|current|now|release|available)\b/i;

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ttlFor(query: string): number {
  return VOLATILE.test(query) ? VOLATILE_TTL_MS : DEFAULT_TTL_MS;
}

function fetchFreshness(fetchedAt: string): number {
  return Date.now() - new Date(fetchedAt.includes("T") ? fetchedAt : fetchedAt.replace(" ", "T") + "Z").getTime();
}

export interface CachedSearch {
  citations: Citation[];
  fetchedAt: string;
}

export function getCachedSearch(userId: string, query: string, provider: string): CachedSearch | null {
  const row = db
    .prepare(
      `SELECT payload, fetched_at FROM search_cache
       WHERE user_id = ? AND query_norm = ? AND provider = ?`
    )
    .get(userId, normalizeQuery(query), provider) as { payload: string; fetched_at: string } | undefined;
  if (!row) return null;

  if (fetchFreshness(row.fetched_at) > ttlFor(query)) {
    db.prepare(`DELETE FROM search_cache WHERE user_id = ? AND query_norm = ? AND provider = ?`).run(
      userId,
      normalizeQuery(query),
      provider
    );
    return null;
  }
  try {
    return { citations: JSON.parse(row.payload) as Citation[], fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}

export function putCachedSearch(userId: string, query: string, provider: string, citations: Citation[]) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    `INSERT INTO search_cache (user_id, query_norm, provider, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, query_norm, provider)
     DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`
  ).run(userId, normalizeQuery(query), provider, JSON.stringify(citations), now);
}
