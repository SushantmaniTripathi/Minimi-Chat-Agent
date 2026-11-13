"use client";

import { useRef, KeyboardEvent } from "react";

export default function Composer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSend();
    }
  }

  function autoResize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  return (
    <div className="border-t border-[var(--hairline)] bg-[var(--background)] px-4 py-3 md:px-6">
      <div className="max-w-2xl mx-auto flex items-end gap-2 rounded-[12px] border border-[var(--hairline)] bg-[var(--surface)] px-3 py-2 focus-within:border-[var(--ink)] transition-colors">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Message Minimi..."
          rows={1}
          className="flex-1 resize-none bg-transparent outline-none text-[14px] leading-5 py-1.5 max-h-[200px] text-[var(--ink)] placeholder:text-[var(--faint)]"
        />
        <button
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className="shrink-0 rounded-[6px] bg-white text-black text-[13px] font-medium px-3 py-1.5 disabled:opacity-35 disabled:cursor-not-allowed transition-opacity"
        >
          Send
        </button>
      </div>
      <p className="max-w-2xl mx-auto mt-1.5 text-[11px] text-[var(--faint)] px-1">
        Enter to send &middot; Shift+Enter for a new line
      </p>
    </div>
  );
}
