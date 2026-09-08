import { randomUUID } from "node:crypto";

const LOGIN_URL = "https://lingjing.jdcloud.com/";

export type BrowserLoginStatus = "running" | "completed" | "failed";

export interface BrowserLoginView {
  id: string;
  accountId: string;
  status: BrowserLoginStatus;
  error: string | null;
  loginUrl: string;
}

export class BrowserLoginManager {
  private readonly logins = new Map<string, BrowserLoginView>();

  start(accountId: string): BrowserLoginView {
    const active = [...this.logins.values()].find(
      (item) => item.accountId === accountId && item.status === "running"
    );
    if (active !== undefined) return active;
    const view: BrowserLoginView = {
      id: randomUUID(),
      accountId,
      status: "running",
      error: null,
      loginUrl: LOGIN_URL
    };
    this.logins.set(view.id, view);
    return view;
  }

  complete(id: string, accountId: string): BrowserLoginView {
    const login = this.logins.get(id);
    if (login === undefined || login.accountId !== accountId) {
      throw new Error("Browser login handoff not found");
    }
    login.status = "completed";
    login.error = null;
    return login;
  }

  find(id: string): BrowserLoginView | null {
    return this.logins.get(id) ?? null;
  }
}
