import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Clipboard, Download, KeyRound, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { api, isStandalonePreview, post } from "./api";
import type { User } from "./types";
import "./access-security.css";

export type MfaPending = {
  kind: "mfa";
  email: string;
  challenge_token: string;
  expires_at: string;
  enrollment_required: boolean;
};
type AuthenticatorSetup = { secret: string; otpauth_uri: string; expires_at: string };
type AccountEnrollment = AuthenticatorSetup & { enrollment_id: string };
type SecurityStatus = { available: boolean; required: boolean; mfa_enabled: boolean; recovery_codes_remaining: number };
type AuthenticationResult = { ok: true; user: User; recovery_codes?: string[] } |
  { ok: false; error: string; attempts_remaining: number };
type AccountSecurityResult = { ok: true; user?: User; recovery_codes?: string[] } |
  { ok: false; error: string; attempts_remaining?: number };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "This request could not be completed. Please try again.";

function useExpiry(expiresAt: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const deadline = expiresAt ? Date.parse(expiresAt) : Infinity;
  const remaining = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now) / 1000)) : Infinity;
  return { expired: Boolean(expiresAt && (!Number.isFinite(deadline) || remaining === 0)),
    label: Number.isFinite(remaining) ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "" };
}

function ErrorMessage({ message }: { message: string }) {
  return message ? <p className="access-error" role="alert">{message}</p> : null;
}

function AuthenticatorInstructions({ setup }: { setup: AuthenticatorSetup }) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function copy(value: string, message: string) {
    setError("");
    try { await navigator.clipboard.writeText(value); setNotice(message); }
    catch { setError("Copy was unavailable. Select and copy the setup key below manually."); }
  }
  return <div className="access-setup">
    <ol>
      <li>Open your authenticator app and choose to add an account using a setup key.</li>
      <li>Enter this key, choose a time-based account, and keep the key private.</li>
      <li>Enter the six-digit code shown by your authenticator to confirm setup.</li>
    </ol>
    <div className="access-secret"><span>Authenticator setup key</span><code aria-label="Authenticator setup key">{setup.secret}</code></div>
    <div className="access-actions">
      <button type="button" className="button secondary" onClick={() => void copy(setup.secret, "Setup key copied. Keep it private.")}><Clipboard size={15} />Copy setup key</button>
      <button type="button" className="text-button" onClick={() => void copy(setup.otpauth_uri, "Authenticator configuration copied. Keep it private.")}>Copy authenticator configuration</button>
    </div>
    <p className="access-hint">Use an authenticator that you control. Cevrali does not send this key to an external QR-code service.</p>
    {notice && <p className="access-success" role="status">{notice}</p>}<ErrorMessage message={error} />
  </div>;
}

function RecoveryCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [saved, setSaved] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const contents = `Cevrali account recovery codes\n\nEach code can be used once instead of an authenticator code.\nStore these privately, separate from your password and device.\n\n${codes.join("\n")}\n`;
  return <section className="access-recovery" aria-label="Save your recovery codes">
    <h3>Save your recovery codes</h3>
    <p>Each code works once if you lose access to your authenticator. Save these somewhere private before continuing. These codes will not be shown again.</p>
    <ul className="access-recovery-list" aria-label="Recovery codes">{codes.map((code, index) => <li key={index}><code>{code}</code></li>)}</ul>
    <div className="access-actions">
      <button type="button" className="button secondary" onClick={async () => {
        setError("");
        try { await navigator.clipboard.writeText(codes.join("\n")); setNotice("Recovery codes copied. Store them privately."); }
        catch { setError("Copy was unavailable. Download the codes or copy them manually."); }
      }}><Clipboard size={15} />Copy recovery codes</button>
      <button type="button" className="button secondary" onClick={() => {
        const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "cevrali-recovery-codes.txt"; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000); setNotice("Recovery-code download prepared. Store the file privately.");
      }}><Download size={15} />Download recovery codes</button>
    </div>
    <label className="access-checkbox"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I saved my recovery codes in a private place.</label>
    <ErrorMessage message={error} />{notice && <p className="access-success" role="status">{notice}</p>}
    <button type="button" className="button primary" disabled={!saved} onClick={onContinue}><Check size={15} />Continue</button>
  </section>;
}

/** A password-verified challenge is not a workspace session. Only the server's
 * successful authenticator response can supply the signed-in user. */
export function MfaAuthentication({ challenge, onAuthenticated, onCancel }: {
  challenge: MfaPending; onAuthenticated: (user: User) => void; onCancel: () => void;
}) {
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null);
  const [code, setCode] = useState(""), [recoveryMode, setRecoveryMode] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [attempts, setAttempts] = useState<number | null>(null);
  const [completed, setCompleted] = useState<{ user: User; recoveryCodes: string[] } | null>(null);
  const pending = useRef(false), mounted = useRef(true);
  const expiry = useExpiry(challenge.expires_at);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (expiry.expired) { setSetup(null); setCode(""); } }, [expiry.expired]);
  const locked = expiry.expired || attempts === 0;
  async function prepare() {
    if (pending.current || locked) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const value = await post<AuthenticatorSetup>("/auth/mfa/setup", { email: challenge.email, challenge_token: challenge.challenge_token });
      if (mounted.current) setSetup(value);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (pending.current || locked) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await post<AuthenticationResult>(challenge.enrollment_required ? "/auth/mfa/enroll" : "/auth/mfa/complete", {
        email: challenge.email, challenge_token: challenge.challenge_token, code: code.trim(),
      });
      if (!mounted.current) return;
      if (!result.ok) { setError(result.error); setAttempts(result.attempts_remaining); return; }
      setSetup(null);
      if (result.recovery_codes?.length) setCompleted({ user: result.user, recoveryCodes: result.recovery_codes });
      else onAuthenticated(result.user);
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setCode(""); } }
  }
  return <section className="access-security access-login" aria-labelledby="access-auth-heading">
    <div className="access-heading"><ShieldCheck size={23} /><div><h2 id="access-auth-heading">{challenge.enrollment_required ? "Set up your authenticator" : "Verify your sign-in"}</h2><p>{challenge.email}</p></div></div>
    {completed ? <RecoveryCodes codes={completed.recoveryCodes} onContinue={() => { const user = completed.user; setCompleted(null); onAuthenticated(user); }} /> : <>
      <p>{challenge.enrollment_required ? "Your practice requires an authenticator before you can open the workspace." : "Enter the code from your authenticator app to finish signing in."}</p>
      <p className="access-hint">{expiry.expired ? "This sign-in request has expired. Start again with your password." : `Sign-in request expires in ${expiry.label}.`}</p>
      {challenge.enrollment_required && !setup && !locked && <button type="button" className="button secondary" disabled={busy} onClick={() => void prepare()}><KeyRound size={15} />Set up authenticator</button>}
      {setup && !locked && <AuthenticatorInstructions setup={setup} />}
      {(!challenge.enrollment_required || setup) && !locked && <form className="access-form" onSubmit={submit}>
        <label>{recoveryMode ? "Recovery code" : "Authenticator code"}<input value={code} onChange={event => setCode(event.target.value)}
          type="text" inputMode={recoveryMode ? "text" : "numeric"} autoComplete="one-time-code" spellCheck={false}
          maxLength={recoveryMode ? 100 : 6} pattern={recoveryMode ? undefined : "[0-9]{6}"} required disabled={busy} autoFocus />
        </label>
        <button className="button primary" disabled={busy || !code.trim()}><LockKeyhole size={15} />{busy ? "Verifying…" : challenge.enrollment_required ? "Confirm authenticator" : "Verify and sign in"}</button>
      </form>}
      {!challenge.enrollment_required && !locked && <button type="button" className="text-button" disabled={busy} onClick={() => { setRecoveryMode(value => !value); setCode(""); setError(""); }}>{recoveryMode ? "Use my authenticator instead" : "Use a recovery code"}</button>}
      <ErrorMessage message={error} />
      {attempts !== null && attempts > 0 && <p className="access-hint" role="status">{attempts} verification attempts remaining.</p>}
      {attempts === 0 && <p className="access-hint">Verification is temporarily locked. Start a new sign-in after the lockout expires.</p>}
      <button type="button" className="button secondary" disabled={busy} onClick={() => { setCode(""); setSetup(null); onCancel(); }}>Return to sign in</button>
    </>}
  </section>;
}

export function SecurityMfaSettings({ user, onUserChanged }: { user: User; onUserChanged: (user: User) => void }) {
  const [status, setStatus] = useState<SecurityStatus | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [action, setAction] = useState<"enroll" | "regenerate" | "disable" | null>(null);
  const [enrollment, setEnrollment] = useState<AccountEnrollment | null>(null);
  const [recovery, setRecovery] = useState<{ codes: string[]; user?: User } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), mounted = useRef(true), sequence = useRef(0);
  const expiry = useExpiry(enrollment?.expires_at);
  const reload = useCallback(async () => {
    const request = ++sequence.current; setLoading(true);
    try {
      const value = isStandalonePreview ? { available: false, required: false, mfa_enabled: false, recovery_codes_remaining: 0 } : await api<SecurityStatus>("/account/mfa");
      if (mounted.current && request === sequence.current) { setStatus(value); setError(""); }
      return value;
    } catch (cause) { if (mounted.current && request === sequence.current) setError(errorText(cause)); throw cause; }
    finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [user.id, user.practice?.id]);
  useEffect(() => { mounted.current = true; void reload().catch(() => {}); return () => { mounted.current = false; sequence.current++; }; }, [reload]);
  useEffect(() => { if (expiry.expired) { setEnrollment(null); setCode(""); setError("Authenticator setup expired. Enter your password to start a fresh setup."); } }, [expiry.expired]);
  function choose(next: "enroll" | "regenerate" | "disable" | null) {
    setAction(next); setPassword(""); setCode(""); setError(""); setNotice(""); setEnrollment(null);
  }
  async function mutate(event: FormEvent) {
    event.preventDefault(); if (!action || pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (action === "enroll" && !enrollment) {
        const setup = await post<AccountEnrollment | { ok: false; error: string; attempts_remaining?: number }>("/account/mfa/setup", { password });
        if (mounted.current) {
          if ("ok" in setup && !setup.ok) { setError(setup.error); return; }
          setEnrollment(setup as AccountEnrollment); setCode("");
        }
        return;
      }
      const result = await post<AccountSecurityResult>(action === "enroll" ? "/account/mfa/confirm" : action === "regenerate" ? "/account/mfa/recovery-codes" : "/account/mfa/disable", action === "enroll" ? { enrollment_id: enrollment!.enrollment_id, code: code.trim() } : { password, code: code.trim() });
      if (!mounted.current) return;
      if (!result.ok) { setError(`${result.error}${result.attempts_remaining ? ` ${result.attempts_remaining} attempts remaining.` : ""}`); return; }
      // Confirmed mutations stay committed even if the status GET fails.
      setEnrollment(null); setAction(null);
      setStatus(previous => previous ? { ...previous, mfa_enabled: action !== "disable", recovery_codes_remaining: result.recovery_codes?.length ?? (action === "disable" ? 0 : previous.recovery_codes_remaining) } : previous);
      if (result.recovery_codes?.length) setRecovery({ codes: result.recovery_codes, user: result.user });
      else { if (result.user) onUserChanged(result.user); setNotice("Authenticator verification disabled. Other sessions have been signed out."); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setPassword(""); setCode(""); } }
  }
  return <section className="panel account-panel access-security" aria-labelledby="access-settings-heading">
    <div className="access-heading"><ShieldCheck size={23} /><div><h2 id="access-settings-heading">Authenticator verification</h2><p>Add an authenticator to protect sign-ins for {user.email}.</p></div></div>
    {loading && !status && <p role="status">Loading account security…</p>}
    {status && <>
      <div className="access-status"><span className={status.mfa_enabled ? "enabled" : ""}>{status.mfa_enabled ? "Authenticator enabled" : "Authenticator not enabled"}</span>{status.required && <span>Required by this environment</span>}</div>
      {!status.available && <p className="access-hint">{isStandalonePreview ? "Authenticator setup is available on the connected server. This offline preview does not simulate account MFA." : "Authenticator setup requires the server’s configured encryption key. Ask your administrator to finish secure account configuration."}</p>}
      {status.available && !recovery && !action && <>
        {status.mfa_enabled ? <><p className="access-hint">{status.recovery_codes_remaining} unused recovery codes remain. Each code can be used once instead of an authenticator code.</p>
          <div className="access-actions"><button type="button" className="button secondary" onClick={() => choose("regenerate")}>Replace recovery codes</button>{!status.required && <button type="button" className="text-button" onClick={() => choose("disable")}>Disable authenticator</button>}</div>
        </> : <button type="button" className="button secondary" onClick={() => choose("enroll")}><KeyRound size={15} />Set up authenticator</button>}
      </>}
      {action && !recovery && <form className="access-form" onSubmit={mutate}>
        <h3>{action === "enroll" ? enrollment ? "Confirm authenticator setup" : "Verify your password" : action === "regenerate" ? "Replace your recovery codes" : "Disable authenticator verification"}</h3>
        {enrollment ? <><AuthenticatorInstructions setup={enrollment} /><p className="access-hint">Setup expires in {expiry.label}.</p></> : <label>Your current password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={200} required disabled={busy} /></label>}
        {(enrollment || action !== "enroll") && <label>Current authenticator code<input value={code} onChange={event => setCode(event.target.value)} type="text" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} spellCheck={false} required disabled={busy} /></label>}
        {action === "regenerate" && <p className="access-hint">This replaces every previous recovery code and signs out other sessions. Save the new codes privately.</p>}
        {action === "disable" && <p className="access-hint">Disabling removes authenticator protection and signs out other sessions. Environments that require MFA do not allow disabling it.</p>}
        <div className="access-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => choose(null)}>Cancel</button><button className="button primary" disabled={busy || (enrollment ? expiry.expired || code.length !== 6 : !password || (action !== "enroll" && code.length !== 6))}><LockKeyhole size={15} />{busy ? "Verifying…" : action === "enroll" ? enrollment ? "Confirm authenticator" : "Continue setup" : action === "regenerate" ? "Replace recovery codes" : "Disable authenticator"}</button></div>
      </form>}
      {recovery && <RecoveryCodes codes={recovery.codes} onContinue={() => { const nextUser = recovery.user; setRecovery(null); setNotice("Authenticator security saved. Keep your recovery codes private."); if (nextUser) onUserChanged(nextUser); }} />}
    </>}
    <ErrorMessage message={error} />{error && !busy && <button className="text-button" type="button" onClick={() => void reload().catch(() => {})}><RefreshCw size={14} />Reload account security</button>}
    {notice && <p className="access-success" role="status"><Check size={14} />{notice}</p>}
  </section>;
}
