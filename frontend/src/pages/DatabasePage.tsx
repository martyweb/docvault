import { useEffect, useState } from "react";
import { TableInfo, TableRows, getTableRows, getTables } from "../api";

const PAGE_SIZE = 50;

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function DatabasePage({ table }: { table: string | null }) {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [rows, setRows] = useState<TableRows | null>(null);
  const [offset, setOffset] = useState(0);
  const [showSchema, setShowSchema] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    getTables()
      .then((t) => {
        setTables(t);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));

  useEffect(() => {
    refresh();
  }, []);

  const selected = tables?.find((t) => t.name === (table ?? tables[0]?.name)) ?? null;

  useEffect(() => setOffset(0), [selected?.name]);

  useEffect(() => {
    if (!selected) return;
    setRows(null);
    getTableRows(selected.name, PAGE_SIZE, offset)
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, [selected?.name, offset]);

  const columns = selected?.columns.map((c) => c.name) ?? [];

  return (
    <div className="db">
      <aside className="panel db-tables">
        <div className="panel-head">
          <h2>Tables</h2>
          <button className="link" onClick={refresh}>
            Refresh
          </button>
        </div>
        <ul>
          {tables?.map((t) => (
            <li key={t.name}>
              <a href={`#/database/${t.name}`} className={t.name === selected?.name ? "active" : ""}>
                <span className="name">{t.name}</span>
                <span className="muted small">
                  {t.rows.toLocaleString()} rows · {formatBytes(t.size_bytes)}
                </span>
              </a>
            </li>
          ))}
        </ul>
        <p className="muted small hint">Read-only view. Secrets are masked and vectors are summarized.</p>
      </aside>

      <section className="panel db-main">
        {error && <div className="alert">{error}</div>}
        {selected && (
          <>
            <div className="panel-head">
              <h2>{selected.name}</h2>
              <button className="link" onClick={() => setShowSchema((s) => !s)}>
                {showSchema ? "Hide schema" : "Show schema"}
              </button>
            </div>

            {showSchema && (
              <div className="schema">
                <table className="grid">
                  <thead>
                    <tr>
                      <th>Column</th>
                      <th>Type</th>
                      <th>Nullable</th>
                      <th>Default</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.columns.map((c) => (
                      <tr key={c.name}>
                        <td>
                          <code>{c.name}</code>
                        </td>
                        <td>{c.type}</td>
                        <td>{c.nullable ? "yes" : "no"}</td>
                        <td className="muted">{c.default}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>Indexes</h3>
                <ul className="indexes">
                  {selected.indexes.map((i) => (
                    <li key={i.name}>
                      <code>{i.definition}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="table-wrap">
              {!rows ? (
                <p className="muted empty">Loading…</p>
              ) : rows.rows.length === 0 ? (
                <p className="muted empty">No rows.</p>
              ) : (
                <table className="grid">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.rows.map((r, i) => (
                      <tr key={i}>
                        {columns.map((c) => (
                          <td key={c} title={formatCell(r[c])}>
                            {formatCell(r[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {rows && rows.total > 0 && (
              <div className="pager">
                <button className="btn secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                  Previous
                </button>
                <span className="muted small">
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, rows.total)} of {rows.total.toLocaleString()}
                </span>
                <button
                  className="btn secondary"
                  disabled={offset + PAGE_SIZE >= rows.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
