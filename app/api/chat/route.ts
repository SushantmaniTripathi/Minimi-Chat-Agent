import { NextRequest } from "next/server";
import { after } from "next/server";
import { createConversation, getConversation, renameConversation } from "@/lib/db";
import { runAgent, lastAssistantMessageId } from "@/lib/agent/run";
import { extractClaims } from "@/lib/agent/extract";
import { resolveTenant, tenantCookie } from "@/lib/auth";

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? trimmed.slice(0, 57) + "..." : trimmed || "New chat";
}

export async function POST(req: NextRequest) {
  const { userId, isNew: isNewTenant } = resolveTenant(req);

  let body: { conversationId?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), { status: 400 });
  }

  // Ownership is part of the lookup: someone else's conversation id behaves
  // exactly like a nonexistent one (404 semantics, not 403).
  let conversationId = body.conversationId;
  if (!conversationId || !getConversation(conversationId, userId)) {
    conversationId = crypto.randomUUID();
    createConversation(conversationId, deriveTitle(message), userId);
  } else {
    const convo = getConversation(conversationId, userId)!;
    if (convo.title === "New chat") renameConversation(conversationId, deriveTitle(message));
  }

  let answer = "";
  let usedSearch = false;
  let sourceUrl: string | null = null;
  let anchoredEntities: string[] = [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(JSON.stringify({ type: "init", conversationId, isNew: true }) + "\n")
      );
      try {
        for await (const event of runAgent(conversationId!, message!, userId)) {
          if (event.type === "delta") answer += event.text;
          if (event.type === "meta") {
            usedSearch = event.usedSearch;
            sourceUrl = event.citations[0]?.url ?? null;
            // Cancelled on purpose: the planner's subjects are known before the
            // first byte, so a later empty meta must not erase them.
            if (event.entities?.length) anchoredEntities = event.entities;
          }
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }) + "\n"
          )
        );
        controller.enqueue(encoder.encode(JSON.stringify({ type: "done" }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  // Claim extraction runs after the response is flushed: zero perceived latency,
  // and its own provider quota so it can never slow down or block chat.
  after(async () => {
    if (!answer.trim()) return;
    const messageId = lastAssistantMessageId(conversationId!) ?? "";
    await extractClaims({
      userId,
      messageId,
      userMessage: message!,
      answer,
      usedSearch,
      sourceUrl,
      anchoredEntities,
    });
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Conversation-Id": conversationId,
  };
  if (isNewTenant) headers["Set-Cookie"] = tenantCookie(userId);

  return new Response(stream, { headers });
}
