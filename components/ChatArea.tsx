"use client";

import { useEffect, useRef } from "react";
import { ChatMessageView } from "@/lib/types";
import Message from "./Message";
import WelcomeScreen from "./WelcomeScreen";

export default function ChatArea({
  messages,
  onPickExample,
}: {
  messages: ChatMessageView[];
  onPickExample: (text: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, messages[messages.length - 1]?.content]);

  if (messages.length === 0) {
    return <WelcomeScreen onPick={onPickExample} />;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto py-6 flex flex-col gap-4">
        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
