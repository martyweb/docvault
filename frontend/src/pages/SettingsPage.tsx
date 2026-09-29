import { FormEvent, useEffect, useState, version as reactVersion } from "react";
import { SettingsView, TestResult, Versions, getSettings, getVersions, saveSettings, testSettings } from "../api";

function sourceLabel(source: "database" | "environment" | null) {
  if (source === "database") return "set here";
  if (source === "environment") return "from .env";
  return "not set";
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        setBaseUrl(s.anthropic_base_url.source === "database" ? s.anthropic_base_url.value ?? "" : "");
      })
      .catch((e) => setError((e as Error).message));
    getVersions()
      .then(setVersions)
      .catch((e) => setError((e as Error).message));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setStatus(null);
    try {
      await action();
    } catch (e) {
      setStatus({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const update: Record<string, string | null> = { anthropic_base_url: baseUrl.trim() || null };
      if (apiKey.trim()) update.anthropic_api_key = apiKey.trim();
      const s = await saveSettings(update);
      setSettings(s);
      setApiKey("");
      setTestResult(null);
      setStatus({ ok: true, text: "Saved." });
    });
  };

  const clearKey = () =>
    run(async () => {
      setSettings(await saveSettings({ anthropic_api_key: null }));
      setTestResult(null);
      setStatus({ ok: true, text: "Removed the saved key." });
    });

  const test = () =>
    run(async () => {
      setTestResult(
        await testSettings({ anthropic_api_key: apiKey.trim() || undefined, anthropic_base_url: baseUrl.trim() || undefined }),
      );
    });

  const key = settings?.anthropic_api_key;
  const url = settings?.anthropic_base_url;

  return (
    <div className="page narrow">
      <h1>Settings</h1>
      {error && <div className="alert">{error}</div>}

      <section className="panel card">
        <h2>Claude API</h2>
        <form onSubmit={save} className="form">
          <label>
            <span className="label-row">
              API key <span className={`tag ${key?.configured ? "ok" : "warn"}`}>{sourceLabel(key?.source ?? null)}</span>
            </span>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={key?.hint ? `${key.hint} (enter a new key to replace it)` : "sk-ant-…"}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className="muted small">
              Keys saved here are stored in the DocVault database and override <code>ANTHROPIC_API_KEY</code> from
              .env.
            </span>
          </label>

          <label>
            <span className="label-row">
              API URL <span className="tag">{sourceLabel(url?.source ?? null)}</span>
            </span>
            <input
              type="url"
              value={baseUrl}
              placeholder={
                url?.source === "environment" ? `${url.value} (from .env)` : `${url?.default ?? ""} (default)`
              }
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <span className="muted small">
              Leave blank for the default. Set this to use a proxy or gateway that speaks the Anthropic API.
            </span>
          </label>

          <div className="form-actions">
            <button className="btn" type="submit" disabled={busy}>
              Save
            </button>
            <button className="btn secondary" type="button" onClick={test} disabled={busy}>
              Test connection
            </button>
            {key?.source === "database" && (
              <button className="link danger" type="button" onClick={clearKey} disabled={busy}>
                Remove saved key
              </button>
            )}
          </div>
          {status && <div className={status.ok ? "notice ok" : "alert"}>{status.text}</div>}
          {testResult && (
            <div className={testResult.ok ? "notice ok" : "alert"}>
              {testResult.ok
                ? `Connected. ${testResult.display_name ?? testResult.model} is available.`
                : testResult.error}
            </div>
          )}
        </form>
        {settings && (
          <p className="muted small">
            Model <code>{settings.claude_model}</code>, effort <code>{settings.claude_effort}</code> (set in .env).
          </p>
        )}
      </section>

      <section className="panel card">
        <h2>Versions</h2>
        {!versions ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="versions">
            <VersionTable
              title="DocVault"
              rows={{
                Backend: versions.app,
                Frontend: __APP_VERSION__,
                "Frontend built": new Date(__BUILD_TIME__).toLocaleString(),
                "Backend started": new Date(versions.started_at).toLocaleString(),
              }}
            />
            <VersionTable title="Runtime" rows={versions.runtime} />
            <VersionTable title="Models" rows={versions.models} />
            <VersionTable title="Backend packages" rows={versions.packages} />
            <VersionTable title="Frontend packages" rows={{ React: reactVersion, Vite: __VITE_VERSION__ }} />
          </div>
        )}
      </section>
    </div>
  );
}

function VersionTable({ title, rows }: { title: string; rows: Record<string, string | null> }) {
  return (
    <div>
      <h3>{title}</h3>
      <table className="kv">
        <tbody>
          {Object.entries(rows).map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v ?? <span className="muted">n/a</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
