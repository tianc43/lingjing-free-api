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
      setCopyError("Could not copy the key. Copy it manually.");
    }
  };
  return <dialog ref={dialogRef} className="dialog" aria-labelledby="api-key-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}><header><h2 id="api-key-dialog-title">API key created</h2><button aria-label="Close dialog" className="icon-button" onClick={onClose}>×</button></header><p className="dialog-guidance">This key is shown only once. Copy it now and store it securely.</p><code className="api-key-secret">{secret}</code>{copyError && <p className="inline-error" role="alert">{copyError}</p>}<footer><button className="quiet-button" onClick={() => void copy()}>Copy key</button><button onClick={onClose}>Done</button></footer></dialog>;
}
