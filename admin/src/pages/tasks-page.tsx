import { useMemo, useState } from "react";
import type { Account, Job } from "../types";

function TaskState({ job }: { job: Job }) {
  const upstream = job.upstream;
  const unavailable = upstream?.state === "unavailable";
  const checked = upstream?.checked_at === undefined ? undefined : new Date(upstream.checked_at).toLocaleString("zh-CN", { hour12: false });
  const taskStatus = upstream?.state === "verified" ? upstream.task_status : undefined;
  const official = unavailable ? "官方状态暂不可核对" : taskStatus === "0" ? "官方生成中" : taskStatus === "1" ? job.status === "processing" ? "官方已完成，等待输出" : "官方已完成" : taskStatus === "2" ? "官方任务失败" : undefined;
  const message = upstream?.vendor?.message ?? job.error_message ?? upstream?.message;
  const code = upstream?.vendor?.error_code ?? upstream?.business_code ?? job.error_code;
  return <><span>{job.status}</span>{official && <span className="call-official-status">{official}</span>}{checked && <span className="call-error-code">核验时间：{checked}</span>}{message && <span className="task-error-message">{message}</span>}{code && <span className="call-error-code mono">{code}</span>}{upstream?.request_id && <span className="call-error-code mono" title={upstream.request_id}>官方请求：{upstream.request_id}</span>}{job.upstream_task_id && <span className="call-error-code mono">官方任务：{job.upstream_task_id}</span>}</>;
}

export function TasksPage({ accounts, jobs }: { accounts: Account[]; jobs: Job[] }) {
  const [account, setAccount] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const filtered = useMemo(() => jobs.filter((job) => (!account || job.account_name === account) && (!kind || job.kind === kind) && (!status || job.status === status)), [account, jobs, kind, status]);
  const kinds = [...new Set(jobs.map((job) => job.kind))];
  const statuses = [...new Set(jobs.map((job) => job.status))];
  const stamp = (value: number) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(value);
  return <><header className="page-heading"><div><p className="eyebrow">已绑定任务</p><h1>任务</h1><p>本地任务状态与最近一次官方核验分别显示；账号就绪不代表所有模型都可生成。</p></div></header><section className="data-region"><div className="filters"><label>账号筛选<select value={account} onChange={(event) => setAccount(event.target.value)}><option value="">全部账号</option>{accounts.map((item) => <option key={item.id}>{item.name}</option>)}</select></label><label>类型筛选<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option><option value="image">图像</option>{kinds.map((item) => item !== "image" && <option key={item}>{item}</option>)}</select></label><label>状态筛选<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="queued">queued</option>{statuses.map((item) => item !== "queued" && <option key={item}>{item}</option>)}</select></label></div>{filtered.length === 0 ? <p className="empty-state">没有符合当前筛选条件的任务</p> : <table className="tasks-table"><thead><tr><th>任务</th><th>账号</th><th>类型</th><th>状态</th><th>预算</th><th>创建时间</th><th className="numeric">点数</th></tr></thead><tbody>{filtered.map((job) => <tr key={job.id}><td className="mono" data-label="任务">{job.id}</td><td data-label="账号">{job.account_name}</td><td data-label="类型">{job.kind}</td><td data-label="状态"><TaskState job={job} /></td><td data-label="预算">{job.budget_state ?? "—"}</td><td className="mono" data-label="创建时间">{stamp(job.created_at)}</td><td className="numeric" data-label="点数">{job.quoted_points ?? "—"}</td></tr>)}</tbody></table>}</section></>;
}
