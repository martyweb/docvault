import { FormEvent, useEffect, useState } from "react";
import { SearchResponse, searchDocuments } from "../api";
import { Highlight, MarkedSnippet, queryTerms } from "../components/Highlight";
import { docHref } from "../route";

export default function SearchPage({ initialQuery }: { initialQuery: string }) {
  const [input, setInput] = useState(initialQuery);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The URL (#/search?q=...) is the source of truth, so results survive back/forward.
  useEffect(() => {
    setInput(initialQuery);
    if (!initialQuery.trim()) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    searchDocuments(initialQuery, controller.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => !controller.signal.aborted && setError((e as Error).message))
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [initialQuery]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = input.trim();
    window.location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : "#/search";
  }

  const terms = queryTerms(initialQuery);

  return (
    <div className="page">
      <form className="searchbar" onSubmit={submit}>
        <input
          type="search"
          value={input}
          autoFocus
          placeholder='Search your documents: words, "exact phrases", or a description of what you need'
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn" type="submit" disabled={!input.trim()}>
          Search
        </button>
      </form>

      {error && <div className="alert">{error}</div>}
      {loading && <p className="muted">Searching…</p>}

      {data && !loading && (
        <>
          <p className="muted small">
            {data.results.length === 0
              ? `No documents match “${data.query}”.`
              : `${data.results.length} document${data.results.length === 1 ? "" : "s"} for “${data.query}”`}
          </p>
          <ul className="results">
            {data.results.map((r) => (
              <li key={r.document_id} className="result panel">
                <a className="result-title" href={docHref(r.document_id, { page: r.hits[0]?.page, q: data.query })}>
                  <Highlight text={r.filename} terms={r.filename_match ? terms : []} />
                </a>
                <div className="tags">
                  {r.keyword && <span className="tag">keyword match</span>}
                  {r.similarity != null && (
                    <span className="tag semantic">{Math.round(r.similarity * 100)}% related</span>
                  )}
                  {r.filename_match && <span className="tag">filename</span>}
                  {r.hit_count > 0 && (
                    <span className="muted small">
                      {r.hit_count} passage{r.hit_count === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                {r.hits.map((h) => (
                  <a
                    key={h.chunk_index}
                    className="hit"
                    href={docHref(r.document_id, { page: h.page, q: data.query })}
                  >
                    {h.page != null && <span className="hit-page">p.{h.page}</span>}
                    <span>
                      {h.match === "keyword" ? (
                        <MarkedSnippet text={h.snippet} markers={data.highlight} />
                      ) : (
                        <Highlight text={h.snippet} terms={terms} />
                      )}
                    </span>
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}

      {!data && !loading && !error && (
        <p className="muted empty">
          Keyword search finds exact words and phrases. Semantic search also finds passages with a related meaning,
          even when they use different words.
        </p>
      )}
    </div>
  );
}
