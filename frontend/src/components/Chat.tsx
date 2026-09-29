import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatTurn, Doc, Source, askQuestion } from "../api";
import { docHref } from "../route";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  error?: string;
  streaming?: boolean;
}

interface Props {
  docs: Doc[];
  selected: Set<string>;
  readyCount: number;
}

export default function Chat({ docs, selected, readyCount }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const question = input.trim();
    if (!question || busy) return;

    const history: ChatTurn[] = messages
      .filter((m) => !m.error && m.content)
      .map((m) => ({ role: m.role, content: m.content }));

    setInput("");
    setBusy(true);
    setMessages((ms) => [...ms, { role: "user", content: question }, { role: "assistant", content: "", streaming: true }]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await askQuestion(
        question,
        history,
        selected.size ? [...selected] : null,
        {
          onSources: (sources) => updateLast((m) => ({ ...m, sources })),
          onDelta: (text) => updateLast((m) => ({ ...m, content: m.content + text })),
        },
        controller.signal,
      );
    } catch (err) {
      if (controller.signal.aborted) updateLast((m) => ({ ...m, content: m.content + "\n\n_(stopped)_" }));
      else updateLast((m) => ({ ...m, error: (err as Error).message }));
    } finally {
      updateLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
      abortRef.current = null;
    }
  }

  const scope =
    selected.size === 0
      ? `all ${readyCount} document${readyCount === 1 ? "" : "s"}`
      : docs
          .filter((d) => selected.has(d.id))
          .map((d) => d.filename)
          .join(", ");

  return (
    <section className="panel chat">
      <div className="panel-head">
        <h2>Ask</h2>
        {messages.length > 0 && (
          <button className="link" onClick={() => setMessages([])} disabled={busy}>
            New conversation
          </button>
        )}
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty muted">
            {readyCount === 0
              ? "Upload a document, then ask questions about it here."
              : "Ask anything about your documents. Answers cite the passages they draw on."}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "user" ? (
              <div className="bubble">{m.content}</div>
            ) : (
              <div className="answer">
                {m.content ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  m.streaming && !m.error && <div className="muted typing">{m.sources ? "Thinking…" : "Searching…"}</div>
                )}
                {m.error && <div className="alert">{m.error}</div>}
                {m.sources && m.sources.length > 0 && (
                  <details className="sources">
                    <summary>{m.sources.length} sources</summary>
                    <ol>
                      {m.sources.map((s) => (
                        <li key={s.n} value={s.n}>
                          <a href={docHref(s.document_id, { page: s.page })}>
                            {s.filename}
                          </a>
                          {s.page != null && <span className="muted"> · p.{s.page}</span>}
                          <span className="muted"> · {(s.score * 100).toFixed(0)}% match</span>
                          <blockquote>{s.snippet}…</blockquote>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <div className="scope muted small" title={scope}>
          Searching {scope}
        </div>
        <div className="row">
          <textarea
            value={input}
            placeholder={readyCount ? "Ask a question…" : "Upload documents first"}
            rows={2}
            disabled={readyCount === 0}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {busy ? (
            <button type="button" className="btn secondary" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn" disabled={!input.trim() || readyCount === 0}>
              Ask
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
