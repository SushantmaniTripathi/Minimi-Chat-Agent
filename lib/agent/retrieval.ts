import * as chrono from "chrono-node";
import { MessageRow, searchMessages } from "../db";

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
    const end = r.end?.date() ?? start;
    if (start) {
      from = new Date(start.setHours(0, 0, 0, 0)).toISOString();
      to = new Date((end ?? start).setHours(23, 59, 59, 999)).toISOString();
    }
  }

  const q = keywordQuery(userMessage);
  const matches = searchMessages({ userId, query: q || undefined, fromDate: from, toDate: to, limit: 6 });

  return { dateRangeMentioned: Boolean(from), from, to, matches };
}

export function formatContextForPrompt(ctx: RetrievedContext): string {
  if (ctx.matches.length === 0) return "";
  const lines = ctx.matches.map((m) => {
    const when = m.created_at;
    const who = m.role === "user" ? "User asked" : "You answered";
    const cites = m.citations ? ` [had ${JSON.parse(m.citations).length} source(s)]` : "";
    return `- (${when}) ${who}: ${m.content.slice(0, 300)}${cites}`;
  });
  return `Relevant prior conversation history (use this to answer "what did I ask" / recall / compare questions — do NOT claim to remember anything not listed here):\n${lines.join("\n")}`;
}
