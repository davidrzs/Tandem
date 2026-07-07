import { adminClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same-origin in dev (Vite proxies /api/auth -> :3001), so cookies just work.
// adminClient() surfaces authClient.admin.* (list/role/ban/delete users) for
// the admin console; twoFactorClient() surfaces authClient.twoFactor.*
// (enable/verify/disable TOTP). The server enforces both plugins' checks.
export const authClient = createAuthClient({
  plugins: [adminClient(), twoFactorClient()],
});
