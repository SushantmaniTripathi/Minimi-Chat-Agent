import { ChatMessage, Provider, ProviderError, ProviderResult } from "./types";

const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

async function* streamFromResponse(res: Response): AsyncGenerator<string, void, unknown> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const text = parsed?.choices?.[0]?.delta?.content ?? "";
        if (text) yield text;
      } catch {
        // partial chunk, wait for more
      }
    }
  }
}

export const groqProvider: Provider = {
  name: "groq",
  enabled: Boolean(API_KEY),
  async chat(messages: ChatMessage[]): Promise<ProviderResult> {
    if (!API_KEY) throw new ProviderError("GROQ_API_KEY not set", false);

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        temperature: 0.4,
      }),
    });

    if (!res.ok) {
      const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
      const body = await res.text().catch(() => "");
      throw new ProviderError(`Groq ${res.status}: ${body.slice(0, 300)}`, retryable, res.status);
    }

    return { stream: streamFromResponse(res), modelUsed: MODEL, providerName: "groq" };
  },
};
