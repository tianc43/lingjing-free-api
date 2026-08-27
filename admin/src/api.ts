import type { Account, BrowserLogin, AccountImportInput, AccountInput, ApiKey, ApiKeyScope, Job, Overview, PlaygroundInput, PlaygroundModel, PlaygroundQuote, PlaygroundQuoteInput, Plan, Project, Settings, UsageData, User, WebhookDelivery, WebhookEndpoint } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

type ApiErrorBody = { error?: { code?: string; message?: string } };
type RequestBody = object;

export class AdminApi {
  private sessionNonce: string | null = null;

  constructor(private readonly onUnauthorized: () => void) {}

  async login(password: string): Promise<void> {
    const response = await this.request<{ csrf_token: string }>("/login", {
      method: "POST",
      body: { password },
      csrf: false
    });
    this.sessionNonce = response.csrf_token;
  }

  async session(): Promise<boolean> {
    try {
    const response = await this.request<{ csrf_token: string }>("/session", {}, false);
      this.sessionNonce = response.csrf_token;
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return false;
      throw cause;
    }
  }

  async logout(): Promise<void> {
    await this.request<void>("/logout", { method: "POST" });
    this.sessionNonce = null;
  }

  async overview(): Promise<Overview> { return await this.request("/overview"); }
  async accounts(): Promise<Account[]> { return (await this.request<{ accounts: Account[] }>("/accounts")).accounts; }
  async jobs(): Promise<Job[]> { return (await this.request<{ jobs: Job[] }>("/jobs")).jobs; }
  async settings(): Promise<Settings> { return await this.request("/settings"); }
  async usage(filters: { user_id?:string; project_id?:string } = {}): Promise<UsageData> { const query=new URLSearchParams(filters); return await this.request(`/usage?${query}`); }
  async users(): Promise<User[]> { return (await this.request<{ users: User[] }>("/users")).users; }
  async createUser(name: string): Promise<User> { return (await this.request<{ user: User }>("/users", { method: "POST", body: { name } })).user; }
  async setUserStatus(id: string, status: User["status"]): Promise<User> { return (await this.request<{ user: User }>(`/users/${encodeURIComponent(id)}/status`, { method: "POST", body: { status } })).user; }
  async webhookDeliveries(): Promise<WebhookDelivery[]> { return (await this.request<{deliveries:WebhookDelivery[]}>("/webhook-deliveries")).deliveries; }
  async replayWebhook(id:string): Promise<void> { await this.request(`/webhook-deliveries/${encodeURIComponent(id)}/replay`,{method:"POST"}); }
  async webhooks(): Promise<WebhookEndpoint[]> { return (await this.request<{webhooks:WebhookEndpoint[]}>("/webhooks")).webhooks; }
  async configureWebhook(projectId:string,url:string): Promise<WebhookEndpoint> { return (await this.request<{webhook:WebhookEndpoint}>("/webhooks",{method:"POST",body:{project_id:projectId,url}})).webhook; }
  async setWebhookEnabled(id:string,enabled:boolean): Promise<WebhookEndpoint> { return (await this.request<{webhook:WebhookEndpoint}>(`/webhooks/${encodeURIComponent(id)}/status`,{method:"POST",body:{enabled}})).webhook; }
  async plans(): Promise<Plan[]> { return (await this.request<{plans:Plan[]}>("/plans")).plans; }
  async createPlan(input: Omit<Plan,"id"|"created_at"|"updated_at">): Promise<Plan> { return (await this.request<{plan:Plan}>("/plans",{method:"POST",body:input})).plan; }
  async assignPlan(projectId:string,planId:string): Promise<void> { await this.request("/plans/assign",{method:"POST",body:{project_id:projectId,plan_id:planId}}); }
  async projects(): Promise<Project[]> { return (await this.request<{ projects: Project[] }>("/projects")).projects; }
  async createProject(userId: string, name: string): Promise<Project> { return (await this.request<{ project: Project }>("/projects", { method: "POST", body: { user_id: userId, name } })).project; }
  async setProjectStatus(id: string, status: Project["status"]): Promise<Project> { return (await this.request<{ project: Project }>(`/projects/${encodeURIComponent(id)}/status`, { method: "POST", body: { status } })).project; }
  async apiKeys(): Promise<ApiKey[]> { return (await this.request<{ api_keys: ApiKey[] }>("/api-keys")).api_keys; }
  async createApiKey(input: { name: string; user_id?: string; project_id?: string; scopes?: ApiKeyScope[]; expires_at?: number | null }): Promise<{ key: ApiKey; api_key: string }> {
    return await this.request("/api-keys", { method: "POST", body: input });
  }
  async setApiKeyEnabled(key: ApiKey, enabled: boolean): Promise<ApiKey> {
    const action = enabled ? "enable" : "disable";
    return (await this.request<{ key: ApiKey }>(`/api-keys/${encodeURIComponent(key.id)}/${action}`, { method: "POST" })).key;
  }
  async revokeApiKey(key: ApiKey): Promise<ApiKey> {
    return (await this.request<{ key: ApiKey }>(`/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" })).key;
  }
  async createAccount(input: AccountInput): Promise<{ account: Account; login_command: string }> {
    return await this.request("/accounts", { method: "POST", body: input });
  }
  async importAccount(input: AccountImportInput): Promise<Account> {
    return (await this.request<{ account: Account }>("/accounts/import", { method: "POST", body: input })).account;
  }
  async updateAccount(id: string, input: AccountInput): Promise<Account> {
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: input })).account;
  }
  async setEnabled(account: Account, enabled: boolean): Promise<Account> {
    const action = enabled ? "enable" : "disable";
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(account.id)}/${action}`, { method: "POST" })).account;
  }
  async startBrowserLogin(id:string):Promise<BrowserLogin>{return(await this.request<{login:BrowserLogin}>(`/accounts/${encodeURIComponent(id)}/browser-login`,{method:"POST"})).login;}
  async browserLogin(id:string):Promise<BrowserLogin>{return(await this.request<{login:BrowserLogin}>(`/accounts/browser-logins/${encodeURIComponent(id)}`)).login;}
  async checkAccount(id: string): Promise<Account> {
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}/check`, { method: "POST" })).account;
  }
  async playgroundModels(kind: "image" | "video", mode?: "text-to-video" | "image-to-video", refresh = false): Promise<PlaygroundModel[]> {
    const query = new URLSearchParams({ type: kind });
    if (kind === "video") query.set("mode", mode ?? "text-to-video");
    if (refresh) query.set("refresh", "true");
    return (await this.request<{ models: PlaygroundModel[] }>(`/playground/models?${query}`)).models;
  }
  async quotePlayground(input: PlaygroundQuoteInput): Promise<PlaygroundQuote> {
    return await this.request("/playground/quote", { method: "POST", body: input });
  }
  async runPlayground(input: PlaygroundInput): Promise<Job> {
    return (await this.request<{ job: Job }>("/playground/run", { method: "POST", body: input })).job;
  }
  async job(id: string): Promise<Job> {
    return (await this.request<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`)).job;
  }

  private async request<T>(path: string, options: { method?: string; body?: RequestBody; csrf?: boolean } = {}, notifyUnauthorized = true): Promise<T> {
    const method = options.method ?? "GET";
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.csrf !== false && method !== "GET" && method !== "HEAD" && this.sessionNonce !== null) {
      headers.set("x-csrf-token", this.sessionNonce);
    }
    const response = await fetch(`/admin/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    if (response.status === 401 && notifyUnauthorized) {
      this.sessionNonce = null;
      this.onUnauthorized();
    }
    if (!response.ok) {
      const body = await response.json().catch((): ApiErrorBody => ({})) as ApiErrorBody;
      throw new ApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? "Request failed");
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
