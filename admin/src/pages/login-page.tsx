import { useState } from "react";

export function LoginPage({ onLogin, error }: { onLogin(password: string): Promise<void>; error: string | null }) {
  const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setBusy(true); try { await onLogin(password); } finally { setBusy(false); } };
  return <main className="login-page"><section className="login-panel"><p className="eyebrow">Lingjing operator console</p><h1>Admin sign in</h1><p>Use the administrator password. This session stays on this device only while the service is running.</p><form onSubmit={submit}><label>Administrator password<input aria-describedby={error ? "login-password-error" : undefined} aria-invalid={error !== null} autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p id="login-password-error" className="inline-error" aria-live="polite">{error}</p>}<button disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in"}</button></form></section></main>;
}
