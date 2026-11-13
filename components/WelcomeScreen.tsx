const EXAMPLES = [
  "What's the latest version of Next.js?",
  "What did I ask you about last time?",
  "Explain how SQLite's WAL mode works",
  "Has anything changed since we last talked about this?",
];

export default function WelcomeScreen({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-[32px] font-semibold tracking-[-1.28px] text-[var(--ink)]">Minimi</h1>
      <p className="mt-2 text-[14px] text-[var(--body)] max-w-sm">
        Ask anything. I&apos;ll search the web when it actually matters, and I remember what we&apos;ve talked about.
      </p>
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md">
        {EXAMPLES.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="text-left text-[13px] leading-5 px-3.5 py-3 rounded-[12px] border border-[var(--hairline)] bg-[var(--surface)] text-[var(--body)] hover:border-[var(--ink)] hover:text-[var(--ink)] transition-colors"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
