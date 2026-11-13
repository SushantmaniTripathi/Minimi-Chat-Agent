import * as chrono from "chrono-node";
import { MessageRow, recentMessages, searchMessages } from "../db";

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","what","when","where","did","do","does",
  "i","you","my","me","on","in","at","of","to","for","about","it","that","this",
  "tell","again","please","previous","previously","last","time","ask","asked",
]);

function keywordQuery(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  // FTS5 wants OR-joined terms for a loose "any of these matter" match.
  return [...new Set(words)].slice(0, 8).join(" OR ");
}

export interface RetrievedContext {
  dateRangeMentioned: boolean;
  from?: string;
  to?: string;
  /** Nothing existed on the named day, so the newest turns were substituted. */
  fallback: boolean;
  matches: MessageRow[];
}

/**
 * Looks for an explicit date reference ("last Tuesday", "on 3 November") and/or
 * topical overlap with past turns. Returns at most a handful of past exchanges —
 * enough for the model to recall or compare against, not a context dump.
 */
export function retrieveHistoryContext(
  userId: string,
  userMessage: string,
  now = new Date()
): RetrievedContext {
  const parsed = chrono.parse(userMessage, now, { forwardDate: false });
  let from: string | undefined;
  let to: string | undefined;

  if (parsed.length > 0) {
    const r = parsed[0];
    const start = r.start?.date();
    const end = r.end?.date() ?? (start ? new Date(start) : undefined);
    if (start && end) {
      // "On Monday we shortlisted…" asked on a Friday means *this week's* Monday,
      // but chrono resolves a bare weekday forward to the next one and
      // forwardDate:false does not override that. Pull a future weekday back a
      // week; an explicit "next Monday" is left alone because it really is ahead.
      if (start.getTime() > now.getTime() && !/\bnext\b/i.test(r.text)) {
        start.setDate(start.getDate() - 7);
        end.setDate(end.getDate() - 7);
      }
      from = new Date(start.setHours(0, 0, 0, 0)).toISOString();
      to = new Date(end.setHours(23, 59, 59, 999)).toISOString();
    }
  }

  const q = keywordQuery(userMessage);
  // A named past day is a stronger filter than keywords. "What did I ask on 3
  // November?" shares almost no words with the answer it wants, and the reply
  // turn that actually holds the facts rarely echoes the question's phrasing —
  // searching text *and* date matched only the user's own line, which is why a
  // fresh chat could not find the subjects it was asking about. Date alone gets
  // the whole exchange. "today"/"now" are excluded: that is the live question,
  // not a recall one.
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const namedPastDay = from && new Date(from).getTime() < startOfToday;
  const matches = namedPastDay
    ? searchMessages({ userId, fromDate: from, toDate: to, limit: 8 })
    : searchMessages({ userId, query: q || undefined, fromDate: from, toDate: to, limit: 6 });

  // A named day we have nothing for is a dead end; silence looks like amnesia.
  // Say what we do have, and let the model be explicit about the substitution.
  if (matches.length === 0 && from) {
    return { dateRangeMentioned: true, from, to, fallback: true, matches: recentMessages(userId, 6) };
  }

  return { dateRangeMentioned: Boolean(from), from, to, fallback: false, matches };
}

export function formatContextForPrompt(ctx: RetrievedContext): string {
  if (ctx.matches.length === 0) return "";
  const lines = ctx.matches.map((m) => {
    const when = m.created_at;
    const who = m.role === "user" ? "User asked" : "You answered";
    const cites = m.citations ? ` [had ${JSON.parse(m.citations).length} source(s)]` : "";
    return `- (${when}) ${who}: ${m.content.slice(0, 300)}${cites}`;
  });
  const heading = ctx.fallback
    ? `Nothing was said on ${ctx.from?.slice(0, 10)}. These are the most recent turns instead — say plainly that the named date has no history:`
    : `Relevant prior conversation history (use this to answer "what did I ask" / recall / compare questions — do NOT claim to remember anything not listed here):`;
  return `${heading}\n${lines.join("\n")}`;
}
