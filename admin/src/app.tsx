import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminApi, ApiError } from "./api";
import { AccountDialog } from "./components/account-dialog";
import { AppShell, type PageName } from "./components/app-shell";
import { AccountsPage } from "./pages/accounts-page";
import { LoginPage } from "./pages/login-page";
import { OverviewPage } from "./pages/overview-page";
import { SettingsPage } from "./pages/settings-page";
import { TasksPage } from "./pages/tasks-page";
import type { Account, AccountInput, Job, Overview, Settings } from "./types";

function pageFromPath(): PageName {
  const value = location.pathname.replace(/^\/admin\/?/, "");
  return value === "accounts" || value === "tasks" || value === "settings" ? value : "overview";
}

function Skeleton() { return <div className="skeleton" aria-live="polite">Loading operational data…</div>; }

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [page, setPage] = useState<PageName>(pageFromPath());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Account | null | undefined>(undefined);
  const [loginCommand, setLoginCommand] = useState("");
  const [notice, setNotice] = useState("");
  const api = useMemo(() => new AdminApi(() => { setAuthenticated(false); setError("Your administrator session expired. Sign in again."); }), []);
  const load = useCallback(async () => { setLoading(true); setError(null); try { const [nextAccounts, nextOverview, nextJobs, nextSettings] = await Promise.all([api.accounts(), api.overview(), api.jobs(), api.settings()]); setAccounts(nextAccounts); setOverview(nextOverview); setJobs(nextJobs); setSettings(nextSettings); } catch (cause) { if (!(cause instanceof ApiError && cause.status === 401)) setError(cause instanceof Error ? cause.message : "Could not load operational data"); } finally { setLoading(false); } }, [api]);
  useEffect(() => { void api.session().then((ready) => { setAuthenticated(ready); if (ready) void load(); else setLoading(false); }).catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Could not check session"); setLoading(false); }); }, [api, load]);
  const navigate = (next: PageName) => { history.pushState({}, "", `/admin/${next === "overview" ? "" : next}`); setPage(next); };
  useEffect(() => { const listener = () => setPage(pageFromPath()); addEventListener("popstate", listener); return () => removeEventListener("popstate", listener); }, []);
  const login = async (password: string) => { try { await api.login(password); setAuthenticated(true); setPage("accounts"); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign in failed"); } };
  const save = async (input: AccountInput) => { if (dialog === null) { const result = await api.createAccount(input); setLoginCommand(result.login_command); } else if (dialog !== undefined) await api.updateAccount(dialog.id, input); setDialog(undefined); await load(); };
  const toggle = async (account: Account) => { if (account.enabled && account.active_jobs > 0 && !window.confirm(`Disable ${account.name}? ${account.active_jobs} active jobs will continue but no new jobs can start.`)) return; try { await api.setEnabled(account, !account.enabled); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update account"); } };
  const copyCommand = async () => { await navigator.clipboard?.writeText(loginCommand).catch(() => undefined); setNotice("Login command copied"); };
  if (!authenticated) return <LoginPage onLogin={login} error={error} />;
  let content = loading ? <Skeleton /> : error ? <section className="retry-state" role="alert"><p>{error}</p><button onClick={() => void load()}>Retry</button></section> : null;
  if (content === null && overview !== null && settings !== null) { if (page === "overview") content = <OverviewPage overview={overview} />; if (page === "accounts") content = <AccountsPage accounts={accounts} onCreate={() => setDialog(null)} onEdit={setDialog} onToggle={(account) => void toggle(account)} />; if (page === "tasks") content = <TasksPage accounts={accounts} jobs={jobs} />; if (page === "settings") content = <SettingsPage accounts={accounts} settings={settings} />; }
  return <AppShell page={page} onNavigate={navigate} onLogout={() => void api.logout().finally(() => setAuthenticated(false))}>{loginCommand && <aside className="command-notice" aria-live="polite"><code>{loginCommand}</code><button aria-label="Copy login command" className="quiet-button" onClick={() => void copyCommand()}>Copy</button><span>{notice}</span></aside>}{content}{dialog !== undefined && <AccountDialog account={dialog} onClose={() => setDialog(undefined)} onSave={save} />}</AppShell>;
}
