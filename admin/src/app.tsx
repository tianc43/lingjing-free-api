import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminApi } from "./api";
import { AccountDialog } from "./components/account-dialog";
import { AppShell, type PageName } from "./components/app-shell";
import { AccountsPage } from "./pages/accounts-page";
import { LoginPage } from "./pages/login-page";
import { OverviewPage } from "./pages/overview-page";
import { SettingsPage } from "./pages/settings-page";
import { TasksPage } from "./pages/tasks-page";
import type { Account, AccountInput, Job, Overview, Settings } from "./types";

type ResourceName = "accounts" | "overview" | "jobs" | "settings";
type ResourceErrors = Partial<Record<ResourceName, string>>;
type ResourceLoading = Record<ResourceName, boolean>;

function pageFromPath(): PageName {
  const value = location.pathname.replace(/^\/admin\/?/, "");
  return value === "accounts" || value === "tasks" || value === "settings" ? value : "overview";
}

function Skeleton() {
  return <div className="skeleton" aria-live="polite">Loading operational data…</div>;
}

function ResourceFailure({ error, onRetry }: { error: string | undefined; onRetry: () => void }) {
  if (error === undefined) return null;
  return <section className="retry-state" role="alert"><p>{error}</p><button onClick={onRetry}>Retry</button></section>;
}

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [page, setPage] = useState<PageName>(pageFromPath());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [resourceLoading, setResourceLoading] = useState<ResourceLoading>({ accounts: false, overview: false, jobs: false, settings: false });
  const [resourceErrors, setResourceErrors] = useState<ResourceErrors>({});
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Account | null | undefined>(undefined);
  const [loginCommand, setLoginCommand] = useState("");
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const api = useMemo(() => new AdminApi(() => {
    setAuthenticated(false);
    setError("Your administrator session expired. Sign in again.");
  }), []);

  const runResource = useCallback(async <T,>(name: ResourceName, request: () => Promise<T>, save: (value: T) => void) => {
    setResourceLoading((current) => ({ ...current, [name]: true }));
    setResourceErrors((current) => ({ ...current, [name]: undefined }));
    try {
      save(await request());
    } catch (cause) {
      setResourceErrors((current) => ({ ...current, [name]: cause instanceof Error ? cause.message : `Could not load ${name}` }));
    } finally {
      setResourceLoading((current) => ({ ...current, [name]: false }));
    }
  }, []);
  const loadAccounts = useCallback(() => runResource("accounts", () => api.accounts(), setAccounts), [api, runResource]);
  const loadOverview = useCallback(() => runResource("overview", () => api.overview(), setOverview), [api, runResource]);
  const loadJobs = useCallback(() => runResource("jobs", () => api.jobs(), setJobs), [api, runResource]);
  const loadSettings = useCallback(() => runResource("settings", () => api.settings(), setSettings), [api, runResource]);
  const load = useCallback(async () => {
    await Promise.all([loadAccounts(), loadOverview(), loadJobs(), loadSettings()]);
  }, [loadAccounts, loadJobs, loadOverview, loadSettings]);

  useEffect(() => {
    void api.session().then(async (ready) => {
      setAuthenticated(ready);
      if (ready) await load();
      setInitializing(false);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not check session");
      setInitializing(false);
    });
  }, [api, load]);
  const navigate = (next: PageName) => {
    setError(null);
    history.pushState({}, "", `/admin/${next === "overview" ? "" : next}`);
    setPage(next);
  };
  useEffect(() => {
    const listener = () => { setError(null); setPage(pageFromPath()); };
    addEventListener("popstate", listener);
    return () => removeEventListener("popstate", listener);
  }, []);
  const login = async (password: string) => {
    setError(null);
    try {
      await api.login(password);
      setError(null);
      history.replaceState({}, "", "/admin/accounts");
      setPage("accounts");
      setAuthenticated(true);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    }
  };
  const save = async (input: AccountInput) => {
    if (dialog === null) {
      const result = await api.createAccount(input);
      setLoginCommand(result.login_command);
    } else if (dialog !== undefined) {
      await api.updateAccount(dialog.id, input);
    }
    setError(null);
    setDialog(undefined);
    await load();
  };
  const toggle = async (account: Account) => {
    if (account.enabled && account.active_jobs > 0 && !window.confirm(`Disable ${account.name}? ${account.active_jobs} active jobs will continue but no new jobs can start.`)) return;
    try {
      await api.setEnabled(account, !account.enabled);
      setError(null);
      await loadAccounts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update account");
    }
  };
  const check = async (account: Account) => {
    setChecking(account.id);
    try {
      await api.checkAccount(account.id);
      setError(null);
      setNotice(`Health check completed for ${account.name}`);
      await loadAccounts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Health check failed");
    } finally {
      setChecking(null);
    }
  };
  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(loginCommand);
      setError(null);
      setNotice("Login command copied");
    } catch {
      setNotice("");
      setError("Could not copy the login command. Copy it manually.");
    }
  };
  const logout = () => void api.logout().finally(() => {
    setAuthenticated(false);
    setError(null);
    setNotice("");
    setLoginCommand("");
  });
  if (!authenticated) return <LoginPage onLogin={login} error={error} />;
  if (initializing) return <Skeleton />;

  const pageContent = page === "overview"
    ? <><ResourceFailure error={resourceErrors.overview} onRetry={() => void loadOverview()} />{overview === null && resourceLoading.overview ? <Skeleton /> : overview !== null && <OverviewPage overview={overview} />}</>
    : page === "accounts"
      ? <><ResourceFailure error={resourceErrors.accounts} onRetry={() => void loadAccounts()} />{resourceLoading.accounts && accounts.length === 0 ? <Skeleton /> : <AccountsPage accounts={accounts} onCreate={() => setDialog(null)} onEdit={setDialog} onToggle={(account) => void toggle(account)} onCheck={(account) => void check(account)} checking={checking} />}</>
    : page === "tasks"
        ? <><ResourceFailure error={resourceErrors.jobs} onRetry={() => void loadJobs()} />{resourceLoading.jobs && jobs.length === 0 ? <Skeleton /> : <TasksPage accounts={accounts} jobs={jobs} />}</>
        : <><ResourceFailure error={resourceErrors.settings} onRetry={() => void loadSettings()} />{settings === null && resourceLoading.settings ? <Skeleton /> : settings !== null && <SettingsPage accounts={accounts} settings={settings} />}</>;

  return <AppShell page={page} onNavigate={navigate} onLogout={logout}>
    {error !== null && <section className="retry-state" role="alert"><p>{error}</p></section>}
    {loginCommand && <aside className="command-notice" aria-live="polite"><code>{loginCommand}</code><button aria-label="Copy login command" className="quiet-button" onClick={() => void copyCommand()}>Copy</button><span>{notice}</span></aside>}
    {!loginCommand && notice && <p className="command-notice" aria-live="polite">{notice}</p>}
    {pageContent}
    {dialog !== undefined && <AccountDialog account={dialog} onClose={() => setDialog(undefined)} onSave={save} />}
  </AppShell>;
}
