import type { Account, AccountInput, Job, Overview, Settings } from "./types";

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
      const response = await this.request<{ csrf_token: string }>("/session");
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
  async createAccount(input: AccountInput): Promise<{ account: Account; login_command: string }> {
    return await this.request("/accounts", { method: "POST", body: input });
  }
  async updateAccount(id: string, input: AccountInput): Promise<Account> {
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: input })).account;
  }
  async setEnabled(account: Account, enabled: boolean): Promise<Account> {
    const action = enabled ? "enable" : "disable";
    return (await this.request<{ account: Account }>(`/accounts/${encodeURIComponent(account.id)}/${action}`, { method: "POST" })).account;
  }

  private async request<T>(path: string, options: { method?: string; body?: RequestBody; csrf?: boolean } = {}): Promise<T> {
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
    if (response.status === 401) {
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
