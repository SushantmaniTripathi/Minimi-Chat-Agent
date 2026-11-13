export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** JSON-schema-shaped declaration understood by Gemini's `function` tool. */
export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What a provider streams back: text for the user, or a request to run a tool. */
export type ToolEvent =
  | { kind: "text"; text: string }
  | { kind: "tool_call"; id: string; name: string; args: Record<string, unknown> };

export interface ToolResult {
  name: string;
  callId: string;
  text: string;
}

/**
 * A streaming run that can be resumed with tool results. `resume` is null when
 * the provider can't continue a turn (the Groq fallback), which caps the agent
 * loop at one model call for that path instead of silently re-prompting.
 */
export interface ToolRun {
  events: AsyncGenerator<ToolEvent, void, unknown>;
  modelUsed: string;
  providerName: string;
  resume: ((results: ToolResult[]) => Promise<ToolRun | null>) | null;
}

export interface ProviderResult {
  /** Async iterator of text deltas, for streaming straight to the client. */
  stream: AsyncGenerator<string, void, unknown>;
  modelUsed: string;
  providerName: string;
}

export class ProviderError extends Error {
  /** true = transient (rate limit/timeout/5xx) → caller should try next provider.
   *  false = our bug (bad request/auth/schema) → surface it, don't silently fail over. */
  constructor(message: string, public retryable: boolean, public status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface Provider {
  name: string;
  enabled: boolean;
  chat(messages: ChatMessage[]): Promise<ProviderResult>;
}

export interface ToolCapableProvider extends Provider {
  /** `unknown[]` because built-in tools (e.g. {type:"google_search"}) have a
   *  different shape from function declarations; the provider only serialises them. */
  runWithTools(opts: { messages: ChatMessage[]; tools: unknown[] }): Promise<ToolRun>;
}
