export type DocStatus = "processing" | "ready" | "failed";

export interface Doc {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  status: DocStatus;
  error: string | null;
  chunk_count: number;
  created_at: string;
  duplicate?: boolean;
}

export interface Source {
  n: number;
  document_id: string;
  filename: string;
  page: number | null;
  score: number;
  snippet: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body.detail === "string" ? body.detail : `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

export async function listDocuments(): Promise<Doc[]> {
  const res = await fetch("/api/documents");
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

export async function reprocessDocument(id: string): Promise<void> {
  const res = await fetch(`/api/documents/${id}/reprocess`, { method: "POST" });
  if (!res.ok) throw new Error(await errorMessage(res));
}

/** Uploads with XHR so we get upload progress events. */
export function uploadDocument(file: File, onProgress: (fraction: number) => void): Promise<Doc> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/documents");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.detail ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export interface ChatHandlers {
  onSources: (sources: Source[]) => void;
  onDelta: (text: string) => void;
}

/** Streams an answer over server-sent events. Resolves when done; rejects on error. */
export async function askQuestion(
  question: string,
  history: ChatTurn[],
  documentIds: string[] | null,
  handlers: ChatHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history, document_ids: documentIds }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await errorMessage(res));

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (!event || data === undefined) continue;
      const payload = JSON.parse(data);
      if (event === "sources") handlers.onSources(payload);
      else if (event === "delta") handlers.onDelta(payload);
      else if (event === "error") throw new Error(payload);
      else if (event === "done") return;
    }
  }
}

// ---- Settings / versions / database ----

export interface SettingsView {
  anthropic_api_key: { configured: boolean; hint: string | null; source: "database" | "environment" | null };
  anthropic_base_url: { value: string | null; source: "database" | "environment" | null; default: string };
  claude_model: string;
  claude_effort: string;
}

export interface SettingsUpdate {
  anthropic_api_key?: string | null;
  anthropic_base_url?: string | null;
}

export interface TestResult {
  ok: boolean;
  model?: string;
  display_name?: string;
  error?: string;
}

export interface Versions {
  app: string;
  started_at: string;
  runtime: Record<string, string | null>;
  packages: Record<string, string | null>;
  models: Record<string, string>;
}

export interface TableInfo {
  name: string;
  rows: number;
  size_bytes: number;
  columns: { name: string; type: string; nullable: boolean; default: string | null }[];
  indexes: { name: string; definition: string }[];
}

export interface TableRows {
  total: number;
  offset: number;
  rows: Record<string, unknown>[];
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getSettings = () => getJson<SettingsView>("/api/settings");
export const saveSettings = (u: SettingsUpdate) => getJson<SettingsView>("/api/settings", jsonInit("PUT", u));
export const testSettings = (u: SettingsUpdate) => getJson<TestResult>("/api/settings/test", jsonInit("POST", u));
export const getVersions = () => getJson<Versions>("/api/versions");
export const getTables = () => getJson<TableInfo[]>("/api/db/tables");
export const getTableRows = (name: string, limit: number, offset: number) =>
  getJson<TableRows>(`/api/db/tables/${encodeURIComponent(name)}/rows?limit=${limit}&offset=${offset}`);

// ---- Search / preview ----

export interface SearchHit {
  page: number | null;
  chunk_index: number;
  snippet: string;
  match: "keyword" | "semantic";
}

export interface SearchResult {
  document_id: string;
  filename: string;
  size_bytes: number;
  created_at: string;
  score: number;
  keyword: boolean;
  filename_match: boolean;
  similarity: number | null;
  hit_count: number;
  hits: SearchHit[];
}

export interface SearchResponse {
  query: string;
  highlight: [string, string];
  results: SearchResult[];
}

export type Preview =
  | { kind: "pdf"; url: string }
  | { kind: "html"; content: string }
  | { kind: "markdown"; content: string }
  | { kind: "code"; language: string; content: string }
  | { kind: "text"; content: string }
  | { kind: "table"; rows: string[][]; truncated: boolean; total_rows: number }
  | { kind: "unavailable"; reason: string; url: string };

export const searchDocuments = (q: string, signal?: AbortSignal) =>
  getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, { signal });
export const getDocument = (id: string) => getJson<Doc>(`/api/documents/${id}`);
export const getPreview = (id: string) => getJson<Preview>(`/api/documents/${id}/preview`);
