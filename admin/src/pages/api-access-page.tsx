import { useMemo, useState } from "react";
import type { ApiKey, ApiKeyScope, Project, Settings, User } from "../types";

const scopeOptions: Array<{ value: ApiKeyScope; label: string }> = [
  { value: "models:read", label: "列出模型" },
  { value: "video:create", label: "创建视频" },
  { value: "video:read", label: "读取视频任务" },
  { value: "image:create", label: "创建图片" },
  { value: "image:read", label: "读取图片任务" }
];

function timestamp(value: number | null): string {
  return value === null ? "从未" : new Date(value).toLocaleString("zh-CN");
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [notice, setNotice] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setNotice("已复制"); }
    catch { setNotice("复制失败"); }
  };
  return <><button className="quiet-button" aria-label={`复制${label}`} onClick={() => void copy()}>复制</button><span className="copy-notice" aria-live="polite">{notice}</span></>;
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
    if (!name.trim()) { setError("请输入密钥名称。"); return; }
    if (project === undefined && activeProjects.length > 0) { setError("请选择启用的项目。"); return; }
    if (scopes.length === 0) { setError("请至少选择一项权限。"); return; }
    const expiresAt = expiry === "" ? null : new Date(`${expiry}T23:59:59`).getTime();
    if (expiry !== "" && (expiresAt === null || !Number.isFinite(expiresAt) || expiresAt <= Date.now())) { setError("请选择未来的到期日期。"); return; }
    setSaving(true); setError("");
    try {
      await onCreate({ name: name.trim(), user_id: project?.user_id ?? "usr_legacy", project_id: project?.id ?? "prj_legacy", scopes, expires_at: expiresAt });
      setName(""); setProjectId(""); setExpiry(""); setCreating(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建 API 密钥"); }
    finally { setSaving(false); }
  };
  const apiKeyPlaceholder = "${LINGJING_API_KEY}";
  const authorizationHeader = `Authorization: Bearer ${apiKeyPlaceholder}`;
  const examples = [
    { label: "列出模型", value: [`curl -sS "${settings.api_base_url}/models" \\`, `  -H "${authorizationHeader}"`].join("\n") },
    { label: "生成图片", value: [`curl -sS "${settings.api_base_url}/images/generations" \\`, `  -H "${authorizationHeader}" \\`, "  -H \"Content-Type: application/json\" \\", "  -d '{\"model\":\"MODEL_ID\",\"prompt\":\"宁静的水墨山水\"}'"].join("\n") },
    { label: "生成视频", value: [`curl -sS "${settings.api_base_url}/videos" \\`, `  -H "${authorizationHeader}" \\`, "  -H \"Content-Type: application/json\" \\", "  -d '{\"model\":\"MODEL_ID\",\"mode\":\"text-to-video\",\"prompt\":\"宁静的水墨山水\"}'"].join("\n") }
  ];
  return <><header className="page-heading"><div><p className="eyebrow">服务凭据</p><h1 tabIndex={-1}>API 密钥</h1><p>为单个下游项目签发最小权限凭据。</p></div><button onClick={() => setCreating(true)}>创建 API 密钥</button></header><section className="settings-grid api-access-grid"><article className="data-region"><h2>基础 URL</h2><div className="copy-row"><code>{settings.api_base_url}</code><CopyButton label="基础 URL" value={settings.api_base_url} /></div><p className="api-auth">身份验证： <code>{authorizationHeader}</code></p></article><article className="data-region"><h2>API 密钥</h2>{creating && <form className="api-key-create key-scope-form" noValidate onSubmit={(event) => void create(event)}><label>密钥名称<input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} /></label><label>项目<select value={projectId} onChange={(event) => { setProjectId(event.target.value); setError(""); }}><option value="">选择项目</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{users.find((user) => user.id === project.user_id)?.name} / {project.name}</option>)}</select></label><fieldset><legend>权限</legend>{scopeOptions.map((scope) => <label className="check-row" key={scope.value}><input type="checkbox" checked={scopes.includes(scope.value)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope.value] : current.filter((item) => item !== scope.value))} />{scope.label}</label>)}</fieldset><label>到期日期 <span>（可选）</span><input type="date" value={expiry} min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)} onChange={(event) => setExpiry(event.target.value)} /></label>{error && <p className="field-error" role="alert">{error}</p>}<div className="row-actions"><button type="button" className="quiet-button" onClick={() => { setCreating(false); setError(""); }}>取消</button><button disabled={saving} type="submit">{saving ? "正在创建…" : "创建密钥"}</button></div></form>}{keys.length === 0 ? <p className="empty-state">暂无托管 API 密钥。</p> : <div className="api-key-list">{keys.map((key) => { const project = projects.find((item) => item.id === key.project_id); const user = users.find((item) => item.id === key.user_id); return <article className="api-key-row" key={key.id}><div><strong>{key.name}</strong><span>{user?.name ?? "未知用户"} / {project?.name ?? "未知项目"}</span><code>{key.key_prefix}</code></div><span className={key.revoked_at !== null ? "status-pill status-unhealthy" : key.enabled ? "status-pill status-ready" : "status-pill status-unknown"}>{key.revoked_at !== null ? "已撤销" : key.enabled ? "已启用" : "已禁用"}</span><dl><div><dt>权限</dt><dd>{key.scopes.join(", ")}</dd></div><div><dt>到期时间</dt><dd>{timestamp(key.expires_at)}</dd></div><div><dt>最近使用</dt><dd>{timestamp(key.last_used_at)}</dd></div></dl><div className="row-actions">{key.revoked_at === null && <><button className="quiet-button" onClick={() => void onToggle(key)}>{key.enabled ? "禁用" : "启用"}</button><button className="danger-button" onClick={() => void onRevoke(key)}>撤销</button></>}</div></article>; })}</div>}</article></section><section className="command-list" aria-label="请求示例">{examples.map((example) => <article className="command" key={example.label}><strong>{example.label}</strong><code>{example.value}</code><CopyButton label={example.label} value={example.value} /></article>)}</section></>;
}
