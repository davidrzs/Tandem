import { useState } from "react";
import { authClient } from "../auth-client.js";

/**
 * Per-user TOTP enrollment (Settings). Enable asks for the password, shows the
 * otpauth secret to enter into an authenticator app plus the single-use backup
 * codes, and activates only after a first code verifies. Disable asks for the
 * password again.
 */
export function TwoFactorSection() {
  const session = authClient.useSession();
  const enabled = !!(session.data?.user as { twoFactorEnabled?: boolean } | undefined)
    ?.twoFactorEnabled;

  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const res = await authClient.twoFactor.enable({ password });
      if (res.error) throw new Error(res.error.message ?? "Couldn't start enrollment");
      setPending({ totpURI: res.data.totpURI, backupCodes: res.data.backupCodes });
      setPassword("");
    });

  const verify = () =>
    run(async () => {
      const res = await authClient.twoFactor.verifyTotp({ code: verifyCode.trim() });
      if (res.error) throw new Error(res.error.message ?? "That code didn't work");
      setPending(null);
      setVerifyCode("");
      setMessage("Two-factor authentication is on.");
      await session.refetch();
    });

  const disable = () =>
    run(async () => {
      const res = await authClient.twoFactor.disable({ password });
      if (res.error) throw new Error(res.error.message ?? "Couldn't turn 2FA off");
      setPassword("");
      setMessage("Two-factor authentication is off.");
      await session.refetch();
    });

  // The otpauth URI carries the base32 secret for manual entry.
  const secret = pending ? new URL(pending.totpURI).searchParams.get("secret") : null;

  return (
    <>
      <h3>Two-factor authentication</h3>
      {enabled && !pending && (
        <>
          <p className="modal-note">
            On — signing in requires a code from your authenticator app.
          </p>
          <div className="invite-row">
            <input
              type="password"
              placeholder="Confirm password to turn off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn danger" disabled={busy || !password} onClick={disable}>
              Turn off 2FA
            </button>
          </div>
        </>
      )}
      {!enabled && !pending && (
        <>
          <p className="modal-note">
            Off — protect this account with a code from an authenticator app.
          </p>
          <div className="invite-row">
            <input
              type="password"
              placeholder="Confirm password to set up"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button className="btn" disabled={busy || !password} onClick={start}>
              Set up 2FA
            </button>
          </div>
        </>
      )}
      {pending && (
        <>
          <p className="modal-note">
            Add this secret to your authenticator app (manual entry), then confirm
            with a code. Save the backup codes somewhere safe — each works once if
            you lose the device.
          </p>
          <input
            className="invite-link"
            readOnly
            value={secret ?? pending.totpURI}
            onFocus={(e) => e.currentTarget.select()}
          />
          <input
            className="invite-link"
            readOnly
            value={pending.backupCodes.join("  ")}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="invite-row">
            <input
              placeholder="6-digit code"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
            />
            <button className="btn primary" disabled={busy || !verifyCode.trim()} onClick={verify}>
              Confirm & enable
            </button>
          </div>
        </>
      )}
      {message && <p className="modal-note">{message}</p>}
      {error && <div className="modal-error">{error}</div>}
    </>
  );
}
