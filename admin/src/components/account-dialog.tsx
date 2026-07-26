import { useEffect, useRef, useState } from "react";
import type { Account, AccountInput } from "../types";

type Field = "name" | "priority" | "daily" | "monthly";
type Errors = Partial<Record<Field, string>>;

export function AccountDialog({ account, onClose, onSave }: { account: Account; onClose(): void; onSave(input: AccountInput): Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const refs: Record<Field, React.RefObject<HTMLInputElement | null>> = { name: useRef<HTMLInputElement>(null), priority: useRef<HTMLInputElement>(null), daily: useRef<HTMLInputElement>(null), monthly: useRef<HTMLInputElement>(null) };
  const [name, setName] = useState(account.name);
  const [priority, setPriority] = useState(String(account.priority));
  const [daily, setDaily] = useState(String(account.daily_point_limit));
  const [monthly, setMonthly] = useState(String(account.monthly_point_limit));
  const [errors, setErrors] = useState<Errors>({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); refs.name.current?.focus(); return () => { if (dialog?.open) dialog.close(); trigger.current?.focus(); }; }, []);
  const clear = (field: Field) => setErrors((current) => ({ ...current, [field]: undefined }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const numeric = { priority: Number(priority), daily: Number(daily), monthly: Number(monthly) };
    const next: Errors = { ...(name.trim() ? {} : { name: "Account name is required." }), ...(!Number.isInteger(numeric.priority) || numeric.priority < 0 ? { priority: "Priority must be a non-negative whole number." } : {}), ...(!Number.isInteger(numeric.daily) || numeric.daily < 0 ? { daily: "Daily limit must be a non-negative whole number." } : {}), ...(!Number.isInteger(numeric.monthly) || numeric.monthly < 0 ? { monthly: "Monthly limit must be a non-negative whole number." } : {}) };
    const first = (["name", "priority", "daily", "monthly"] as Field[]).find((field) => next[field] !== undefined);
    if (first !== undefined) { setErrors(next); refs[first].current?.focus(); return; }
    setErrors({}); setSaveError(""); setSaving(true);
    try { await onSave({ name: name.trim(), priority: numeric.priority, daily_point_limit: numeric.daily, monthly_point_limit: numeric.monthly }); } catch (cause) { setSaveError(cause instanceof Error ? cause.message : "Could not save account"); setSaving(false); }
  };
  const field = (key: Field, label: string, value: string, setValue: (value: string) => void, type?: "number") => <div><label>{label}<input ref={refs[key]} type={type} min={type === "number" ? "0" : undefined} aria-describedby={errors[key] ? `account-${key}-error` : undefined} aria-invalid={errors[key] !== undefined} value={value} onChange={(event) => { setValue(event.target.value); clear(key); }} /></label>{errors[key] && <p id={`account-${key}-error`} className="field-error">{errors[key]}</p>}</div>;
  return <dialog ref={dialogRef} className="dialog" aria-labelledby="account-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}><header><h2 id="account-dialog-title">Edit {account.name}</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></header><form noValidate onSubmit={(event) => void submit(event)}>{field("name", "Account name", name, setName)}{field("priority", "Priority", priority, setPriority, "number")}{field("daily", "Daily point limit", daily, setDaily, "number")}{field("monthly", "Monthly point limit", monthly, setMonthly, "number")}{saveError && <p className="inline-error" aria-live="polite">{saveError}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button disabled={saving} type="submit">Save account</button></footer></form></dialog>;
}
