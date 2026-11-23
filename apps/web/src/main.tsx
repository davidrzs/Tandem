import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import React, { lazy, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App.js";
import { AuthGate, ResetPassword } from "./components/AuthGate.js";
import { ConsentScreen } from "./components/ConsentScreen.js";
import { CollectionPage } from "./components/CollectionPage.js";
import { Home } from "./components/Home.js";
import { InviteAccept } from "./components/InviteAccept.js";
import { SetupWizard } from "./components/SetupWizard.js";
import { ToastProvider } from "./components/toast.js";
import { authorizeResumeQuery, consentContext } from "./oauth.js";
import { initTheme } from "./theme.js";
import { trpc } from "./trpc.js";

initTheme();
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

// The editor (Tiptap + ProseMirror + Yjs + KaTeX + lowlight) is by far the
// heaviest code; loading it only when a document is opened keeps first paint of
// the shell + start page fast. KaTeX's CSS rides along in the editor chunk.
const DocumentPage = lazy(() =>
  import("./components/DocumentPage.js").then((m) => ({ default: m.DocumentPage })),
);

// Auth-flow pages (OAuth consent, resume, invites) render outside the app
// shell; everything else is the wiki behind the router. AuthGate guarantees a
// session before any of it renders.
function Routed() {
  const consent = consentContext();
  if (consent) return <ConsentScreen request={consent} />;

  const resume = authorizeResumeQuery();
  if (resume) {
    window.location.href = `/api/auth/mcp/authorize${resume}`;
    return <div className="empty">Continuing sign-in…</div>;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Home />} />
          <Route path="c/:collectionId" element={<CollectionPage />} />
          <Route path="d/:docId" element={<DocumentPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

// On a brand-new install (no users yet) the server needs its first admin, so
// the setup wizard stands in for the login screen. This check sits ABOVE
// AuthGate because setup happens without a session. Once an admin exists the
// status is false forever and this adds a single fast fetch on load.
function Bootstrap() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((d: { needsSetup?: boolean }) => setNeedsSetup(!!d.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  if (needsSetup === null) return <div className="empty"><span className="shimmer">Loading…</span></div>;
  if (needsSetup) return <SetupWizard onComplete={() => setNeedsSetup(false)} />;

  // Invite redemption must work for logged-out invitees (they sign up through
  // the invite), so it sits ABOVE AuthGate.
  if (window.location.pathname === "/invite") {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) return <InviteAccept token={token} />;
  }

  // The emailed password-reset link also lands without a session.
  if (window.location.pathname === "/reset-password") {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) return <ResetPassword token={token} />;
  }

  return (
    <AuthGate>
      <Routed />
    </AuthGate>
  );
}

/** A client error (not found, forbidden, bad input) won't change on retry. */
function retryable(failureCount: number, error: unknown): boolean {
  const status = error instanceof TRPCClientError ? error.data?.httpStatus : undefined;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  return failureCount < 2;
}

function newQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // No global staleTime: much of what queries show (tasks, backlinks,
        // recents, members, instance settings) changes through live document
        // sync or other people, not through a mutation here that could
        // invalidate it, so cached data must stay refetchable on navigation.
        retry: retryable,
      },
    },
  });
}

function Root() {
  const [queryClient] = useState(newQueryClient);
  const [trpcClient] = useState(() =>
    trpc.createClient({ links: [httpBatchLink({ url: "/trpc" })] }),
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Bootstrap />
        </ToastProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
