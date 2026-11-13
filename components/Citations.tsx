import { Citation } from "@/lib/types";

export default function Citations({ citations }: { citations: Citation[] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="mt-3 pt-3 border-t border-[var(--hairline)]">
      <p className="text-[11px] font-mono uppercase tracking-wide text-[var(--mute)] mb-1.5">Sources</p>
      <ol className="space-y-1">
        {citations.map((c, i) => (
          <li key={c.url + i} className="text-[12px] leading-5 flex gap-1.5">
            <span className="text-[var(--faint)] shrink-0">[{i + 1}]</span>
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--link)] hover:underline truncate"
              title={c.url}
            >
              {c.title || c.url}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
