"use client";

import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import ChatArea from "@/components/ChatArea";
import Composer from "@/components/Composer";
import { ChatMessageView, Citation, ConversationSummary } from "@/lib/types";

export default function Home() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const refreshConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(data.conversations ?? []);
  }, []);

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  async function loadConversation(id: string) {
    setActiveId(id);
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setMessages(
      (data.messages ?? []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations,
        modelUsed: m.model_used,
        usedSearch: Boolean(m.used_search),
        mode: m.mode ?? null,
        createdAt: m.created_at,
      }))
    );
  }

  function startNewChat() {
    setActiveId(null);
    setMessages([]);
    setInput("");
  }

  async function sendMessage(text: string) {
    const userMsg: ChatMessageView = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantId = crypto.randomUUID();
    const assistantMsg: ChatMessageView = { id: assistantId, role: "assistant", content: "", pending: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, message: text }),
      });

      if (!res.body) throw new Error("No response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "init") {
            if (event.conversationId && event.conversationId !== activeId) {
              setActiveId(event.conversationId);
            }
          } else if (event.type === "meta") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      citations: event.citations as Citation[],
                      modelUsed: event.model,
                      usedSearch: event.usedSearch,
                      mode: event.mode,
                      claims: event.claims,
                    }
                  : m
              )
            );
          } else if (event.type === "status") {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, searching: true } : m))
            );
          } else if (event.type === "delta") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + event.text, searching: false } : m
              )
            );
          } else if (event.type === "error") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: event.message, errored: true, pending: false, searching: false }
                  : m
              )
            );
          } else if (event.type === "done") {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, pending: false, searching: false } : m))
            );
          }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: err instanceof Error ? err.message : "Network error", errored: true, pending: false }
            : m
        )
      );
    } finally {
      setSending(false);
      refreshConversations();
    }
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (activeId === id) startNewChat();
    refreshConversations();
  }

  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? "New chat";

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={loadConversation}
        onNew={startNewChat}
        onDelete={deleteConversation}
        open={sidebarOpen}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((o) => !o)} title={activeTitle} />
        <ChatArea messages={messages} onPickExample={(text) => sendMessage(text)} />
        <Composer value={input} onChange={setInput} onSend={() => input.trim() && sendMessage(input.trim())} disabled={sending} />
      </div>
    </div>
  );
}
