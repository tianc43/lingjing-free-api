import { useState } from "react";
import type { ApiKey, Settings } from "../types";

function timestamp(value: number | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [notice, setNotice] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setNotice("Copied"); }
    catch { setNotice("Copy failed"); }
  };
  return <><button className="quiet-button" aria-label={`Copy ${label}`} onClick={() => void copy()}>Copy</button><span className="copy-notice" aria-live="polite">{notice}</span></>;
}

export function ApiAccessPage({ settings, keys, onCreate, onToggle, onRevoke }: { settings: Settings; keys: ApiKey[]; onCreate(name: string): Promise<void>; onToggle(key: ApiKey): Promise<void>; onRevoke(key: ApiKey): Promise<void> }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError("Key name is required."); return; }
    setSaving(true); setError("");
    try { await onCreate(name.trim()); setName(""); setCreating(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create API key"); }
    finally { setSaving(false); }
  };
  const apiKeyPlaceholder = "${LINGJING_API_KEY}";
  const authorizationHeader = `Authorization: Bearer ${apiKeyPlaceholder}`;
  const examples = [
    { label: "List models", value: [`curl "${settings.api_base_url}/models" \\`, `  -H "${authorizationHeader}"`].join("\n") },
    { label: "Generate image", value: [`curl "${settings.api_base_url}/images/generations" \\`, `  -H "${authorizationHeader}" \\`, "  -H \"Content-Type: application/json\" \\", "  -d '{\"model\":\"fixture-image\",\"prompt\":\"A calm ink landscape\"}'"].join("\n") },
    { label: "Generate video", value: [`curl "${settings.api_base_url}/videos/generations" \\`, `  -H "${authorizationHeader}" \\`, "  -H \"Content-Type: application/json\" \\", "  -d '{\"model\":\"fixture-video\",\"mode\":\"image-to-video\",\"prompt\":\"A calm ink landscape\"}'"].join("\n") },
    { label: "OpenAI client", value: `const client = new OpenAI({ baseURL: "${settings.api_base_url}", apiKey: process.env.LINGJING_API_KEY });` }
  ];
  return <><header className="page-heading"><div><p className="eyebrow">Service credentials</p><h1>API Access</h1><p>Manage downstream keys and copy service-ready requests.</p></div><button onClick={() => setCreating(true)}>Create API key</button></header><section className="settings-grid api-access-grid"><article className="data-region"><h2>Base URL</h2><div className="copy-row"><code>{settings.api_base_url}</code><CopyButton label="Base URL" value={settings.api_base_url} /></div><p className="api-auth">Authentication: <code>{authorizationHeader}</code></p></article><article className="data-region"><h2>API keys</h2>{creating && <form className="api-key-create" noValidate onSubmit={(event) => void create(event)}><label>Key name<input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} aria-invalid={error !== ""} aria-describedby={error ? "api-key-name-error" : undefined} /></label>{error && <p id="api-key-name-error" className="field-error">{error}</p>}<div className="row-actions"><button type="button" className="quiet-button" onClick={() => { setCreating(false); setError(""); }}>Cancel</button><button disabled={saving} type="submit">Create key</button></div></form>}{keys.length === 0 ? <p className="empty-state">No managed API keys yet.</p> : <div className="api-key-list">{keys.map((key) => <article className="api-key-row" key={key.id}><div><strong>{key.name}</strong><code>{key.key_prefix}</code></div><div><span className={key.revoked_at !== null ? "status-pill status-unhealthy" : key.enabled ? "status-pill status-ready" : "status-pill status-unknown"}>{key.revoked_at !== null ? "Revoked" : key.enabled ? "Enabled" : "Disabled"}</span></div><dl><div><dt>Created</dt><dd>{timestamp(key.created_at)}</dd></div><div><dt>Last used</dt><dd>{timestamp(key.last_used_at)}</dd></div></dl><div className="row-actions">{key.revoked_at === null && <><button className="quiet-button" aria-label={`${key.enabled ? "Disable" : "Enable"} ${key.name}`} onClick={() => void onToggle(key)}>{key.enabled ? "Disable" : "Enable"}</button><button className="danger-button" aria-label={`Revoke ${key.name}`} onClick={() => void onRevoke(key)}>Revoke</button></>}</div></article>)}</div>}</article></section><section className="data-region api-examples"><h2>Examples</h2>{examples.map((example) => <div className="command" key={example.label}><span>{example.label}</span><code>{example.value}</code><CopyButton label={example.label} value={example.value} /></div>)}</section></>;
}
