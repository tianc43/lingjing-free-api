import { useMemo, useState } from "react";
import type { Account, Job } from "../types";

export function TasksPage({ accounts, jobs }: { accounts: Account[]; jobs: Job[] }) {
  const [account, setAccount] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const filtered = useMemo(() => jobs.filter((job) => (!account || job.account_name === account) && (!kind || job.kind === kind) && (!status || job.status === status)), [account, jobs, kind, status]);
  const kinds = [...new Set(jobs.map((job) => job.kind))];
  const statuses = [...new Set(jobs.map((job) => job.status))];
  const stamp = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(value);
  return <><header className="page-heading"><div><p className="eyebrow">Bound work</p><h1>Tasks</h1></div></header><section className="data-region"><div className="filters"><label>Account filter<select value={account} onChange={(event) => setAccount(event.target.value)}><option value="">All accounts</option>{accounts.map((item) => <option key={item.id}>{item.name}</option>)}</select></label><label>Kind filter<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">All kinds</option><option value="image">image</option>{kinds.map((item) => item !== "image" && <option key={item}>{item}</option>)}</select></label><label>Status filter<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="queued">queued</option>{statuses.map((item) => item !== "queued" && <option key={item}>{item}</option>)}</select></label></div>{filtered.length === 0 ? <p className="empty-state">No tasks match these filters</p> : <table className="tasks-table"><thead><tr><th>Task</th><th>Account</th><th>Kind</th><th>Status</th><th>Budget</th><th>Created</th><th className="numeric">Points</th></tr></thead><tbody>{filtered.map((job) => <tr key={job.id}><td className="mono" data-label="Task">{job.id}</td><td data-label="Account">{job.account_name}</td><td data-label="Kind">{job.kind}</td><td data-label="Status">{job.status}</td><td data-label="Budget">{job.budget_state ?? "—"}</td><td className="mono" data-label="Created">{stamp(job.created_at)}</td><td className="numeric" data-label="Points">{job.quoted_points ?? "—"}</td></tr>)}</tbody></table>}</section></>;
}
