import { useState } from "react";
import type { Project, User } from "../types";

export function IdentitiesPage({ users, projects, onCreateUser, onCreateProject, onToggleUser, onToggleProject }: {
  users: User[];
  projects: Project[];
  onCreateUser(name: string): Promise<void>;
  onCreateProject(userId: string, name: string): Promise<void>;
  onToggleUser(user: User): Promise<void>;
  onToggleProject(project: Project): Promise<void>;
}) {
  const [userName, setUserName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [userId, setUserId] = useState(users.find((user) => user.status === "active")?.id ?? "");
  const [error, setError] = useState("");
  const [pending,setPending]=useState<string|null>(null);
  const createUser = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    try { await onCreateUser(userName.trim()); setUserName(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建用户"); }
  };
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    try { await onCreateProject(userId, projectName.trim()); setProjectName(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建项目"); }
  };
  return <><header className="page-heading"><div><p className="eyebrow">下游访问</p><h1 tabIndex={-1}>用户与项目</h1><p>组织 API 密钥和任务归属，同时与上游订阅保持隔离。</p></div></header>{error && <p className="field-error" role="alert">{error}</p>}<div className="identity-layout"><section className="data-region"><h2>用户</h2><form className="inline-create" onSubmit={(event) => void createUser(event)}><label>用户名<input required value={userName} onChange={(event) => setUserName(event.target.value)} /></label><button disabled={!userName.trim()}>创建用户</button></form><div className="identity-list">{users.map((user) => <article key={user.id} className="identity-row"><div><strong>{user.name}</strong><code>{user.id}</code></div><span className={`status-pill status-${user.status === "active" ? "ready" : "unknown"}`}>{user.status}</span><button className="quiet-button" disabled={pending===user.id} onClick={() => {setPending(user.id);setError("");void onToggleUser(user).catch((c:unknown)=>setError(c instanceof Error?c.message:"无法更新用户")).finally(()=>setPending(null));}}>{user.status === "active" ? "禁用" : "启用"}</button></article>)}</div></section><section className="data-region"><h2>项目</h2><form className="inline-create" onSubmit={(event) => void createProject(event)}><label>所有者<select required value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">选择用户</option>{users.filter((user) => user.status === "active").map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label>项目名称<input required value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><button disabled={!userId || !projectName.trim()}>创建项目</button></form><div className="identity-list">{projects.map((project) => <article key={project.id} className="identity-row"><div><strong>{project.name}</strong><span>{users.find((user) => user.id === project.user_id)?.name ?? "未知用户"}</span><code>{project.id}</code></div><span className={`status-pill status-${project.status === "active" ? "ready" : "unknown"}`}>{project.status}</span><button className="quiet-button" disabled={pending===project.id} onClick={() => {setPending(project.id);setError("");void onToggleProject(project).catch((c:unknown)=>setError(c instanceof Error?c.message:"无法更新项目")).finally(()=>setPending(null));}}>{project.status === "active" ? "禁用" : "启用"}</button></article>)}</div></section></div></>;
}
