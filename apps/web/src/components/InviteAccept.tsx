import { useEffect, useRef, useState } from "react";
import { WS_KEY } from "../App.js";
import { trpc } from "../trpc.js";

export function InviteAccept({ token }: { token: string }) {
  const accept = trpc.workspaces.acceptInvite.useMutation();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // mutateAsync's promise survives StrictMode's mount/unmount/mount, unlike
    // per-call onSuccess callbacks. A full navigation re-fetches everything.
    accept
      .mutateAsync({ token })
      .then((ws) => {
        // Land in the workspace that was just joined, not the previous one.
        localStorage.setItem(WS_KEY, ws.id);
        window.location.assign("/");
      })
      .catch((e: { message?: string }) => setError(e.message ?? "Failed to join"));
  }, [token, accept]);

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>{error ? "Couldn't join" : "Joining workspace…"}</h1>
        {error && <div className="auth-error">{error}</div>}
        {error && (
          <a className="auth-toggle" href="/">
            Back to app
          </a>
        )}
      </div>
    </div>
  );
}
