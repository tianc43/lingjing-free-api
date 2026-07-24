import type { ReactNode } from "react";

export type PageName = "overview" | "accounts" | "tasks" | "settings";
const links: Array<{ page: PageName; label: string }> = [
  { page: "overview", label: "Overview" }, { page: "accounts", label: "Accounts" }, { page: "tasks", label: "Tasks" }, { page: "settings", label: "Settings" }
];

export function AppShell({ page, onNavigate, onLogout, children }: { page: PageName; onNavigate(page: PageName): void; onLogout(): void; children: ReactNode }) {
  return <div className="shell"><a className="skip-link" href="#main">Skip to content</a><aside className="sidebar"><div className="brand"><span>LINGJING</span><strong>Operator</strong></div><nav aria-label="Main navigation">{links.map((link) => <a key={link.page} href={`/admin/${link.page === "overview" ? "" : link.page}`} aria-current={page === link.page ? "page" : undefined} onClick={(event) => { event.preventDefault(); onNavigate(link.page); }}>{link.label}</a>)}</nav><button className="quiet-button" onClick={onLogout}>Sign out</button></aside><header className="mobile-header"><span>LINGJING / Operator</span><select aria-label="Navigate" value={page} onChange={(event) => onNavigate(event.target.value as PageName)}>{links.map((link) => <option key={link.page} value={link.page}>{link.label}</option>)}</select></header><main id="main">{children}</main></div>;
}
