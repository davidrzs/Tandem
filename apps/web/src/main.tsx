import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { AuthGate } from "./components/AuthGate.js";
import { ConsentScreen } from "./components/ConsentScreen.js";
import { InviteAccept } from "./components/InviteAccept.js";
import { authorizeResumeQuery, consentContext } from "./oauth.js";
import { trpc } from "./trpc.js";
import "./styles.css";

// Routing for the no-router SPA: the wiki, the OAuth consent screen, or
// resuming a pending authorize request after sign-in. AuthGate guarantees a
// session before any of these render.
function Routed() {
  if (window.location.pathname === "/invite") {
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) return <InviteAccept token={token} />;
  }

  const consent = consentContext();
  if (consent) return <ConsentScreen request={consent} />;

  const resume = authorizeResumeQuery();
  if (resume) {
    window.location.href = `/api/auth/mcp/authorize${resume}`;
    return <div className="empty">Continuing sign-in…</div>;
  }

  return <App />;
}

function Root() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({ links: [httpBatchLink({ url: "/trpc" })] }),
  );
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <Routed />
        </AuthGate>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
