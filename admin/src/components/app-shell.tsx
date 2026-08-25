import type { ReactNode } from "react";

export type PageName = "overview" | "accounts" | "identities" | "playground" | "tasks" | "plans" | "usage" | "webhooks" | "api-access" | "settings";
const links: Array<{ page: PageName; label: string; mark: string }> = [
  { page: "overview", label: "Overview", mark: "01" },
  { page: "accounts", label: "Subscriptions", mark: "02" },
  { page: "identities", label: "Users & projects", mark: "03" },
  { page: "playground", label: "Playground", mark: "04" },
  { page: "tasks", label: "Tasks", mark: "05" },
  { page: "plans", label: "Plans", mark: "06" },
  { page: "usage", label: "Usage", mark: "07" },
  { page: "webhooks", label: "Webhooks", mark: "08" },
  { page: "api-access", label: "API keys", mark: "09" },
  { page: "settings", label: "Runtime", mark: "10" }
];

export function AppShell({ page, onNavigate, onLogout, children }: { page: PageName; onNavigate(page: PageName): void; onLogout(): void; children: ReactNode }) {
  return <div className="shell"><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><div className="brand"><span>LINGJING</span><strong>Operator</strong></div><nav aria-label="Main navigation">{links.map((link) => <a key={link.page} href={`/admin/${link.page === "overview" ? "" : link.page}`} aria-current={page === link.page ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate(link.page); }}><span aria-hidden="true">{link.mark}</span>{link.label}</a>)}</nav><button className="quiet-button" onClick={onLogout}>Sign out</button></aside><header className="mobile-header"><span>LINGJING / Operator</span><select aria-label="Navigate" value={page} onChange={(event) => onNavigate(event.target.value as PageName)}>{links.map((link) => <option key={link.page} value={link.page}>{link.label}</option>)}</select><button className="quiet-button" onClick={onLogout}>Sign out</button></header><main id="main">{children}</main></div>;
}
