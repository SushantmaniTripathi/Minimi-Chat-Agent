import { geminiProvider } from "./gemini";
import { groqProvider } from "./groq";
import {
  ChatMessage,
  Provider,
  ProviderError,
  ProviderResult,
  ToolCapableProvider,
  ToolRun,
} from "./types";

const CHAIN: Provider[] = [geminiProvider, groqProvider];

/**
 * Tool calling is only wired for Gemini. Groq stays a text-only fallback rather
 * than pretending to support tools: a half-implemented tool loop in the fallback
 * path is a bug that only shows up during an outage.
 */
const TOOL_CHAIN: ToolCapableProvider[] = [geminiProvider];

export class AllProvidersFailedError extends Error {
  constructor(public attempts: { provider: string; error: string }[]) {
    super(`All providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`);
    this.name = "AllProvidersFailedError";
  }
}

/**
 * Tries each configured provider in order. Moves to the next provider ONLY on
 * a retryable failure (rate limit, timeout, 5xx) — a bad request or missing
 * key is our bug, not something a different provider fixes, so it surfaces.
 */
export async function chatWithFallback(
  messages: ChatMessage[],
  opts: { skip?: string[] } = {}
): Promise<ProviderResult> {
  const attempts: { provider: string; error: string }[] = [];
  const chain = CHAIN.filter((p) => !opts.skip?.includes(p.name));

  if (chain.every((p) => !p.enabled)) {
    throw new Error(
      "No model provider is configured. Set GEMINI_API_KEY and/or GROQ_API_KEY in your environment (see .env.example)."
    );
  }

  for (const provider of chain) {
    if (!provider.enabled) continue;
    try {
      return await provider.chat(messages);
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err), true);
      attempts.push({ provider: provider.name, error: e.message });
      if (!e.retryable) {
        // Application bug / bad request — don't mask it by silently trying the next provider.
        throw e;
      }
      // Otherwise fall through to the next provider. Logged because a silent
      // fallback makes a quality regression look like a normal answer.
      console.warn(`[providers] ${provider.name} failed, falling back: ${e.message}`);
    }
  }

  throw new AllProvidersFailedError(attempts);
}

/**
 * Tool-capable run. Returns null when no provider can do tools, so the caller
 * degrades to the plain fallback chain instead of failing the turn.
 */
export async function runWithTools(opts: {
  messages: ChatMessage[];
  tools: unknown[];
}): Promise<ToolRun | null> {
  const attempts: { provider: string; error: string }[] = [];

  for (const provider of TOOL_CHAIN) {
    if (!provider.enabled) continue;
    try {
      return await provider.runWithTools(opts);
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err), true);
      attempts.push({ provider: provider.name, error: e.message });
      if (!e.retryable) throw e;
      console.warn(`[providers] tool run failed on ${provider.name}: ${e.message}`);
    }
  }

  // Every tool-capable provider failed transiently; the caller falls back to text.
  return null;
}

export function configuredProviders(): string[] {
  return CHAIN.filter((p) => p.enabled).map((p) => p.name);
}
