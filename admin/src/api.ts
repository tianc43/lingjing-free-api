import type { Account, AccountCredentialInput, AccountImportInput, AccountInput, ApiKey, ApiKeyScope, BrowserLogin, CallLogDetail, CallLogFilters, CallLogPage, Job, Overview, PlaygroundInput, PlaygroundModel, PlaygroundQuote, PlaygroundQuoteInput, Settings, SignInStatus, UsageData } from "./types";

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
  async signInStatus(): Promise<SignInStatus> { return await this.request("/sign-in-status"); }
  async jobs(): Promise<Job[]> { return (await this.request<{ jobs: Job[] }>("/jobs")).jobs; }
  async settings(): Promise<Settings> { return await this.request("/settings"); }
  async usage(filters: { user_id?:string; project_id?:string } = {}): Promise<UsageData> { const query=new URLSearchParams(filters); return await this.request(`/usage?${query}`); }
  async callLogs(filters: CallLogFilters = {}): Promise<CallLogPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") query.set(key, String(value));
    return await this.request(`/call-logs?${query}`);
  }
  async callLog(id: string): Promise<CallLogDetail> { return await this.request(`/call-logs/${encodeURIComponent(id)}`); }
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
  async importAccount(input: AccountImportInput): Promise<Account> {
    return (await this.request<{ account: Account }>("/accounts/import", { method: "POST", body: input })).account;
  }
  async updateAccountCredentials(id: string, input: AccountCredentialInput): Promise<Account> {
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}/credentials`, { method: "POST", body: input })).account;
  }
  async updateAccount(id: string, input: AccountInput): Promise<Account> {
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: input })).account;
  }
  async setEnabled(account: Account, enabled: boolean): Promise<Account> {
    const action = enabled ? "enable" : "disable";
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(account.id)}/${action}`, { method: "POST" })).account;
  }
  async checkAccount(id: string): Promise<Account> {
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}/check`, { method: "POST" })).account;
  }
  async playgroundModels(kind: "image" | "video", mode?: "text-to-video" | "image-to-video", refresh = false): Promise<PlaygroundModel[]> {
    const query = new URLSearchParams({ type: kind });
    if (kind === "video") query.set("mode", mode ?? "text-to-video");
    if (refresh) query.set("refresh", "true");
    return (await this.request<{ models: PlaygroundModel[] }>(`/playground/models?${query}`)).models;
  }
  async startBrowserLogin(id:string):Promise<BrowserLogin>{return(await this.request<{login:BrowserLogin}>(`/accounts/${encodeURIComponent(id)}/browser-login`,{method:"POST"})).login;}
  async browserLogin(id:string):Promise<BrowserLogin>{return(await this.request<{login:BrowserLogin}>(`/accounts/browser-logins/${encodeURIComponent(id)}`)).login;}
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
    if (!response.ok) {
      const body = await response.json().catch((): ApiErrorBody => ({})) as ApiErrorBody;
      if (response.status === 401 && body.error?.code === "admin_authentication_required" && notifyUnauthorized) {
        this.sessionNonce = null;
        this.onUnauthorized();
      }
      throw new ApiError(response.status, body.error?.code ?? "request_failed", body.error?.message ?? "Request failed");
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
