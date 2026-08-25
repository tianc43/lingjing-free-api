import { useMemo, useState } from "react";
import type { ApiKey, ApiKeyScope, Project, Settings, User } from "../types";

const scopeOptions: Array<{ value: ApiKeyScope; label: string }> = [
  { value: "models:read", label: "List models" },
  { value: "video:create", label: "Create videos" },
  { value: "video:read", label: "Read video tasks" },
  { value: "image:create", label: "Create images" },
  { value: "image:read", label: "Read image tasks" }
];

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

export interface CreateKeyInput {
  name: string;
  user_id: string;
  project_id: string;
  scopes: ApiKeyScope[];
  expires_at: number | null;
}

export function ApiAccessPage({ settings, keys, users, projects, onCreate, onToggle, onRevoke }: {
  settings: Settings;
  keys: ApiKey[];
  users: User[];
  projects: Project[];
  onCreate(input: CreateKeyInput): Promise<void>;
  onToggle(key: ApiKey): Promise<void>;
  onRevoke(key: ApiKey): Promise<void>;
}) {
  const activeProjects = useMemo(() => projects.filter((project) => project.status === "active" && users.some((user) => user.id === project.user_id && user.status === "active")), [projects, users]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [scopes, setScopes] = useState<ApiKeyScope[]>(["models:read", "video:create", "video:read"]);
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const project = activeProjects.find((item) => item.id === projectId);
    if (!name.trim()) { setError("Enter a key name."); return; }
    if (project === undefined && activeProjects.length > 0) { setError("Choose an active project."); return; }
    if (scopes.length === 0) { setError("Select at least one permission."); return; }
    const expiresAt = expiry === "" ? null : new Date(`${expiry}T23:59:59`).getTime();
    if (expiry !== "" && (expiresAt === null || !Number.isFinite(expiresAt) || expiresAt <= Date.now())) { setError("Choose a future expiry date."); return; }
    setSaving(true); setError("");
    try {
      await onCreate({ name: name.trim(), user_id: project?.user_id ?? "usr_legacy", project_id: project?.id ?? "prj_legacy", scopes, expires_at: expiresAt });
      setName(""); setProjectId(""); setExpiry(""); setCreating(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create API key"); }
    finally { setSaving(false); }
  };
  const apiKeyPlaceholder = "${LINGJING_API_KEY}";
  const authorizationHeader = `Authorization: Bearer ${apiKeyPlaceholder}`;
  const examples = [
    { label: "List models", value: [`curl -sS "${settings.api_base_url}/models" \\`, `  -H "${authorizationHeader}"`].join("\n") },
    { label: "Generate image", value: [`curl -sS "${settings.api_base_url}/images/generations" \\`, `  -H "${authorizationHeader}" \\`, "  -H \"Content-Type: application/json\" \\", "  -d '{\"model\":\"MODEL_ID\",\"prompt\":\"A calm ink landscape\"}'"].join("\n") },
    { label: "Generate video", value: [`curl -sS "${settings.api_base_url}/videos" \\`, `  -H "${authorizationHeader}" \\`, "  -H \"Content-Type: application/json\" \\", "  -d '{\"model\":\"MODEL_ID\",\"mode\":\"text-to-video\",\"prompt\":\"A calm ink landscape\"}'"].join("\n") }
  ];
  return <><header className="page-heading"><div><p className="eyebrow">Service credentials</p><h1 tabIndex={-1}>API keys</h1><p>Issue least-privilege credentials to one downstream project.</p></div><button onClick={() => setCreating(true)}>Create API key</button></header><section className="settings-grid api-access-grid"><article className="data-region"><h2>Base URL</h2><div className="copy-row"><code>{settings.api_base_url}</code><CopyButton label="Base URL" value={settings.api_base_url} /></div><p className="api-auth">Authentication: <code>{authorizationHeader}</code></p></article><article className="data-region"><h2>API keys</h2>{creating && <form className="api-key-create key-scope-form" noValidate onSubmit={(event) => void create(event)}><label>Key name<input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} /></label><label>Project<select value={projectId} onChange={(event) => { setProjectId(event.target.value); setError(""); }}><option value="">Choose project</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{users.find((user) => user.id === project.user_id)?.name} / {project.name}</option>)}</select></label><fieldset><legend>Permissions</legend>{scopeOptions.map((scope) => <label className="check-row" key={scope.value}><input type="checkbox" checked={scopes.includes(scope.value)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope.value] : current.filter((item) => item !== scope.value))} />{scope.label}</label>)}</fieldset><label>Expiry <span>(optional)</span><input type="date" value={expiry} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(event) => setExpiry(event.target.value)} /></label>{error && <p className="field-error" role="alert">{error}</p>}<div className="row-actions"><button type="button" className="quiet-button" onClick={() => { setCreating(false); setError(""); }}>Cancel</button><button disabled={saving} type="submit">{saving ? "Creating…" : "Create key"}</button></div></form>}{keys.length === 0 ? <p className="empty-state">No managed API keys yet.</p> : <div className="api-key-list">{keys.map((key) => { const project = projects.find((item) => item.id === key.project_id); const user = users.find((item) => item.id === key.user_id); return <article className="api-key-row" key={key.id}><div><strong>{key.name}</strong><span>{user?.name ?? "Unknown user"} / {project?.name ?? "Unknown project"}</span><code>{key.key_prefix}</code></div><span className={key.revoked_at !== null ? "status-pill status-unhealthy" : key.enabled ? "status-pill status-ready" : "status-pill status-unknown"}>{key.revoked_at !== null ? "Revoked" : key.enabled ? "Enabled" : "Disabled"}</span><dl><div><dt>Permissions</dt><dd>{key.scopes.join(", ")}</dd></div><div><dt>Expires</dt><dd>{timestamp(key.expires_at)}</dd></div><div><dt>Last used</dt><dd>{timestamp(key.last_used_at)}</dd></div></dl><div className="row-actions">{key.revoked_at === null && <><button className="quiet-button" onClick={() => void onToggle(key)}>{key.enabled ? "Disable" : "Enable"}</button><button className="danger-button" onClick={() => void onRevoke(key)}>Revoke</button></>}</div></article>; })}</div>}</article></section><section className="command-list" aria-label="Request examples">{examples.map((example) => <article className="command" key={example.label}><strong>{example.label}</strong><code>{example.value}</code><CopyButton label={example.label} value={example.value} /></article>)}</section></>;
}
