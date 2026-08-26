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
    const next: Errors = { ...(name.trim() ? {} : { name: "请输入账号名称。" }), ...(!Number.isInteger(numeric.priority) || numeric.priority < 0 ? { priority: "优先级必须是非负整数。" } : {}), ...(!Number.isInteger(numeric.daily) || numeric.daily < 0 ? { daily: "每日限额必须是非负整数。" } : {}), ...(!Number.isInteger(numeric.monthly) || numeric.monthly < 0 ? { monthly: "每月限额必须是非负整数。" } : {}), ...(cookies.trim() ? {} : { cookies: "请输入灵境 Cookie。" }) };
    const first = (["name", "priority", "daily", "monthly", "cookies"] as Field[]).find((field) => next[field] !== undefined);
    if (first !== undefined) { setErrors(next); refs[first].current?.focus(); return; }
    setErrors({}); setSaveError(""); setSaving(true);
    try {
      await onImport({ name: name.trim(), priority: numeric.priority, daily_point_limit: numeric.daily, monthly_point_limit: numeric.monthly, cookie_format: format, cookie_input: cookies.trim() });
      setCookies("");
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "无法导入账号");
      setSaving(false);
    }
  };
  const field = (key: Exclude<Field, "cookies">, label: string, value: string, setValue: (value: string) => void, type?: "number") => <div><label>{label}<input ref={refs[key] as React.RefObject<HTMLInputElement | null>} type={type} min={type === "number" ? "0" : undefined} aria-describedby={errors[key] ? `onboarding-${key}-error` : undefined} aria-invalid={errors[key] !== undefined} value={value} onChange={(event) => { setValue(event.target.value); clear(key); }} /></label>{errors[key] && <p id={`onboarding-${key}-error`} className="field-error">{errors[key]}</p>}</div>;
  return <dialog ref={dialogRef} className="dialog onboarding-dialog" aria-labelledby="account-onboarding-title" onCancel={(event) => { event.preventDefault(); onClose(); }}><header><h2 id="account-onboarding-title">添加账号</h2><button aria-label="关闭对话框" className="icon-button" onClick={onClose}>×</button></header><form noValidate onSubmit={(event) => void submit(event)}>{field("name", "账号名称", name, setName)}{field("priority", "优先级", priority, setPriority, "number")}{field("daily", "每日点数限额", daily, setDaily, "number")}{field("monthly", "每月点数限额", monthly, setMonthly, "number")}<p className="dialog-guidance"><a href="https://lingjing.jdcloud.com/" target="_blank" rel="noreferrer">打开灵境登录页</a><span>登录后，在开发者工具中从一条已认证的灵境请求复制 Cookie 请求头。请仅粘贴到此处，切勿发送到聊天、日志或 Git。导入操作会更新本地账号会话，但不会修改灵境密码。</span></p><label>Cookie 格式<select aria-label="Cookie 格式" value={format} onChange={(event) => setFormat(event.target.value as "header" | "json")}><option value="header">Cookie 请求头</option><option value="json">浏览器 Cookie JSON</option></select></label><label>灵境 Cookie <span>（私密保存，绝不返回）</span><textarea ref={refs.cookies as React.RefObject<HTMLTextAreaElement | null>} aria-describedby={errors.cookies ? "onboarding-cookies-error" : undefined} aria-invalid={errors.cookies !== undefined} value={cookies} onChange={(event) => { setCookies(event.target.value); clear("cookies"); }} rows={5} spellCheck={false} /></label>{errors.cookies && <p id="onboarding-cookies-error" className="field-error">{errors.cookies}</p>}{saveError && <p className="inline-error" aria-live="polite">{saveError}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button disabled={saving} type="submit">{saving ? "正在验证…" : "验证并添加"}</button></footer></form></dialog>;
}
