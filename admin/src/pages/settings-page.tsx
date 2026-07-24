import { useState } from "react";
import type { Account, Settings } from "../types";

export function SettingsPage({ settings, accounts }: { settings: Settings; accounts: Account[] }) {
  const [notice, setNotice] = useState(""); const copy = async (command: string) => { await navigator.clipboard?.writeText(command).catch(() => undefined); setNotice("Login command copied"); };
  return <><header className="page-heading"><div><p className="eyebrow">Service configuration</p><h1>Settings</h1></div></header><section className="settings-grid"><article className="data-region"><h2>Shared API status</h2><dl><div><dt>Admin session</dt><dd>Authenticated / cookie protected</dd></div><div><dt>Concurrency</dt><dd>{settings.max_concurrency}</dd></div><div><dt>Queue limit</dt><dd>{settings.max_queued_requests}</dd></div><div><dt>Documentation</dt><dd>{settings.docs_enabled ? "Enabled" : "Masked / disabled"}</dd></div></dl></article><article className="data-region"><h2>Account login commands</h2><p className="notice" aria-live="polite">{notice}</p>{accounts.map((account) => { const command = `npm run login -- --account-id ${account.id}`; return <div className="command" key={account.id}><span>{account.name}</span><code>{command}</code><button aria-label="Copy login command" className="quiet-button" onClick={() => void copy(command)}>Copy</button></div>; })}</article></section></>;
}
