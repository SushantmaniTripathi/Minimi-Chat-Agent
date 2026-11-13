import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatMessageView, ClaimView } from "@/lib/types";
import Citations from "./Citations";

export default function Message({ message }: { message: ChatMessageView }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end px-4 md:px-0">
        <div className="max-w-[80%] rounded-[12px] bg-[var(--ink)] text-[var(--user-message-text)] px-4 py-2.5 text-[14px] leading-5 whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start px-4 md:px-0">
      <div className="max-w-[86%] w-full">
        <div className="rounded-[12px] border border-[var(--hairline)] bg-[var(--surface)] px-4 py-3">
          {message.errored ? (
            <p className="text-[13px] text-[var(--error)]">{message.content || "Something went wrong."}</p>
          ) : (
            <div className="markdown-body text-[14px] leading-6 text-[var(--ink)]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || ""}</ReactMarkdown>
              {message.pending && message.content.length === 0 && (
                <span className="inline-flex gap-1 items-center text-[var(--faint)]">
                  {message.searching ? (
                    <span className="text-[12px] font-mono">checking live sources</span>
                  ) : null}
                  <Dot delay="0ms" /> <Dot delay="150ms" /> <Dot delay="300ms" />
                </span>
              )}
            </div>
          )}
          {!message.errored && message.claims && message.claims.length > 0 && (
            <MemoryChips claims={message.claims} mode={message.mode ?? null} />
          )}
          {!message.errored && message.citations && <Citations citations={message.citations} />}
        </div>
        {!message.errored && (
          <div className="mt-1 px-1 flex gap-2 text-[11px] font-mono text-[var(--faint)]">
            {message.mode === "recall" && <span>from memory</span>}
            {message.mode === "verify" && <span>{message.usedSearch ? "checked live" : "couldn't verify"}</span>}
            {message.usedSearch && message.mode !== "verify" && <span>searched web</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The visible half of the bridge: which stored claims this turn actually used,
 * and whether each one was inside its freshness window when it was used.
 */
function MemoryChips({ claims, mode }: { claims: ClaimView[]; mode: string | null }) {
  if (mode !== "recall" && mode !== "verify") return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {claims.slice(0, 3).map((c, i) => (
        <span
          key={`${c.entity}-${c.predicate}-${i}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--hairline)] px-2 py-0.5 text-[10px] font-mono text-[var(--mute)]"
          title={`${c.entity} · ${c.predicate} = ${c.value} — ${c.stale ? "stale" : "fresh"}`}
        >
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: c.stale ? "var(--error)" : "var(--faint)" }}
          />
          {c.entity} · {c.predicate}
        </span>
      ))}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full bg-[var(--faint)] inline-block animate-bounce"
      style={{ animationDelay: delay }}
    />
  );
}
