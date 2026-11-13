import { randomUUID } from "crypto";
import db, { ClaimRow, EntityRow } from "../db";

const HOUR_MS = 60 * 60 * 1000;

/** SQLite stores `datetime('now')` as "YYYY-MM-DD HH:MM:SS" in UTC. V8 would read
 *  that as local time, so normalise before it ever reaches staleness math. */
export function toDate(s: string): Date {
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

const DEFAULT_POLICY = { ttl_hours: 720, verify_policy: "on_stale" as const };

export interface ClaimView {
  entity: string;
  predicate: string;
  value: string;
  assertedAt: string;
  verifiedAt: string | null;
  ageHours: number;
  stale: boolean;
  source: "user" | "web" | "model_inference";
}

export function claimAgeHours(claim: ClaimRow, now: Date): number {
  const base = claim.verified_at ?? claim.asserted_at;
  return (now.getTime() - toDate(base).getTime()) / HOUR_MS;
}

/**
 * The whole "bridge" between memory and live data, as one pure predicate.
 * A claim is stale when it is older than the freshness window for its predicate —
 * which is data (freshness_policy), not a judgement call.
 */
export function isStale(claim: ClaimRow, now: Date): boolean {
  if (claim.verify_policy === "never") return false;
  if (claim.ttl_hours === null || claim.ttl_hours === undefined) return false;
  return claimAgeHours(claim, now) > claim.ttl_hours;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const selectEntities = db.prepare(`SELECT * FROM entities WHERE user_id = ?`);
const insertEntity = db.prepare(
  `INSERT OR IGNORE INTO entities (id, user_id, kind, canonical_name, aliases) VALUES (?, ?, ?, ?, ?)`
);
const selectEntityByName = db.prepare(
  `SELECT * FROM entities WHERE user_id = ? AND kind = ? AND canonical_name = ?`
);

export function upsertEntity(
  userId: string,
  kind: string,
  canonicalName: string,
  aliases: string[] = []
): EntityRow {
  const name = canonicalName.trim();
  // Identity is the name, not the kind. The extractor calls the same subject a
  // "product" in one turn and an "org" in the next; keying on (kind, name) then
  // splits one subject into two entity rows, each with its own active claim.
  const byName = db
    .prepare(`SELECT * FROM entities WHERE user_id = ? AND canonical_name = ? COLLATE NOCASE LIMIT 1`)
    .get(userId, name) as EntityRow | undefined;
  if (byName) {
    const merged = new Set<string>([...JSON.parse(byName.aliases ?? "[]"), ...aliases]);
    if (merged.size !== JSON.parse(byName.aliases ?? "[]").length) {
      db.prepare(`UPDATE entities SET aliases = ? WHERE id = ?`).run(JSON.stringify([...merged]), byName.id);
    }
    return { ...byName, aliases: JSON.stringify([...merged]) };
  }

  insertEntity.run(randomUUID(), userId, kind, name, JSON.stringify(aliases));
  const row = selectEntityByName.get(userId, kind, name) as EntityRow | undefined;
  if (row) {
    // Widen the alias set as new surface forms show up.
    const merged = new Set<string>([...JSON.parse(row.aliases ?? "[]"), ...aliases]);
    if (merged.size !== JSON.parse(row.aliases ?? "[]").length) {
      db.prepare(`UPDATE entities SET aliases = ? WHERE id = ?`).run(JSON.stringify([...merged]), row.id);
    }
    return { ...row, aliases: JSON.stringify([...merged]) };
  }
  // INSERT OR IGNORE can only fail on the UNIQUE constraint, so this is unreachable
  // unless the row was deleted between statements.
  throw new Error(`Failed to create entity ${name}`);
}

function aliasRegex(alias: string): RegExp {
  const escaped = alias
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

/**
 * Local, exact matching. Deliberately no fuzzy fallback: injecting the wrong past
 * claim, confidently, is worse than admitting we don't have it.
 */
export function resolveEntities(userId: string, text: string): EntityRow[] {
  const entities = selectEntities.all(userId) as EntityRow[];
  const haystack = text.toLowerCase();
  return entities.filter((e) => {
    const aliases = [e.canonical_name, ...(JSON.parse(e.aliases ?? "[]") as string[])];
    return aliases.some((a) => a.trim().length >= 3 && aliasRegex(a).test(haystack));
  });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export function activeClaimsForEntities(userId: string, entityIds: string[]): ClaimRow[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT c.*, e.canonical_name AS entity_name,
              f.ttl_hours AS ttl_hours, f.verify_policy AS verify_policy
       FROM claims c
       JOIN entities e ON e.id = c.entity_id
       LEFT JOIN freshness_policy f ON f.predicate = c.predicate
       WHERE c.user_id = ? AND c.status = 'active' AND c.entity_id IN (${placeholders})
       ORDER BY c.asserted_at DESC`
    )
    .all(userId, ...entityIds) as ClaimRow[];
}

export function activeClaimsForEntity(userId: string, entityId: string): ClaimRow[] {
  return activeClaimsForEntities(userId, [entityId]);
}

export function policyFor(predicate: string): { ttl_hours: number | null; verify_policy: string } {
  const row = db
    .prepare(`SELECT ttl_hours, verify_policy FROM freshness_policy WHERE predicate = ?`)
    .get(predicate) as { ttl_hours: number | null; verify_policy: string } | undefined;
  return row ?? DEFAULT_POLICY;
}

export interface RecordClaimInput {
  userId: string;
  entityId: string;
  predicate: string;
  value: string;
  sourceKind: "user" | "web" | "model_inference";
  sourceUrl?: string | null;
  messageId?: string | null;
  confidence?: number;
  /** true when this value came from a live source, so the freshness clock resets. */
  justVerified?: boolean;
  valueNum?: number | null;
  unit?: string | null;
}

export interface RecordClaimResult {
  claim: ClaimRow;
  superseded: ClaimRow | null;
}

function normValue(v: string) {
  return v.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * One active claim per (entity, predicate). A new value supersedes the old one
 * instead of overwriting it, which is what makes "it changed since 3 Nov"
 * answerable later.
 */
export function recordClaim(input: RecordClaimInput): RecordClaimResult {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const current = (
    db
      .prepare(
        `SELECT * FROM claims WHERE user_id = ? AND entity_id = ? AND predicate = ? AND status = 'active'
         ORDER BY asserted_at DESC LIMIT 1`
      )
      .get(input.userId, input.entityId, input.predicate) as ClaimRow | undefined
  ) ?? null;

  if (current && normValue(current.value) === normValue(input.value)) {
    db.prepare(
      `UPDATE claims
       SET verified_at = COALESCE(?, verified_at),
           confidence = MAX(confidence, ?)
       WHERE id = ?`
    ).run(input.justVerified ? now : null, input.confidence ?? current.confidence, current.id);
    const fresh = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(current.id) as ClaimRow;
    return { claim: fresh, superseded: null };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO claims
       (id, user_id, entity_id, predicate, value, value_num, unit, asserted_at, verified_at,
        source_kind, source_url, message_id, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.entityId,
    input.predicate,
    input.value,
    input.valueNum ?? null,
    input.unit ?? null,
    now,
    input.justVerified || input.sourceKind === "web" ? now : null,
    input.sourceKind,
    input.sourceUrl ?? null,
    input.messageId ?? null,
    input.confidence ?? (input.sourceKind === "web" ? 0.85 : 0.7)
  );

  if (current) {
    db.prepare(
      `UPDATE claims SET status = 'superseded', superseded_by = ?, superseded_at = ? WHERE id = ?`
    ).run(id, now, current.id);
  }

  const claim = db.prepare(`SELECT * FROM claims WHERE id = ?`).get(id) as ClaimRow;
  return { claim, superseded: current };
}

/** Refresh the freshness clock after a live check confirmed the stored value. */
export function markVerified(claimId: string, sourceUrl?: string | null) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    `UPDATE claims SET verified_at = ?, source_url = COALESCE(?, source_url) WHERE id = ?`
  ).run(now, sourceUrl ?? null, claimId);
}

export function toClaimView(claim: ClaimRow, now: Date): ClaimView {
  return {
    entity: claim.entity_name ?? "",
    predicate: claim.predicate,
    value: claim.value,
    assertedAt: claim.asserted_at,
    verifiedAt: claim.verified_at,
    ageHours: Math.round(claimAgeHours(claim, now)),
    stale: isStale(claim, now),
    source: claim.source_kind,
  };
}

function humanAge(hours: number): string {
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Three tight lines beat six truncated chat messages: fewer input tokens, lower
 * TTFT, and the model can see *when* each fact was true. The cap is generous
 * enough for a five-tool shortlist with price and news (seven claims), because a
 * claim that never reaches the prompt is a subject the answer silently omits.
 */
export function formatClaimsForPrompt(claims: ClaimRow[], now: Date): string {
  if (claims.length === 0) return "";
  const lines = claims.slice(0, 10).map((c) => {
    const age = humanAge(Math.round(claimAgeHours(c, now)));
    const gov =
      c.verify_policy === "never"
        ? c.source_kind === "user"
          ? "stated by the user — authoritative, never web-verify"
          : "does not go stale"
        : c.ttl_hours === null || c.ttl_hours === undefined
          ? "no freshness window"
          : isStale(c, now)
            ? `STALE — older than its ${c.ttl_hours}h freshness window`
            : `within its ${c.ttl_hours}h freshness window`;
    return `- ${c.entity_name} · ${c.predicate} = ${c.value} (${c.verified_at ? "verified" : "asserted"} ${age}; ${gov})`;
  });
  return `What you already know about these entities (this is your memory, not a guess):\n${lines.join("\n")}`;
}
