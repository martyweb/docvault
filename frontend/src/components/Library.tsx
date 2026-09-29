import { useRef, useState } from "react";
import { Doc, deleteDocument, reprocessDocument, uploadDocument } from "../api";
import { docHref } from "../route";

const ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.rst,.log,.sql,.py,.js,.ts,.tsx,.jsx,.java,.go,.rb,.c,.h,.cpp,.cs,.sh,.ini,.toml,.cfg,.conf";

interface Upload {
  key: string;
  name: string;
  progress: number;
  error?: string;
  note?: string;
}

interface Props {
  docs: Doc[];
  loadError: string | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClearSelection: () => void;
  onChanged: () => void;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Library({ docs, loadError, selected, onToggle, onClearSelection, onChanged }: Props) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const patch = (key: string, p: Partial<Upload>) =>
    setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const entries = list.map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, name: f.name, progress: 0 }));
    setUploads((u) => [...entries, ...u]);
    // Sequential uploads keep progress readable and avoid hammering the NAS.
    for (let i = 0; i < list.length; i++) {
      const { key } = entries[i];
      try {
        const doc = await uploadDocument(list[i], (p) => patch(key, { progress: p }));
        if (doc.duplicate) patch(key, { progress: 1, note: "Already in library" });
        else setUploads((u) => u.filter((x) => x.key !== key));
        onChanged();
      } catch (e) {
        patch(key, { error: (e as Error).message });
      }
    }
  }

  async function remove(id: string) {
    setConfirmDelete(null);
    try {
      await deleteDocument(id);
      setActionError(null);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  async function retry(id: string) {
    try {
      await reprocessDocument(id);
      onChanged();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <section className="panel library">
      <div className="panel-head">
        <h2>Library</h2>
        {selected.size > 0 && (
          <button className="link" onClick={onClearSelection}>
            Clear selection ({selected.size})
          </button>
        )}
      </div>

      <div
        className={`dropzone${dragging ? " dragging" : ""}`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
      >
        <strong>Drop files here</strong> or click to browse
        <div className="muted small">PDF, Word, Markdown, text, CSV, JSON, HTML, code</div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploads.length > 0 && (
        <ul className="uploads">
          {uploads.map((u) => (
            <li key={u.key} className={u.error ? "error" : ""}>
              <div className="row">
                <span className="name">{u.name}</span>
                <button className="icon" title="Dismiss" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                  ×
                </button>
              </div>
              {u.error ? (
                <div className="small">{u.error}</div>
              ) : u.note ? (
                <div className="small muted">{u.note}</div>
              ) : (
                <div className="bar">
                  <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {(loadError || actionError) && <div className="alert">{loadError ?? actionError}</div>}

      {docs.length === 0 && !loadError ? (
        <p className="muted empty">No documents yet. Upload some to start asking questions.</p>
      ) : (
        <>
          <p className="muted small hint">Tick documents to limit questions to them; none ticked searches everything.</p>
          <ul className="docs">
            {docs.map((d) => (
              <li key={d.id} className={selected.has(d.id) ? "selected" : ""}>
                <label className="doc-main">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    disabled={d.status !== "ready"}
                    onChange={() => onToggle(d.id)}
                  />
                  <span className="doc-text">
                    {d.status === "ready" ? (
                      <a className="name doc-link" title={`Open ${d.filename}`} href={docHref(d.id)}>
                        {d.filename}
                      </a>
                    ) : (
                      <span className="name" title={d.filename}>
                        {d.filename}
                      </span>
                    )}
                    <span className="muted small">
                      {formatSize(d.size_bytes)}
                      {d.status === "ready" && ` · ${d.chunk_count} chunks`}
                      {" · "}
                      {new Date(d.created_at).toLocaleDateString()}
                    </span>
                    {d.status === "failed" && d.error && <span className="small error-text">{d.error}</span>}
                  </span>
                </label>
                <span className={`badge ${d.status}`}>{d.status === "processing" ? "indexing…" : d.status}</span>
                <span className="actions">
                  {d.status === "failed" && (
                    <button className="link" onClick={() => retry(d.id)}>
                      Retry
                    </button>
                  )}
                  <a className="link" href={`/api/documents/${d.id}/file`} title="Download">
                    ↓
                  </a>
                  {confirmDelete === d.id ? (
                    <>
                      <button className="link danger" onClick={() => remove(d.id)}>
                        Delete
                      </button>
                      <button className="link" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="icon" title="Delete" onClick={() => setConfirmDelete(d.id)}>
                      🗑
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
