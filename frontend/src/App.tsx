import { useCallback, useEffect, useState } from "react";
import { Doc, listDocuments } from "./api";
import Library from "./components/Library";
import Chat from "./components/Chat";
import SearchPage from "./pages/SearchPage";
import ViewerPage from "./pages/ViewerPage";
import SettingsPage from "./pages/SettingsPage";
import DatabasePage from "./pages/DatabasePage";
import { useRoute } from "./route";

const NAV = [
  { path: "", label: "Documents" },
  { path: "search", label: "Search" },
  { path: "database", label: "Database" },
  { path: "settings", label: "Settings" },
];

export default function App() {
  const route = useRoute();
  const section = route.path[0] ?? "";
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      setDocs(await listDocuments());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while anything is still being ingested.
  const processing = docs.some((d) => d.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [processing, refresh]);

  // Drop selections for documents that no longer exist.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(docs.map((d) => d.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [docs]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const readyCount = docs.filter((d) => d.status === "ready").length;

  let content;
  if (section === "search") {
    content = <SearchPage initialQuery={route.params.get("q") ?? ""} />;
  } else if (section === "doc" && route.path[1]) {
    const page = Number(route.params.get("page")) || null;
    content = <ViewerPage id={route.path[1]} page={page} query={route.params.get("q") ?? ""} />;
  } else if (section === "database") {
    content = <DatabasePage table={route.path[1] ?? null} />;
  } else if (section === "settings") {
    content = <SettingsPage />;
  } else {
    content = (
      <main className="layout">
        <Library
          docs={docs}
          loadError={loadError}
          selected={selected}
          onToggle={toggle}
          onClearSelection={() => setSelected(new Set())}
          onChanged={refresh}
        />
        <Chat docs={docs} selected={selected} readyCount={readyCount} />
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden>
            ▤
          </span>
          DocVault
        </a>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.path} href={`#/${n.path}`} className={section === n.path ? "active" : ""}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="muted small status">
          {readyCount} document{readyCount === 1 ? "" : "s"} indexed
        </div>
      </header>
      {content}
    </div>
  );
}
