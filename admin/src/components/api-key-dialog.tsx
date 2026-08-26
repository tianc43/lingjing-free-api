import { useEffect, useRef, useState } from "react";

export function ApiKeyDialog({ secret, onClose }: { secret: string; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [copyError, setCopyError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); trigger.current?.focus(); };
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopyError("");
    } catch {
      setCopyError("无法复制密钥，请手动复制。")
    }
  };
  return <dialog ref={dialogRef} className="dialog" aria-labelledby="api-key-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}><header><h2 id="api-key-dialog-title">API 密钥已创建</h2><button aria-label="关闭对话框" className="icon-button" onClick={onClose}>×</button></header><p className="dialog-guidance">此密钥仅显示一次，请立即复制并妥善保存。</p><code className="api-key-secret">{secret}</code>{copyError && <p className="inline-error" role="alert">{copyError}</p>}<footer><button className="quiet-button" onClick={() => void copy()}>复制密钥</button><button onClick={onClose}>完成</button></footer></dialog>;
}
