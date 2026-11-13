"use client";

import { ConversationSummary } from "@/lib/types";

export default function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  open,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  open: boolean;
}) {
  return (
    <aside
      className={`${
        open ? "w-64" : "w-0"
      } shrink-0 overflow-hidden border-r border-[var(--hairline)] bg-[var(--background)] transition-[width] duration-150 flex flex-col`}
    >
      <div className="w-64 flex flex-col h-full">
        <div className="p-3">
          <button
            onClick={onNew}
            className="w-full text-left rounded-[6px] border border-[var(--hairline)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--ink)] hover:border-[var(--ink)] transition-colors"
          >
            + New chat
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3 flex flex-col gap-0.5">
          {conversations.length === 0 && (
            <p className="px-2 py-2 text-[12px] text-[var(--faint)]">No conversations yet</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 rounded-[6px] px-2 py-2 cursor-pointer text-[13px] ${
                c.id === activeId
                  ? "bg-[var(--hairline-soft)] text-[var(--ink)]"
                  : "text-[var(--body)] hover:bg-[var(--hairline-soft)]"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <span className="truncate flex-1">{c.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-[var(--faint)] hover:text-[var(--error)] text-[11px] px-1 transition-opacity"
                aria-label="Delete conversation"
              >
                ✕
              </button>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}
