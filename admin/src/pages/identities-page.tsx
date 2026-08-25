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
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create user"); }
  };
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault(); setError("");
    try { await onCreateProject(userId, projectName.trim()); setProjectName(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create project"); }
  };
  return <><header className="page-heading"><div><p className="eyebrow">Downstream access</p><h1 tabIndex={-1}>Users & projects</h1><p>Organize API keys and task ownership without mixing upstream subscriptions.</p></div></header>{error && <p className="field-error" role="alert">{error}</p>}<div className="identity-layout"><section className="data-region"><h2>Users</h2><form className="inline-create" onSubmit={(event) => void createUser(event)}><label>User name<input required value={userName} onChange={(event) => setUserName(event.target.value)} /></label><button disabled={!userName.trim()}>Create user</button></form><div className="identity-list">{users.map((user) => <article key={user.id} className="identity-row"><div><strong>{user.name}</strong><code>{user.id}</code></div><span className={`status-pill status-${user.status === "active" ? "ready" : "unknown"}`}>{user.status}</span><button className="quiet-button" disabled={pending===user.id} onClick={() => {setPending(user.id);setError("");void onToggleUser(user).catch((c:unknown)=>setError(c instanceof Error?c.message:"Could not update user")).finally(()=>setPending(null));}}>{user.status === "active" ? "Disable" : "Enable"}</button></article>)}</div></section><section className="data-region"><h2>Projects</h2><form className="inline-create" onSubmit={(event) => void createProject(event)}><label>Owner<select required value={userId} onChange={(event) => setUserId(event.target.value)}><option value="">Choose user</option>{users.filter((user) => user.status === "active").map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label><label>Project name<input required value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><button disabled={!userId || !projectName.trim()}>Create project</button></form><div className="identity-list">{projects.map((project) => <article key={project.id} className="identity-row"><div><strong>{project.name}</strong><span>{users.find((user) => user.id === project.user_id)?.name ?? "Unknown user"}</span><code>{project.id}</code></div><span className={`status-pill status-${project.status === "active" ? "ready" : "unknown"}`}>{project.status}</span><button className="quiet-button" disabled={pending===project.id} onClick={() => {setPending(project.id);setError("");void onToggleProject(project).catch((c:unknown)=>setError(c instanceof Error?c.message:"Could not update project")).finally(()=>setPending(null));}}>{project.status === "active" ? "Disable" : "Enable"}</button></article>)}</div></section></div></>;
}
