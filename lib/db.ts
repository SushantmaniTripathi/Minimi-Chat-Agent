import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { TurnMode } from "./types";

export type { TurnMode };

const DB_PATH = process.env.DATABASE_URL?.replace(/^file:/, "") || path.join(process.cwd(), "data", "minimi.db");

// Ensure the directory exists (fresh clone won't have data/ yet).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  -- JSON array of {title,url,snippet} — only present on assistant turns that searched.
  citations       TEXT,
  -- 'gemini:model' | null (user turns have no model).
  model_used      TEXT,
  -- true if this turn triggered a live web search (lets us distinguish
  -- "answered from memory/history" turns from "answered from fresh search" turns).
  used_search     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
-- Full text search over message content, so "what did I ask about pricing"
-- style recall doesn't require pulling every row into the model's context.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`);

/**
 * Column additions are done by hand rather than a migration framework: this DB
 * already has rows in it, and a two-line conditional is cheaper to read than a
 * migrations table for four columns.
 */
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// Tenant boundary. Existing rows are adopted by whoever opens the app first
// (see lib/auth.ts) so a pre-auth demo DB isn't orphaned.
ensureColumn("conversations", "user_id", "user_id TEXT NOT NULL DEFAULT 'local'");
// How the turn was planned: 'recall' | 'verify' | 'answer'. Lets history show
// "answered from memory" vs "verified just now" after a reload.
ensureColumn("messages", "mode", "mode TEXT");

db.exec(`
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);

-- ---------------------------------------------------------------------------
-- Product memory: entities and claims, not chat strings.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  kind           TEXT NOT NULL,              -- 'product' | 'org' | 'person' | 'place' | 'topic' | 'self'
  canonical_name TEXT NOT NULL,
  aliases        TEXT NOT NULL DEFAULT '[]', -- JSON array, matched locally (no embeddings)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, kind, canonical_name)
);
CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id);

CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,               -- 'price' | 'ceo' | 'release_date' | 'user_role' | ...
  value         TEXT NOT NULL,
  value_num     REAL,
  unit          TEXT,
  asserted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at   TEXT,                        -- last confirmed by live search; NULL = never
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('user','web','model_inference')),
  source_url    TEXT,
  message_id    TEXT,                        -- provenance: the exact turn that said it
  confidence    REAL NOT NULL DEFAULT 0.6,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','retracted')),
  superseded_by TEXT,
  superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_entity ON claims(user_id, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_verified ON claims(user_id, verified_at);

-- Freshness lives in data, not code: ttl_hours is what turns "is this stale?"
-- into a SQL predicate instead of a model opinion.
CREATE TABLE IF NOT EXISTS freshness_policy (
  predicate     TEXT PRIMARY KEY,
  ttl_hours     INTEGER,                     -- NULL = never goes stale
  verify_policy TEXT NOT NULL DEFAULT 'on_stale' CHECK (verify_policy IN ('always','on_stale','never'))
);
INSERT OR IGNORE INTO freshness_policy (predicate, ttl_hours, verify_policy) VALUES
  ('price',          24,    'on_stale'),
  ('availability',   12,    'on_stale'),
  ('version',        72,    'on_stale'),
  ('ceo',            720,   'on_stale'),
  ('address',        720,   'on_stale'),
  ('headcount',      720,   'on_stale'),
  ('user_role',      8760,  'never'),
  ('user_preference',NULL,  'never'),
  ('release_date',   NULL,  'never');

-- Search results are cached locally: repeat verification of the same claim is
-- free, and the cache doubles as "what I found last time" for comparisons.
CREATE TABLE IF NOT EXISTS search_cache (
  user_id    TEXT NOT NULL,
  query_norm TEXT NOT NULL,
  provider   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (user_id, query_norm, provider)
);

-- Per-turn latency, so "feels fast" is a measurement rather than a claim.
CREATE TABLE IF NOT EXISTS turn_metrics (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  mode            TEXT NOT NULL,
  ttft_ms         INTEGER,
  search_ms       INTEGER,
  tool_ms         INTEGER,
  total_ms        INTEGER,
  search_source   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export type Role = "user" | "assistant";

export interface Citation {
  title: string;
  url: string;
  snippet?: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  citations: string | null;
  model_used: string | null;
  used_search: number;
  mode: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface EntityRow {
  id: string;
  user_id: string;
  kind: string;
  canonical_name: string;
  aliases: string;
  created_at: string;
}

export interface ClaimRow {
  id: string;
  user_id: string;
  entity_id: string;
  predicate: string;
  value: string;
  value_num: number | null;
  unit: string | null;
  asserted_at: string;
  verified_at: string | null;
  source_kind: "user" | "web" | "model_inference";
  source_url: string | null;
  message_id: string | null;
  confidence: number;
  status: "active" | "superseded" | "retracted";
  superseded_by: string | null;
  superseded_at: string | null;
  // Joined from entities / freshness_policy.
  ttl_hours?: number | null;
  verify_policy?: "always" | "on_stale" | "never";
  entity_name?: string;
}

export function createConversation(id: string, title: string, userId: string): ConversationRow {
  db.prepare(`INSERT INTO conversations (id, title, user_id) VALUES (?, ?, ?)`).run(id, title, userId);
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow;
}

export function listConversations(userId: string): ConversationRow[] {
  return db
    .prepare(`SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as ConversationRow[];
}

/** Ownership-aware: a conversation id from another tenant must look nonexistent, not forbidden. */
export function getConversation(id: string, userId?: string): ConversationRow | undefined {
  if (userId === undefined) {
    return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  }
  return db
    .prepare(`SELECT * FROM conversations WHERE id = ? AND user_id = ?`)
    .get(id, userId) as ConversationRow | undefined;
}

export function touchConversation(id: string) {
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function renameConversation(id: string, title: string) {
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id);
}

export function deleteConversation(id: string, userId: string) {
  db.prepare(`DELETE FROM conversations WHERE id = ? AND user_id = ?`).run(id, userId);
}

/**
 * One-time adoption of a pre-auth database. Rows written before tenants existed
 * are owned by 'local'; the first browser to arrive takes ownership by having
 * them reassigned to its own id. Naturally idempotent: once reassigned there are
 * no 'local' rows left, so later visitors adopt nothing.
 */
export function adoptLegacyRows(userId: string): boolean {
  const conversations = db
    .prepare(`UPDATE conversations SET user_id = ? WHERE user_id = 'local'`)
    .run(userId);
  if (conversations.changes === 0) return false;
  db.prepare(`UPDATE entities SET user_id = ? WHERE user_id = 'local'`).run(userId);
  db.prepare(`UPDATE claims SET user_id = ? WHERE user_id = 'local'`).run(userId);
  db.prepare(`UPDATE search_cache SET user_id = ? WHERE user_id = 'local'`).run(userId);
  return true;
}

export function insertMessage(row: {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  citations?: Citation[] | null;
  model_used?: string | null;
  used_search?: boolean;
  mode?: TurnMode | null;
}) {
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, citations, model_used, used_search, mode)
     VALUES (@id, @conversation_id, @role, @content, @citations, @model_used, @used_search, @mode)`
  ).run({
    id: row.id,
    conversation_id: row.conversation_id,
    role: row.role,
    content: row.content,
    citations: row.citations ? JSON.stringify(row.citations) : null,
    model_used: row.model_used ?? null,
    used_search: row.used_search ? 1 : 0,
    mode: row.mode ?? null,
  });
  touchConversation(row.conversation_id);
}

export function getMessages(conversationId: string): MessageRow[] {
  return db
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId) as MessageRow[];
}

/** Full-text + date-range search inside ONE tenant — powers "what did I ask last Tuesday". */
export function searchMessages(opts: {
  userId: string;
  query?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}): MessageRow[] {
  const { userId, query, fromDate, toDate, limit = 20 } = opts;
  if (query && query.trim()) {
    return db
      .prepare(
        `SELECT m.* FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ? AND c.user_id = ?
         ${fromDate ? "AND m.created_at >= ?" : ""}
         ${toDate ? "AND m.created_at <= ?" : ""}
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(
        ...[query, userId, ...(fromDate ? [fromDate] : []), ...(toDate ? [toDate] : []), limit]
      ) as MessageRow[];
  }
  if (fromDate || toDate) {
    return db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = ?
         ${fromDate ? "AND m.created_at >= ?" : ""} ${toDate ? "AND m.created_at <= ?" : ""}
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(...[userId, ...(fromDate ? [fromDate] : []), ...(toDate ? [toDate] : []), limit]) as MessageRow[];
  }
  return [];
}

export function insertTurnMetric(row: {
  id: string;
  conversation_id: string;
  mode: string;
  ttft_ms?: number | null;
  search_ms?: number | null;
  tool_ms?: number | null;
  total_ms?: number | null;
  search_source?: string | null;
}) {
  db.prepare(
    `INSERT INTO turn_metrics (id, conversation_id, mode, ttft_ms, search_ms, tool_ms, total_ms, search_source)
     VALUES (@id, @conversation_id, @mode, @ttft_ms, @search_ms, @tool_ms, @total_ms, @search_source)`
  ).run({
    id: row.id,
    conversation_id: row.conversation_id,
    mode: row.mode,
    ttft_ms: row.ttft_ms ?? null,
    search_ms: row.search_ms ?? null,
    tool_ms: row.tool_ms ?? null,
    total_ms: row.total_ms ?? null,
    search_source: row.search_source ?? null,
  });
}

export default db;
