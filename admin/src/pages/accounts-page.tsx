import type { Account, AccountSignInStatus, SignInStatus } from "../types";
import { BudgetMeter } from "../components/budget-meter";
import { StatusPill } from "../components/status-pill";

function refreshedAt(value: number | null): string {
  return value === null ? "尚未刷新" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

const signInLabels: Record<AccountSignInStatus, string> = {
  checking: "正在检查",
  signed: "本次签到成功",
  already_signed: "今日已签到",
  no_active_activity: "暂无签到活动",
  unknown: "状态待确认",
  failed: "检查失败"
};

export function AccountsPage({ accounts, signInStatus, onCreate, onEdit, onToggle, onCheck,onLogin, checking,loggingIn }: { accounts: Account[]; signInStatus: SignInStatus | null; onCreate(): void; onEdit(account: Account): void; onToggle(account: Account): void; onCheck(account: Account): void;onLogin(account:Account):void; checking: string | null;loggingIn:string|null }) {
  const checks = new Map(signInStatus?.accounts.map((check) => [check.account_id, check]));
  const schedulerLabel = signInStatus === null
    ? "正在读取"
    : !signInStatus.enabled
      ? "未启用"
      : signInStatus.running
        ? "正在检查"
        : "已启用 · 每小时检查";
  return <><header className="page-heading"><div><p className="eyebrow">工作队列</p><h1>账号</h1><p>钱包余额、运行预算与每日签到统一管理。</p></div><button onClick={onCreate}>添加账号</button></header><section className="sign-in-overview" aria-label="自动签到状态" aria-live="polite"><div><strong>自动签到</strong><span>{schedulerLabel}</span></div><dl><div><dt>上次检查</dt><dd>{refreshedAt(signInStatus?.last_run_finished_at ?? null)}</dd></div><div><dt>下次检查</dt><dd>{refreshedAt(signInStatus?.next_check_at ?? null)}</dd></div></dl></section><section className="data-region accounts-region" aria-busy={signInStatus?.running ?? false}>{accounts.length === 0 ? <p className="empty-state">暂无账号。请添加第一个账号以开始使用。</p> : <div className="account-list">{accounts.map((account) => { const signIn = checks.get(account.id); return <article className="account-row" key={account.id}><div className="account-name"><strong>{account.name}</strong><span className="mono">{account.id}</span><StatusPill status={account.health_status} /></div><div className="balance-facts"><span>{account.membership ?? "暂无会员信息"}</span><strong>点数 {account.points_balance ?? "—"}</strong><strong>总余额 {account.total_balance ?? "—"}</strong><span>上次刷新 {refreshedAt(account.last_checked_at)}</span></div><BudgetMeter label="每日" used={account.daily_used_points} reserved={account.daily_reserved_points} limit={account.daily_point_limit} /><BudgetMeter label="每月" used={account.monthly_used_points} reserved={account.monthly_reserved_points} limit={account.monthly_point_limit} /><div className="account-meta"><strong className={`sign-in-state sign-in-${signIn?.status ?? "pending"}`}>签到：{account.enabled ? signIn === undefined ? "尚未检查" : signInLabels[signIn.status] : "账号已禁用"}</strong>{signIn?.current_frequency !== null && signIn?.current_frequency !== undefined && <span>当前连续 {signIn.current_frequency} 天</span>}<span>优先级 {account.priority} · {account.active_jobs} 个活跃任务</span></div><div className="row-actions"><button className="quiet-button" aria-label={`登录 ${account.name}`} disabled={loggingIn===account.id} onClick={()=>onLogin(account)}>{loggingIn===account.id?"等待浏览器登录…":account.has_session?"重新登录":"在浏览器中登录"}</button><button className="quiet-button" aria-label={`刷新余额 ${account.name}`} disabled={checking === account.id} onClick={() => onCheck(account)}>{checking === account.id ? "正在刷新…" : "刷新余额"}</button><button className="quiet-button" aria-label={`编辑 ${account.name}`} onClick={() => onEdit(account)}>编辑</button><button className={account.enabled ? "danger-button" : "quiet-button"} aria-label={`${account.enabled ? "禁用" : "启用"} ${account.name}`} onClick={() => onToggle(account)}>{account.enabled ? "禁用" : "启用"}</button><span className="enabled-label">{account.enabled ? "已启用" : "已禁用"}</span></div></article>; })}</div>}</section></>;
}
