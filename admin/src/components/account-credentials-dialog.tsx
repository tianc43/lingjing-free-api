import { useEffect, useRef, useState } from "react";
import type { Account, AccountCredentialInput } from "../types";

export function AccountCredentialsDialog({ account, onClose, onUpdate }: {
  account: Account;
  onClose(): void;
  onUpdate(input: AccountCredentialInput): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cookieRef = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const [format, setFormat] = useState<"header" | "json">("header");
  const [cookies, setCookies] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    cookieRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      trigger.current?.focus();
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cookies.trim()) {
      setError("请输入灵境 Cookie。");
      cookieRef.current?.focus();
      return;
    }
    setError("");
    setSaving(true);
    try {
      await onUpdate({
        cookie_format: format,
        cookie_input: cookies.trim()
      });
      setCookies("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法更新账号凭据");
      setSaving(false);
    }
  };

  return <dialog ref={dialogRef} className="dialog onboarding-dialog" aria-labelledby="account-credentials-title" onCancel={(event) => { event.preventDefault(); onClose(); }}><header><h2 id="account-credentials-title">更新 {account.name} 的凭据</h2><button aria-label="关闭对话框" className="icon-button" onClick={onClose}>×</button></header><form noValidate onSubmit={(event) => void submit(event)}><p id="account-credentials-guidance" className="dialog-guidance"><a href="https://lingjing.jdcloud.com/" target="_blank" rel="noreferrer">打开灵境登录页</a><span>请在你自己的浏览器中完成灵境登录，然后从开发者工具中的已认证请求复制 Cookie 请求头。更新前会先验证 Cookie；内容不会写入浏览器存储、响应或日志。</span></p><label>Cookie 格式<select aria-label="Cookie 格式" value={format} onChange={(event) => setFormat(event.target.value as "header" | "json")}><option value="header">Cookie 请求头</option><option value="json">浏览器 Cookie JSON</option></select></label><label>灵境 Cookie <span>（私密保存，绝不返回）</span><textarea ref={cookieRef} name="lingjing-cookie" autoComplete="off" aria-describedby={`account-credentials-guidance${error ? " account-credentials-error" : ""}`} aria-invalid={error !== ""} value={cookies} onChange={(event) => { setCookies(event.target.value); setError(""); }} rows={5} spellCheck={false} /></label>{error && <p id="account-credentials-error" className="inline-error" role="alert">{error}</p>}<footer><button type="button" className="quiet-button" onClick={onClose}>取消</button><button disabled={saving} type="submit">{saving ? "正在验证…" : "验证并更新"}</button></footer></form></dialog>;
}
