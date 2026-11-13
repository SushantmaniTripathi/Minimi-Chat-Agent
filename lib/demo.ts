import { createHash } from "crypto";
import db, { Citation } from "./db";

/**
 * A prepared conversation, materialised into the *visitor's own tenant* on demand.
 *
 * Nothing here runs unless someone opens `/?demo=1`. The app never invents history
 * for a visitor who just arrived, because that would be indistinguishable from
 * remembering something it was never told.
 *
 * The point of the seed is temporal: the prices are old enough to be past the 24h
 * freshness window, so a follow-up like "has any pricing changed since then?" has
 * a claim to check instead of nothing. Without claims, "verify" degrades into the
 * model's opinion, which is the one thing this architecture exists to avoid.
 */

const DEMO_TITLE = "Postgres hosting providers";

/** Comfortably past the 24h `price` TTL, so the seeded claims are stale on arrival. */
const SEED_AGE_DAYS = 9;

/**
 * Deterministic ids, scoped to the tenant. Seeding twice is a no-op, and deleting
 * the chat then reopening the link mints it again cleanly.
 */
function demoId(userId: string, slot: string): string {
  const h = createHash("sha1").update(`minimi-demo:${userId}:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function at(minutes: number): string {
  const base = Date.now() - SEED_AGE_DAYS * 24 * 60 * 60 * 1000 + minutes * 60 * 1000;
  return new Date(base).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * One tracked claim, not three. `VERIFY` searches the subject it can compare, so
 * seeding the whole shortlist makes the model answer about one provider and hedge
 * about the other two ("I have no fresh data for Railway"). The recommended option
 * is the one worth remembering, and it makes the demo's comparison unambiguous.
 */
const TRACKED = { name: "Neon", value: "$19/mo", num: 19, url: "https://neon.com/pricing" };

const TOPIC = "Postgres hosting providers";

const SEED_MESSAGES: {
  slot: string;
  role: "user" | "assistant";
  content: string;
  minutes: number;
  usedSearch?: boolean;
  citations?: Citation[];
}[] = [
  {
    slot: "m1",
    role: "user",
    minutes: 1,
    content:
      "Hey, we're looking at Postgres hosting providers for a small team. What do the main options cost per month?",
  },
  {
    slot: "m2",
    role: "assistant",
    minutes: 2,
    usedSearch: true,
    content:
      "Here's the shortlist, with list prices as of today:\n\n" +
      "- **Neon** — Launch plan from $19/mo.\n" +
      "- **Supabase** — Pro plan $25/mo per project.\n" +
      "- **Railway** — usage-based, about $5/mo to start.\n\n" +
      "All three are managed, include automated backups, and have a free tier while you're evaluating.",
    citations: [
      { title: "Neon pricing", url: "https://neon.com/pricing" },
      { title: "Supabase pricing", url: "https://supabase.com/pricing" },
      { title: "Railway pricing", url: "https://railway.com/pricing" },
    ],
  },
  {
    slot: "m3",
    role: "user",
    minutes: 3,
    content: "Which one would you pick for a 5-person team?",
  },
  {
    slot: "m4",
    role: "assistant",
    minutes: 4,
    content:
      "For five people I'd start with **Neon** at $19/mo — the cheapest predictable bill. " +
      "**Supabase** at $25/mo is worth the extra if you want auth, storage and dashboards from one vendor. " +
      "**Railway** only makes sense if your usage is spiky; the $5/mo is a floor, not a forecast.",
  },
];

export interface DemoSeed {
  conversationId: string;
  /** false when this tenant already had the demo, so reopening the link is safe. */
  created: boolean;
}

export function seedDemo(userId: string): DemoSeed {
  const conversationId = demoId(userId, "conversation");
  const existing = db
    .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
    .get(conversationId, userId);
  if (existing) return { conversationId, created: false };

  const seed = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO conversations (id, title, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(conversationId, DEMO_TITLE, userId, at(0), at(4));

    const insertMessage = db.prepare(
      `INSERT OR IGNORE INTO messages
         (id, conversation_id, role, content, citations, model_used, used_search, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const m of SEED_MESSAGES) {
      insertMessage.run(
        demoId(userId, m.slot),
        conversationId,
        m.role,
        m.content,
        m.citations ? JSON.stringify(m.citations) : null,
        m.role === "assistant" ? "gemini:seeded" : null,
        m.usedSearch ? 1 : 0,
        m.role === "assistant" ? "answer" : null,
        at(m.minutes)
      );
    }

    // The topic entity is what makes "since then" resolvable when the user names
    // the subject loosely; the tracked provider is what carries the price.
    upsertEntity(userId, "topic", TOPIC, [TOPIC, "postgres hosting", "hosting providers"]);
    const entityId = upsertEntity(userId, "org", TRACKED.name, [TRACKED.name]);

    // Never touch an active claim this tenant already earned in a real turn.
    const active = db
      .prepare(
        `SELECT id FROM claims WHERE user_id = ? AND entity_id = ? AND predicate = 'price' AND status = 'active'`
      )
      .get(userId, entityId);
    if (!active) {
      const stamped = at(2);
      db.prepare(
        `INSERT OR IGNORE INTO claims
           (id, user_id, entity_id, predicate, value, value_num, unit, asserted_at, verified_at,
            source_kind, source_url, message_id, confidence, status)
         VALUES (?, ?, ?, 'price', ?, ?, 'USD/month', ?, ?, 'web', ?, ?, 0.85, 'active')`
      ).run(
        demoId(userId, `claim:${TRACKED.name}`),
        userId,
        entityId,
        TRACKED.value,
        TRACKED.num,
        stamped,
        stamped,
        TRACKED.url,
        demoId(userId, "m2")
      );
    }
  });

  seed();
  return { conversationId, created: true };
}

function upsertEntity(userId: string, kind: string, name: string, aliases: string[]): string {
  const existing = db
    .prepare(`SELECT id FROM entities WHERE user_id = ? AND kind = ? AND canonical_name = ?`)
    .get(userId, kind, name) as { id: string } | undefined;
  if (existing) return existing.id;

  db.prepare(
    `INSERT OR IGNORE INTO entities (id, user_id, kind, canonical_name, aliases) VALUES (?, ?, ?, ?, ?)`
  ).run(demoId(userId, `entity:${kind}:${name}`), userId, kind, name, JSON.stringify(aliases));

  const row = db
    .prepare(`SELECT id FROM entities WHERE user_id = ? AND kind = ? AND canonical_name = ?`)
    .get(userId, kind, name) as { id: string } | undefined;
  if (!row) throw new Error(`Failed to seed entity ${name}`);
  return row.id;
}
