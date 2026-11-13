export interface Citation {
  title: string;
  url: string;
  snippet?: string;
}

/** How the turn was planned. Mirrors lib/db.ts; kept here so client code never
 *  imports the SQLite module. */
export type TurnMode = "recall" | "verify" | "answer";

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

export interface ChatMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[] | null;
  modelUsed?: string | null;
  usedSearch?: boolean;
  mode?: TurnMode | null;
  claims?: ClaimView[];
  searching?: boolean;
  createdAt?: string;
  pending?: boolean; // still streaming
  errored?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
