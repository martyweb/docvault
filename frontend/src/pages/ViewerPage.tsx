import { ReactNode, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Doc, Preview, getDocument, getPreview } from "../api";
import { Highlight, queryTerms } from "../components/Highlight";

// Uploaded HTML (and DOCX converted to HTML) renders in a sandbox: no scripts, no same-origin access.
const HTML_FRAME_STYLE =
  "<style>body{font-family:system-ui,sans-serif;line-height:1.55;max-width:860px;margin:24px auto;padding:0 20px;color:#1c2230}" +
  "img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}</style>";

interface Props {
  id: string;
  page: number | null;
  query: string;
}

export default function ViewerPage({ id, page, query }: Props) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const terms = queryTerms(query);

  useEffect(() => {
    setDoc(null);
    setPreview(null);
    setError(null);
    Promise.all([getDocument(id), getPreview(id)])
      .then(([d, p]) => {
        setDoc(d);
        setPreview(p);
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);

  // Bring the first highlighted match into view.
  useEffect(() => {
    bodyRef.current?.querySelector("mark")?.scrollIntoView({ block: "center" });
  }, [preview]);

  const fileUrl = `/api/documents/${id}/file`;

  return (
    <div className="viewer">
      <div className="viewer-head">
        <button className="link" onClick={() => history.back()}>
          ← Back
        </button>
        <div className="viewer-title">
          <strong title={doc?.filename}>{doc?.filename ?? "Loading…"}</strong>
          {doc && (
            <span className="muted small">
              {(doc.size_bytes / 1024).toFixed(0)} KB · {doc.chunk_count} chunks · uploaded{" "}
              {new Date(doc.created_at).toLocaleString()}
              {query && ` · highlighting “${query}”`}
            </span>
          )}
        </div>
        <a className="btn secondary small-btn" href={fileUrl}>
          Download
        </a>
      </div>

      {error && <div className="alert">{error}</div>}

      <div className="viewer-body" ref={bodyRef}>
        {!preview && !error && <p className="muted empty">Loading preview…</p>}
        {preview?.kind === "pdf" && (
          <iframe
            className="viewer-frame"
            title={doc?.filename ?? "PDF"}
            // Built-in PDF viewers honour #page; Firefox's also honours #search.
            src={`${preview.url}#${page ? `page=${page}` : ""}${query ? `&search=${encodeURIComponent(query)}` : ""}`}
          />
        )}
        {preview?.kind === "html" && (
          <iframe
            className="viewer-frame white"
            title={doc?.filename ?? "Document"}
            sandbox=""
            srcDoc={HTML_FRAME_STYLE + preview.content}
          />
        )}
        {preview?.kind === "markdown" && (
          <article className="md doc-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // Highlight search terms inside plain text nodes.
                p: ({ children }) => <p>{highlightChildren(children, terms)}</p>,
                li: ({ children }) => <li>{highlightChildren(children, terms)}</li>,
                td: ({ children }) => <td>{highlightChildren(children, terms)}</td>,
              }}
            >
              {preview.content}
            </ReactMarkdown>
          </article>
        )}
        {(preview?.kind === "text" || preview?.kind === "code") && (
          <pre className={`doc-text ${preview.kind}`}>
            <Highlight text={preview.content} terms={terms} />
          </pre>
        )}
        {preview?.kind === "table" && (
          <div className="table-wrap">
            {preview.truncated && (
              <p className="muted small">
                Showing the first {preview.rows.length - 1} of {preview.total_rows - 1} rows.
              </p>
            )}
            <table className="grid">
              <thead>
                <tr>
                  {preview.rows[0]?.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(1).map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>
                        <Highlight text={cell} terms={terms} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview?.kind === "unavailable" && (
          <p className="muted empty">
            {preview.reason} <a href={preview.url}>Download it</a> instead.
          </p>
        )}
      </div>
    </div>
  );
}

function highlightChildren(children: ReactNode, terms: string[]): ReactNode {
  if (!terms.length) return children;
  const wrap = (c: ReactNode, i: number) =>
    typeof c === "string" ? <Highlight key={i} text={c} terms={terms} /> : c;
  return Array.isArray(children) ? children.map(wrap) : wrap(children, 0);
}
