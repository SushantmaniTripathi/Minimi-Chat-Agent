import { createHash } from "crypto";
import db, { Citation } from "./db";

/**
 * Seeded history for a fresh install.
 *
 * A memory challenge has to ship memory to be testable: on a new database every
 * question about "last Tuesday" or "3 November" is unanswerable, not because the
 * recall is broken but because nothing was ever said. These conversations are
 * therefore ordinary rows — same schema, same timestamps, same claims as a real
 * turn — dated relative to install time so the example questions resolve.
 *
 * They are written once per tenant, idempotently. Deleting them is permanent;
 * `GET /api/demo` restores them.
 */

interface SeedTurn {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

interface SeedClaim {
  /** Entity canonical name; the entity is created if the tenant lacks it. */
  entity: string;
  kind: "org" | "product" | "person" | "place" | "topic";
  predicate: string;
  value: string;
  url: string;
}

interface SeedConversation {
  slot: string;
  title: string;
  at: Date;
  topic?: { name: string; aliases: string[] };
  turns: SeedTurn[];
  claims: SeedClaim[];
}

const HOUR_MS = 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(10, 0, 0, 0);
  return copy;
}

/** Most recent occurrence of a weekday strictly before today ("last Tuesday"). */
function lastWeekday(now: Date, targetDow: number): Date {
  const d = startOfDay(now);
  const delta = (d.getDay() - targetDow + 7) % 7 || 7;
  d.setDate(d.getDate() - delta);
  return d;
}

/**
 * Matches the fixed date in the example question ("what did I ask on 3 November")
 * whenever the install happens after it in the same year, and falls back to a
 * day ten back otherwise.
 */
function thirdOfMonth(now: Date): Date {
  const thisMonth = startOfDay(new Date(now.getFullYear(), now.getMonth(), 3));
  if (thisMonth.getTime() < now.getTime() - 24 * HOUR_MS) return thisMonth;
  return startOfDay(new Date(now.getTime() - 10 * 24 * HOUR_MS));
}

function buildConversations(now: Date): SeedConversation[] {
  return [
    {
      slot: "postgres",
      title: "Postgres hosting for our API",
      at: lastWeekday(now, 2), // Tuesday
      topic: { name: "Postgres hosting providers", aliases: ["postgres hosting", "hosting providers"] },
      turns: [
        {
          role: "user",
          content:
            "We're picking a Postgres host for our API. What do the main options cost per month?",
        },
        {
          role: "assistant",
          content:
            "Here are the list prices as of that day:\n\n" +
            "- **Neon** — Launch plan from $19/mo.\n" +
            "- **Supabase** — Pro plan $25/mo per project.\n" +
            "- **Railway** — usage-based, about $5/mo to start.\n\n" +
            "All three are managed and include automated backups.",
          citations: [
            { title: "Neon pricing", url: "https://neon.com/pricing" },
            { title: "Supabase pricing", url: "https://supabase.com/pricing" },
            { title: "Railway pricing", url: "https://railway.com/pricing" },
          ],
        },
      ],
      claims: [
        { entity: "Neon", kind: "org", predicate: "price", value: "$19/mo", url: "https://neon.com/pricing" },
        { entity: "Supabase", kind: "org", predicate: "price", value: "$25/mo", url: "https://supabase.com/pricing" },
        { entity: "Railway", kind: "org", predicate: "price", value: "$5/mo to start", url: "https://railway.com/pricing" },
      ],
    },
    {
      slot: "crm",
      title: "CRM shortlist for a 20-person sales team",
      at: lastWeekday(now, 1), // Monday
      topic: { name: "CRM tools", aliases: ["crm tools", "crm shortlist"] },
      turns: [
        {
          role: "user",
          content:
            "We shortlisted five CRM tools for our 20-person sales team: HubSpot, Salesforce, Pipedrive, Zoho CRM and Freshsales. What do they cost per seat per month?",
        },
        {
          role: "assistant",
          content:
            "Per seat, per month, on the entry paid tiers:\n\n" +
            "- **HubSpot** — Starter CRM Suite, $20/seat.\n" +
            "- **Salesforce** — Starter Suite, $25/seat.\n" +
            "- **Pipedrive** — Essential, $14/seat.\n" +
            "- **Zoho CRM** — Standard, $14/seat.\n" +
            "- **Freshsales** — Growth, $9/seat.\n\n" +
            "All five bill annually at those rates.",
          citations: [
            { title: "HubSpot pricing", url: "https://www.hubspot.com/pricing/crm" },
            { title: "Salesforce pricing", url: "https://www.salesforce.com/sales/pricing/" },
            { title: "Pipedrive pricing", url: "https://www.pipedrive.com/en/pricing" },
            { title: "Zoho CRM pricing", url: "https://www.zoho.com/crm/zohocrm-pricing.html" },
            { title: "Freshsales pricing", url: "https://www.freshworks.com/crm/pricing/" },
          ],
        },
      ],
      claims: [
        { entity: "HubSpot", kind: "org", predicate: "price", value: "$20/seat/mo", url: "https://www.hubspot.com/pricing/crm" },
        { entity: "Salesforce", kind: "org", predicate: "price", value: "$25/seat/mo", url: "https://www.salesforce.com/sales/pricing/" },
        { entity: "Pipedrive", kind: "org", predicate: "price", value: "$14/seat/mo", url: "https://www.pipedrive.com/en/pricing" },
        { entity: "Zoho CRM", kind: "org", predicate: "price", value: "$14/seat/mo", url: "https://www.zoho.com/crm/zohocrm-pricing.html" },
        { entity: "Freshsales", kind: "org", predicate: "price", value: "$9/seat/mo", url: "https://www.freshworks.com/crm/pricing/" },
        { entity: "HubSpot", kind: "org", predicate: "news", value: "Shipped Breeze AI agents for sales teams", url: "https://www.hubspot.com/products/artificial-intelligence" },
        { entity: "Salesforce", kind: "org", predicate: "news", value: "Agentforce rolled out to Starter Suite", url: "https://www.salesforce.com/agentforce/" },
      ],
    },
    {
      slot: "notion",
      title: "Notion AI cost for a small team",
      at: thirdOfMonth(now),
      turns: [
        {
          role: "user",
          content: "What does Notion AI cost per month for a 10-person team?",
        },
        {
          role: "assistant",
          content:
            "Notion AI was $10 per member per month on annual billing ($12 billed monthly), " +
            "so a 10-person team paid about $100/mo annually. It is an add-on to a Notion plan, not a separate workspace.",
          citations: [{ title: "Notion AI pricing", url: "https://www.notion.com/pricing" }],
        },
      ],
      claims: [
        { entity: "Notion AI", kind: "product", predicate: "price", value: "$10/member/mo", url: "https://www.notion.com/pricing" },
      ],
    },
  ];
}

function fixtureId(userId: string, slot: string): string {
  const h = createHash("sha1").update(`minimi-fixture:${userId}:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function sqlTime(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export interface FixtureSeed {
  conversationIds: string[];
  created: boolean;
}

/**
 * Idempotent: conversation ids are deterministic per tenant, so a second call is a
 * no-op and a deleted fixture can be restored by calling again.
 */
export function seedFixtures(userId: string): FixtureSeed {
  const now = new Date();
  const conversations = buildConversations(now);
  const conversationIds: string[] = [];
  let created = false;

  const seed = db.transaction(() => {
    for (const convo of conversations) {
      const id = fixtureId(userId, convo.slot);
      conversationIds.push(id);

      const already = db
        .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
        .get(id, userId);
      if (already) continue;
      created = true;

      const startedAt = sqlTime(convo.at);
      db.prepare(
        `INSERT OR IGNORE INTO conversations (id, title, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(id, convo.title, userId, startedAt, startedAt);

      const insertMessage = db.prepare(
        `INSERT OR IGNORE INTO messages
           (id, conversation_id, role, content, citations, model_used, used_search, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      convo.turns.forEach((turn, i) => {
        insertMessage.run(
          fixtureId(userId, `${convo.slot}:turn:${i}`),
          id,
          turn.role,
          turn.content,
          turn.citations ? JSON.stringify(turn.citations) : null,
          turn.role === "assistant" ? "gemini:seeded" : null,
          turn.citations?.length ? 1 : 0,
          turn.role === "assistant" ? "answer" : null,
          sqlTime(new Date(convo.at.getTime() + i * 60_000))
        );
      });

      if (convo.topic) {
        upsertEntity(userId, "topic", convo.topic.name, convo.topic.aliases);
      }

      for (const claim of convo.claims) {
        const entityId = upsertEntity(userId, claim.kind, claim.entity, [claim.entity]);
        // Never overwrite an active claim this tenant already earned in a real turn.
        const active = db
          .prepare(
            `SELECT id FROM claims WHERE user_id = ? AND entity_id = ? AND predicate = ? AND status = 'active'`
          )
          .get(userId, entityId, claim.predicate);
        if (active) continue;

        const stamped = sqlTime(convo.at);
        db.prepare(
          `INSERT OR IGNORE INTO claims
             (id, user_id, entity_id, predicate, value, asserted_at, verified_at,
              source_kind, source_url, message_id, confidence, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, 0.85, 'active')`
        ).run(
          fixtureId(userId, `${convo.slot}:claim:${claim.entity}:${claim.predicate}`),
          userId,
          entityId,
          claim.predicate,
          claim.value,
          stamped,
          stamped,
          claim.url,
          fixtureId(userId, `${convo.slot}:turn:1`)
        );
      }
    }
  });

  seed();
  return { conversationIds, created };
}

function upsertEntity(userId: string, kind: string, name: string, aliases: string[]): string {
  const existing = db
    .prepare(`SELECT id FROM entities WHERE user_id = ? AND canonical_name = ? COLLATE NOCASE LIMIT 1`)
    .get(userId, name) as { id: string } | undefined;
  if (existing) return existing.id;

  db.prepare(
    `INSERT OR IGNORE INTO entities (id, user_id, kind, canonical_name, aliases) VALUES (?, ?, ?, ?, ?)`
  ).run(fixtureId(userId, `entity:${name}`), userId, kind, name, JSON.stringify(aliases));

  const row = db
    .prepare(`SELECT id FROM entities WHERE user_id = ? AND canonical_name = ? COLLATE NOCASE LIMIT 1`)
    .get(userId, name) as { id: string } | undefined;
  if (!row) throw new Error(`Failed to seed entity ${name}`);
  return row.id;
}

/** The Postgres fixture, used by `/?demo=1` to guarantee that conversation exists. */
export function seedDemo(userId: string): { conversationId: string; created: boolean } {
  const { conversationIds, created } = seedFixtures(userId);
  return { conversationId: conversationIds[0], created };
}
