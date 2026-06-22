import { createAuthClient } from "better-auth/react";

// Same-origin in dev (Vite proxies /api/auth -> :3001), so cookies just work.
export const authClient = createAuthClient();
