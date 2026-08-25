import { useEffect, useRef, useState } from "react";
import type { AccountImportInput } from "../types";

type Field = "name" | "priority" | "daily" | "monthly" | "cookies";
type Errors = Partial<Record<Field, string>>;

export function AccountOnboardingDialog({ onClose, onImport }: { onClose(): void; onImport(input: AccountImportInput): Promise<void> }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const refs: Record<Field, React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>> = { name: useRef<HTMLInputElement>(null), priority: useRef<HTMLInputElement>(null), daily: useRef<HTMLInputElement>(null), monthly: useRef<HTMLInputElement>(null), cookies: useRef<HTMLTextAreaElement>(null) };
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("1");
  const [daily, setDaily] = useState("0");
  const [monthly, setMonthly] = useState("0");
  const [format, setFormat] = useState<"header" | "json">("header");
  const [cookies, setCookies] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { const dialog = dialogRef.current; dialog?.showModal(); refs.name.current?.focus(); return () => { if (dialog?.open) dialog.close(); trigger.current?.focus(); }; }, []);
  const clear = (field: Field) => setErrors((current) => ({ ...current, [field]: undefined }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const numeric = { priority: Number(priority), daily: Number(daily), monthly: Number(monthly) };
    const next: Errors = { ...(name.trim() ? {} : { name: "Account name is required." }), ...(!Number.isInteger(numeric.priority) || numeric.priority < 0 ? { priority: "Priority must be a non-negative whole number." } : {}), ...(!Number.isInteger(numeric.daily) || numeric.daily < 0 ? { daily: "Daily limit must be a non-negative whole number." } : {}), ...(!Number.isInteger(numeric.monthly) || numeric.monthly < 0 ? { monthly: "Monthly limit must be a non-negative whole number." } : {}), ...(cookies.trim() ? {} : { cookies: "Lingjing cookies are required." }) };
    const first = (["name", "priority", "daily", "monthly", "cookies"] as Field[]).find((field) => next[field] !== undefined);
    if (first !== undefined) { setErrors(next); refs[first].current?.focus(); return; }
    setErrors({}); setSaveError(""); setSaving(true);
    try {
      await onImport({ name: name.trim(), priority: numeric.priority, daily_point_limit: numeric.daily, monthly_point_limit: numeric.monthly, cookie_format: format, cookie_input: cookies.trim() });
      setCookies("");
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not import account");
      setSaving(false);
    }
  };
  const field = (key: Exclude<Field, "cookies">, label: string, value: string, setValue: (value: string) => void, type?: "number") => <div><label>{label}<input ref={refs[key] as React.RefObject<HTMLInputElement | null>} type={type} min={type === "number" ? "0" : undefined} aria-describedby={errors[key] ? `onboarding-${key}-error` : undefined} aria-invalid={errors[key] !== undefined} value={value} onChange={(event) => { setValue(event.target.value); clear(key); }} /></label>{errors[key] && <p id={`onboarding-${key}-error`} className="field-error">{errors[key]}</p>}</div>;
  return <dialog ref={dialogRef} className="dialog onboarding-dialog" aria-labelledby="account-onboarding-title" onCancel={(event) => { event.preventDefault(); onClose(); }}><header><h2 id="account-onboarding-title">Add account</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></header><form noValidate onSubmit={(event) => void submit(event)}>{field("name", "Account name", name, setName)}{field("priority", "Priority", priority, setPriority, "number")}{field("daily", "Daily point limit", daily, setDaily, "number")}{field("monthly", "Monthly point limit", monthly, setMonthly, "number")}<p className="dialog-guidance"><a href="https://lingjing.jdcloud.com/" target="_blank" rel="noreferrer">Open Lingjing login</a><span>After signing in, copy the Cookie header from one authenticated Lingjing request in DevTools. Paste it only here—never in chat, logs, or Git. Importing rotates the local account session but does not change your Lingjing password.</span></p><label>Cookie format<select aria-label="Cookie format" value={format} onChange={(event) => setFormat(event.target.value as "header" | "json")}><option value="header">Cookie header</option><option value="json">Browser cookie JSON</option></select></label><label>Lingjing cookies <span>(stored privately; never returned)</span><textarea ref={refs.cookies as React.RefObject<HTMLTextAreaElement | null>} aria-describedby={errors.cookies ? "onboarding-cookies-error" : undefined} aria-invalid={errors.cookies !== undefined} value={cookies} onChange={(event) => { setCookies(event.target.value); clear("cookies"); }} rows={5} spellCheck={false} /></label>{errors.cookies && <p id="onboarding-cookies-error" className="field-error">{errors.cookies}</p>}{saveError && <p className="inline-error" aria-live="polite">{saveError}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button disabled={saving} type="submit">{saving ? "Validating…" : "Validate and add"}</button></footer></form></dialog>;
}
