import { useEffect, useRef, useState } from "react";
import type { Account, AccountInput } from "../types";

export function AccountDialog({ account, onClose, onSave }: { account: Account | null; onClose(): void; onSave(input: AccountInput): Promise<void> }) {
  const trigger = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [name, setName] = useState(account?.name ?? "");
  const [priority, setPriority] = useState(String(account?.priority ?? 1));
  const [daily, setDaily] = useState(String(account?.daily_point_limit ?? 0));
  const [monthly, setMonthly] = useState(String(account?.monthly_point_limit ?? 0));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); return () => trigger.current?.focus(); }, []);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [onClose]);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); const values = [Number(priority), Number(daily), Number(monthly)]; if (!name.trim() || values.some((value) => !Number.isInteger(value) || value < 0)) { setError("Enter a name and non-negative whole-number limits."); return; } setSaving(true); try { await onSave({ name: name.trim(), priority: values[0]!, daily_point_limit: values[1]!, monthly_point_limit: values[2]! }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save account"); setSaving(false); } };
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title"><header><h2 id="account-dialog-title">{account === null ? "Create account" : `Edit ${account.name}`}</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></header><form onSubmit={submit}><label>Account name<input ref={nameRef} aria-describedby={error ? "account-error" : undefined} aria-invalid={Boolean(error)} value={name} onChange={(event) => setName(event.target.value)} /></label><label>Priority<input type="number" min="0" value={priority} onChange={(event) => setPriority(event.target.value)} /></label><label>Daily point limit<input type="number" min="0" value={daily} onChange={(event) => setDaily(event.target.value)} /></label><label>Monthly point limit<input type="number" min="0" value={monthly} onChange={(event) => setMonthly(event.target.value)} /></label>{error && <p id="account-error" className="inline-error" aria-live="polite">{error}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button disabled={saving} type="submit">{account === null ? "Create account" : "Save account"}</button></footer></form></section></div>;
}
