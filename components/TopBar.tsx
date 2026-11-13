"use client";

export default function TopBar({
  sidebarOpen,
  onToggleSidebar,
  title,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  title: string;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-[var(--hairline)] px-4 py-2.5 shrink-0">
      <button
        onClick={onToggleSidebar}
        aria-label="Toggle sidebar"
        className="w-7 h-7 flex items-center justify-center rounded-[6px] border border-[var(--hairline)] text-[var(--body)] hover:border-[var(--ink)] hover:text-[var(--ink)] transition-colors text-[13px]"
      >
        {sidebarOpen ? "⟨" : "⟩"}
      </button>
      <span className="text-[13px] font-medium text-[var(--ink)] truncate">{title}</span>
    </header>
  );
}
