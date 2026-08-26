import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AdminApi } from "./api";
import { AccountDialog } from "./components/account-dialog";
import { AccountOnboardingDialog } from "./components/account-onboarding-dialog";
import { ApiKeyDialog } from "./components/api-key-dialog";
import { AppShell, type PageName } from "./components/app-shell";
import { AccountsPage } from "./pages/accounts-page";
import type { CreateKeyInput } from "./pages/api-access-page";
import { LoginPage } from "./pages/login-page";
import { OverviewPage } from "./pages/overview-page";
import { SettingsPage } from "./pages/settings-page";
import { TasksPage } from "./pages/tasks-page";
const ApiAccessPage=lazy(()=>import("./pages/api-access-page").then(module=>({default:module.ApiAccessPage})));
const IdentitiesPage=lazy(()=>import("./pages/identities-page").then(module=>({default:module.IdentitiesPage})));
const PlansPage=lazy(()=>import("./pages/plans-page").then(module=>({default:module.PlansPage})));
const PlaygroundPage=lazy(()=>import("./pages/playground-page").then(module=>({default:module.PlaygroundPage})));
const UsagePage=lazy(()=>import("./pages/usage-page").then(module=>({default:module.UsagePage})));
const WebhooksPage=lazy(()=>import("./pages/webhooks-page").then(module=>({default:module.WebhooksPage})));
import type { Account, AccountImportInput, AccountInput, ApiKey, Job, Overview, Plan, Project, Settings, UsageData, User, WebhookDelivery, WebhookEndpoint } from "./types";

type ResourceName = "accounts" | "overview" | "jobs" | "settings" | "apiKeys" | "identities" | "plans" | "usage" | "webhooks";
type ResourceErrors = Partial<Record<ResourceName, string>>;
type ResourceLoading = Record<ResourceName, boolean>;

function pageFromPath(): PageName {
  const value = location.pathname.replace(/^\/admin\/?/, "");
  return value === "accounts" || value === "identities" || value === "playground" || value === "tasks" || value === "plans" || value === "usage" || value === "webhooks" || value === "api-access" || value === "settings" ? value : "overview";
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
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [webhookDeliveries,setWebhookDeliveries]=useState<WebhookDelivery[]>([]);
  const [webhooks,setWebhooks]=useState<WebhookEndpoint[]>([]);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [apiKeySecret, setApiKeySecret] = useState<string | null>(null);
  const [resourceLoading, setResourceLoading] = useState<ResourceLoading>({ accounts: false, overview: false, jobs: false, settings: false, apiKeys: false, identities: false, plans: false, usage: false, webhooks: false });
  const [resourceErrors, setResourceErrors] = useState<ResourceErrors>({});
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Account | undefined>(undefined);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [checking,setChecking]=useState<string|null>(null);const[loggingIn,setLoggingIn]=useState<string|null>(null);
  const api = useMemo(() => new AdminApi(() => {
    setAuthenticated(false);
    setApiKeySecret(null);
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
  const loadApiKeys = useCallback(() => runResource("apiKeys", () => api.apiKeys(), setApiKeys), [api, runResource]);
  const loadWebhooks=useCallback(()=>runResource("webhooks",async()=>{const [endpoints,deliveries]=await Promise.all([api.webhooks(),api.webhookDeliveries()]);return{endpoints,deliveries};},value=>{setWebhooks(value.endpoints);setWebhookDeliveries(value.deliveries);}),[api,runResource]);
  const loadPlans = useCallback(() => runResource("plans", () => api.plans(), setPlans), [api, runResource]);
  const loadUsage = useCallback((filters: { user_id?:string; project_id?:string } = {}) => runResource("usage", () => api.usage(filters), setUsage), [api, runResource]);
  const loadIdentities = useCallback(() => runResource("identities", async () => {
    const [nextUsers, nextProjects] = await Promise.all([api.users(), api.projects()]);
    return { users: nextUsers, projects: nextProjects };
  }, (value) => { setUsers(value.users); setProjects(value.projects); }), [api, runResource]);
  const load = useCallback(async () => {
    await Promise.all([loadAccounts(), loadOverview(), loadJobs(), loadSettings(), loadApiKeys(), loadIdentities(), loadPlans(), loadUsage(), loadWebhooks()]);
  }, [loadAccounts, loadApiKeys, loadIdentities, loadJobs, loadPlans, loadUsage, loadWebhooks, loadOverview, loadSettings]);

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
  const focusPageHeading = () => requestAnimationFrame(() => {
    const heading=document.querySelector<HTMLElement>("main h1");
    if(heading!==null){heading.tabIndex=-1;heading.focus();}
  });
  const navigate = (next: PageName) => {
    setError(null);
    setApiKeySecret(null);
    history.pushState({}, "", `/admin/${next === "overview" ? "" : next}`);
    document.title = `${next === "api-access" ? "API keys" : next[0]?.toUpperCase()}${next === "api-access" ? "" : next.slice(1)} · Lingjing Operator`;
    setPage(next);
    focusPageHeading();
  };
  useEffect(() => {
    const listener = () => { setError(null); setApiKeySecret(null); const next=pageFromPath();setPage(next);document.title=`${next} · Lingjing Operator`;focusPageHeading(); };
    addEventListener("popstate", listener);
    return () => removeEventListener("popstate", listener);
  }, []);
  const login = async (password: string) => {
    setError(null);
    try {
      await api.login(password);
      setError(null);
      setApiKeySecret(null);
      history.replaceState({}, "", "/admin/accounts");
      setPage("accounts");
      setAuthenticated(true);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
    }
  };
  const save = async (input: AccountInput) => {
    if (dialog !== undefined) {
      await api.updateAccount(dialog.id, input);
    }
    setError(null);
    setDialog(undefined);
    await load();
  };
  const importAccount = async (input: AccountImportInput) => {
    await api.importAccount(input);
    setError(null);
    setOnboardingOpen(false);
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
      setNotice(`Balance refreshed for ${account.name}`);
      await loadAccounts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Balance refresh failed");
    } finally {
      setChecking(null);
    }
  };
  const browserLogin=async(account:Account)=>{setLoggingIn(account.id);setError(null);try{const started=await api.startBrowserLogin(account.id);setNotice("Browser opened. Complete Lingjing login in that window.");for(let attempt=0;attempt<600;attempt++){await new Promise(resolve=>setTimeout(resolve,1000));const status=await api.browserLogin(started.id);if(status.status==="completed"){setNotice(`Credentials refreshed for ${account.name}`);await loadAccounts();return;}if(status.status==="failed")throw new Error(status.error??"Browser login failed");}throw new Error("Browser login timed out");}catch(cause){setError(cause instanceof Error?cause.message:"Browser login failed");}finally{setLoggingIn(null);}};
  const createApiKey = async (input: CreateKeyInput) => {
    const created = await api.createApiKey(input);
    setApiKeys((current) => [...current, created.key]);
    setApiKeySecret(created.api_key);
  };
  const toggleApiKey = async (key: ApiKey) => {
    try {
      const updated = await api.setApiKeyEnabled(key, !key.enabled);
      setApiKeys((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update API key");
    }
  };
  const revokeApiKey = async (key: ApiKey) => {
    if (!window.confirm(`Permanently revoke ${key.name}? This cannot be undone.`)) return;
    try {
      const updated = await api.revokeApiKey(key);
      setApiKeys((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke API key");
    }
  };
  const configureWebhook=async(projectId:string,url:string)=>{const endpoint=await api.configureWebhook(projectId,url);await loadWebhooks();return endpoint;};
  const replayWebhook=async(id:string)=>{await api.replayWebhook(id);await loadWebhooks();};
  const toggleWebhook=async(endpoint:WebhookEndpoint)=>{await api.setWebhookEnabled(endpoint.id,!endpoint.enabled);await loadWebhooks();};
  const createPlan = async (input: Omit<Plan,"id"|"created_at"|"updated_at">) => { await api.createPlan(input); await loadPlans(); };
  const assignPlan = async (projectId:string,planId:string) => { await api.assignPlan(projectId,planId); setNotice("Plan assigned to project"); };
  const createUser = async (name: string) => { await api.createUser(name); await loadIdentities(); };
  const createProject = async (userId: string, name: string) => { await api.createProject(userId, name); await loadIdentities(); };
  const toggleUser = async (user: User) => { await api.setUserStatus(user.id, user.status === "active" ? "disabled" : "active"); await loadIdentities(); };
  const toggleProject = async (project: Project) => { await api.setProjectStatus(project.id, project.status === "active" ? "disabled" : "active"); await Promise.all([loadIdentities(), loadApiKeys()]); };
  const logout = () => void api.logout().finally(() => {
    setAuthenticated(false);
    setApiKeySecret(null);
    setError(null);
    setNotice("");
  });
  if (initializing) return <Skeleton />;
  if (!authenticated) return <LoginPage onLogin={login} error={error} />;

  const pageContent = page === "overview"
    ? <><ResourceFailure error={resourceErrors.overview} onRetry={() => void loadOverview()} />{overview === null && resourceLoading.overview ? <Skeleton /> : overview !== null && <OverviewPage overview={overview} />}</>
    : page === "accounts"
      ? <><ResourceFailure error={resourceErrors.accounts} onRetry={() => void loadAccounts()} />{resourceLoading.accounts && accounts.length === 0 ? <Skeleton /> : <AccountsPage accounts={accounts} onCreate={() => setOnboardingOpen(true)} onEdit={setDialog} onToggle={(account) => void toggle(account)} onCheck={(account)=>void check(account)} onLogin={(account)=>void browserLogin(account)} checking={checking} loggingIn={loggingIn} />}</>
    : page === "identities"
      ? <><ResourceFailure error={resourceErrors.identities} onRetry={() => void loadIdentities()} />{resourceLoading.identities && users.length === 0 ? <Skeleton /> : <IdentitiesPage users={users} projects={projects} onCreateUser={createUser} onCreateProject={createProject} onToggleUser={toggleUser} onToggleProject={toggleProject} />}</>
    : page === "playground"
      ? <PlaygroundPage loadModels={(kind, refresh) => api.playgroundModels(kind, refresh)} run={(input) => api.runPlayground(input)} getJob={(id) => api.job(id)} />
    : page === "webhooks"
      ? <><ResourceFailure error={resourceErrors.webhooks} onRetry={()=>void loadWebhooks()}/>{resourceLoading.webhooks&&webhooks.length===0?<Skeleton/>:<WebhooksPage projects={projects} webhooks={webhooks} deliveries={webhookDeliveries} onConfigure={configureWebhook} onToggle={toggleWebhook} onReplay={replayWebhook}/>}</>
    : page === "plans"
      ? <><ResourceFailure error={resourceErrors.plans} onRetry={() => void loadPlans()} />{resourceLoading.plans && plans.length===0?<Skeleton/>:<PlansPage plans={plans} projects={projects} onCreate={createPlan} onAssign={assignPlan}/>}</>
    : page === "usage"
      ? <><ResourceFailure error={resourceErrors.usage} onRetry={() => void loadUsage()} />{usage === null ? <Skeleton /> : <UsagePage data={usage} users={users} projects={projects} onFilter={loadUsage} />}</>
    : page === "tasks"
        ? <><ResourceFailure error={resourceErrors.jobs} onRetry={() => void loadJobs()} />{resourceLoading.jobs && jobs.length === 0 ? <Skeleton /> : <TasksPage accounts={accounts} jobs={jobs} />}</>
        : page === "api-access"
          ? <><ResourceFailure error={resourceErrors.settings ?? resourceErrors.apiKeys} onRetry={() => { void loadSettings(); void loadApiKeys(); }} />{(settings === null && resourceLoading.settings) || resourceLoading.apiKeys && apiKeys.length === 0 ? <Skeleton /> : settings !== null && <ApiAccessPage settings={settings} keys={apiKeys} users={users} projects={projects} onCreate={createApiKey} onToggle={toggleApiKey} onRevoke={revokeApiKey} />}</>
          : <><ResourceFailure error={resourceErrors.settings} onRetry={() => void loadSettings()} />{settings === null && resourceLoading.settings ? <Skeleton /> : settings !== null && <SettingsPage accounts={accounts} settings={settings} />}</>;

  return <AppShell page={page} onNavigate={navigate} onLogout={logout}>
    {error !== null && <section className="retry-state" role="alert"><p>{error}</p></section>}
    {notice && <p className="command-notice" aria-live="polite">{notice}</p>}
    <Suspense fallback={<Skeleton />}>{pageContent}</Suspense>
    {dialog !== undefined && <AccountDialog account={dialog} onClose={() => setDialog(undefined)} onSave={save} />}
    {onboardingOpen && <AccountOnboardingDialog onClose={() => setOnboardingOpen(false)} onImport={importAccount} />}
    {apiKeySecret !== null && page === "api-access" && <ApiKeyDialog secret={apiKeySecret} onClose={() => setApiKeySecret(null)} />}
  </AppShell>;
}
