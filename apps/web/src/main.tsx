import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { App } from "./App.js";
import { AuthGate } from "./components/AuthGate.js";
import { ConsentScreen } from "./components/ConsentScreen.js";
import { DocumentPage } from "./components/DocumentPage.js";
import { Home } from "./components/Home.js";
import { InviteAccept } from "./components/InviteAccept.js";
import { authorizeResumeQuery, consentContext } from "./oauth.js";
import { trpc } from "./trpc.js";
import "@fontsource-variable/inter";
import "@fontsource-variable/source-serif-4";
import "katex/dist/katex.min.css";
import "./styles.css";

// Auth-flow pages (OAuth consent, resume, invites) render outside the app
// shell; everything else is the wiki behind the router. AuthGate guarantees a
// session before any of it renders.
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

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Home />} />
          <Route path="d/:docId" element={<DocumentPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
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
