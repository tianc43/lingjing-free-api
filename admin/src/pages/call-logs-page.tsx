import { useEffect, useRef, useState } from "react";
import type { AdminApi } from "../api";
import type { CallLogDetail, CallLogFilters, CallLogPage, CallLogSummary } from "../types";

const time = (value: number | null) => value === null ? "—" : new Date(value).toLocaleString("zh-CN", { hour12: false });
const directionLabel = (value: CallLogSummary["direction"]) => value === "inbound" ? "调用方 → 本服务" : "本服务 → 灵境";
const duration = (value: number | null) => value === null ? "—" : `${value.toLocaleString("zh-CN")} ms`;

function CallStatus({ record }: { record: CallLogSummary }) {
  const label = record.status === "success" ? "成功" : record.status === "error" ? "失败" : "进行中";
  const style = record.status === "success" ? "ready" : record.status === "error" ? "unhealthy" : "unknown";
  return <span className={`status-pill status-${style}`}>{label}{record.status_code === null ? "" : ` · ${record.status_code}`}</span>;
}

function Payload({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  const text = value === null || value === undefined ? "无正文" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const truncated = typeof value === "object" && value !== null && "__truncated" in value && value.__truncated === true;
  return <details className="call-payload" open={open}><summary>{title}{truncated && <span>（已截断）</span>}</summary><pre>{text}</pre></details>;
}

function CallDetail({ api, id, onSelect, onClose }: { api: AdminApi; id: string; onSelect(id: string): void; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [detail, setDetail] = useState<CallLogDetail | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); trigger.current?.focus(); };
  }, []);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError("");
    void api.callLog(id).then(value => { if (active) setDetail(value); }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "无法加载调用详情");
    });
    return () => { active = false; };
  }, [api, id, revision]);
  const record = detail?.record;
  const related = detail?.related.filter(item => item.id !== record?.id) ?? [];
  return <dialog ref={dialogRef} className="dialog call-detail" aria-labelledby="call-detail-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id="call-detail-title">调用详情</h2><button className="icon-button" aria-label="关闭调用详情" onClick={onClose}>×</button></header>
    {error ? <div className="retry-state" role="alert"><p>{error}</p><button onClick={() => setRevision(value => value + 1)}>重试详情</button></div> : record === undefined ? <p role="status">正在加载调用详情…</p> : <>
      <p className="call-endpoint mono">{record.method} {record.path}</p>
      <dl className="call-facts">
        <div><dt>方向</dt><dd>{directionLabel(record.direction)}</dd></div>
        <div><dt>结果 / HTTP 状态</dt><dd><CallStatus record={record} /></dd></div>
        <div><dt>开始时间</dt><dd>{time(record.started_at)}</dd></div>
        <div><dt>结束时间</dt><dd>{time(record.finished_at)}</dd></div>
        <div><dt>耗时</dt><dd className="mono">{duration(record.duration_ms)}</dd></div>
        <div><dt>调用 ID</dt><dd className="mono">{record.id}</dd></div>
        <div><dt>Trace ID</dt><dd className="mono">{record.trace_id}</dd></div>
        <div><dt>父调用 ID</dt><dd className="mono">{record.parent_id ?? "—"}</dd></div>
        <div><dt>关联任务</dt><dd className="mono">{record.job_id ?? "—"}</dd></div>
        <div><dt>上游账号</dt><dd className="mono">{record.account_id ?? "—"}</dd></div>
      </dl>
      {(record.error_code !== null || record.error_message !== null) && <div className="call-error" role="note"><strong>错误信息</strong><p>{record.error_code}</p><p>{record.error_message}</p></div>}
      <section className="call-payloads" aria-label="输入输出">
        <Payload title="请求输入" value={record.request_body} open />
        <Payload title="响应输出" value={record.response_body} open />
        <Payload title="请求头" value={record.request_headers} />
        <Payload title="响应头" value={record.response_headers} />
      </section>
      <section className="call-related"><h3>关联上下游调用</h3><p>查看同一链路中的调用。</p>{related.length === 0 ? <p className="empty-state">暂无其他关联调用。</p> : <ul>{related.map(item => <li key={item.id}><button className="quiet-button" onClick={() => onSelect(item.id)}><span>{directionLabel(item.direction)}</span><code>{item.method} {item.path}</code><span>{time(item.started_at)} · {duration(item.duration_ms)}</span><CallStatus record={item} /></button></li>)}</ul>}</section>
    </>}
  </dialog>;
}

export function CallLogsPage({ api }: { api: AdminApi }) {
  const [direction, setDirection] = useState<"" | "inbound" | "outbound">("");
  const [status, setStatus] = useState<"" | "success" | "error" | "pending">("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CallLogFilters>({ page: 1, page_size: 25 });
  const [data, setData] = useState<CallLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api.callLogs(filters).then(value => { if (active) setData(value); }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "无法加载 API 调用记录");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, filters, revision]);
  const page = data?.page ?? filters.page ?? 1;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.page_size ?? 25)));
  return <>
    <header className="page-heading"><div><p className="eyebrow">请求链路</p><h1 tabIndex={-1}>API 调用记录</h1><p>查看调用方访问本服务，以及本服务请求灵境官方的输入、输出和结果。</p></div><button className="quiet-button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? "正在加载…" : "刷新记录"}</button></header>
    <section className="data-region">
      <form className="filters call-filters" onSubmit={event => { event.preventDefault(); setFilters({ ...(direction ? { direction } : {}), ...(status ? { status } : {}), ...(search.trim() ? { search: search.trim() } : {}), page: 1, page_size: 25 }); }}>
        <label>调用方向<select value={direction} onChange={event => setDirection(event.target.value as typeof direction)}><option value="">全部方向</option><option value="inbound">调用方 → 本服务</option><option value="outbound">本服务 → 灵境</option></select></label>
        <label>调用结果<select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="">全部结果</option><option value="success">成功</option><option value="error">失败</option><option value="pending">进行中</option></select></label>
        <label className="call-search">搜索<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="路径、Trace ID、任务或错误码" /></label>
        <button type="submit" disabled={loading}>查询</button>
      </form>
      {data !== null && <p className="call-retention">共 {data.total.toLocaleString("zh-CN")} 条记录 · 最多保留 {data.retention.days} 天 / {data.retention.max_records.toLocaleString("zh-CN")} 条。凭据和签名已脱敏，单段正文超过 {data.retention.max_body_chars.toLocaleString("zh-CN")} 字符会截断。</p>}
      {error && <div className="retry-state" role="alert"><p>{error}</p><button onClick={() => setRevision(value => value + 1)}>重试</button></div>}
      <div aria-busy={loading}>
        {loading && <p role="status">正在加载调用记录…</p>}
        {!error && data !== null && (data.items.length === 0 ? <p className="empty-state">暂无符合条件的调用记录。新调用完成后可刷新查看。</p> : <table className="tasks-table call-table"><thead><tr><th>开始时间</th><th>方向</th><th>请求</th><th>结果</th><th className="numeric">耗时</th><th>Trace ID</th><th>详情</th></tr></thead><tbody>{data.items.map(record => <tr key={record.id}>
          <td data-label="开始时间">{time(record.started_at)}</td>
          <td data-label="方向">{directionLabel(record.direction)}</td>
          <td data-label="请求" className="call-route"><strong className="mono">{record.method}</strong><span title={record.path}>{record.path}</span></td>
          <td data-label="结果"><CallStatus record={record} />{record.error_code !== null && <span className="call-error-code" title={record.error_code}>{record.error_code}</span>}</td>
          <td data-label="耗时" className="numeric">{duration(record.duration_ms)}</td>
          <td data-label="Trace ID" className="mono" title={record.trace_id}>{record.trace_id}</td>
          <td data-label="详情"><button className="quiet-button" aria-label={`查看调用 ${record.id}`} onClick={() => setSelectedId(record.id)}>查看</button></td>
        </tr>)}</tbody></table>)}
      </div>
      {data !== null && !error && <nav className="call-pagination" aria-label="调用记录分页"><span aria-live="polite">第 {page} / {pages} 页</span><div><button className="quiet-button" disabled={loading || page <= 1} onClick={() => setFilters(current => ({ ...current, page: page - 1 }))}>上一页</button><button className="quiet-button" disabled={loading || page >= pages} onClick={() => setFilters(current => ({ ...current, page: page + 1 }))}>下一页</button></div></nav>}
    </section>
    {selectedId !== null && <CallDetail api={api} id={selectedId} onSelect={setSelectedId} onClose={() => setSelectedId(null)} />}
  </>;
}
