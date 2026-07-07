import type { Database } from "@tandem/db";
import { InstanceService, type RegistrationMode } from "@tandem/core";
import type { FastifyInstance } from "fastify";
import type { Auth } from "./auth.js";

const MODES: RegistrationMode[] = ["open", "invite", "domain", "closed"];

/**
 * Unauthenticated instance-bootstrap routes. These exist because tRPC is
 * entirely session-gated and so can't answer pre-auth questions: whether the
 * server still needs its first admin (setup wizard), the public branding /
 * registration policy (login screen), and the one-time first-admin creation.
 */
export async function registerSetupRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const instance = new InstanceService(db);

  // Does the server still need its first admin? Drives the setup wizard.
  app.get("/api/setup/status", async () => ({ needsSetup: await instance.needsSetup() }));

  // Safe subset for the login/signup screen (branding + registration policy).
  app.get("/api/instance/public", async () => instance.getPublicSettings());

  // Create the first admin + the initial registration policy. Guarded so it is
  // usable exactly once (when no user exists); the client status check is only
  // UX — this server-side re-check is the real lock.
  app.post(
    "/api/setup/init",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as {
        name?: string;
        email?: string;
        password?: string;
        registrationMode?: string;
        allowedEmailDomains?: string[];
        instanceName?: string;
      };

      if (!(await instance.needsSetup())) {
        return reply.code(403).send({ error: "setup already completed" });
      }

      const name = body.name?.trim();
      const email = body.email?.trim();
      const password = body.password ?? "";
      if (!name || !email || password.length < 8) {
        return reply
          .code(400)
          .send({ error: "name, email, and a password of at least 8 characters are required" });
      }
      const mode: RegistrationMode = MODES.includes(body.registrationMode as RegistrationMode)
        ? (body.registrationMode as RegistrationMode)
        : "invite";

      // Settings first, account second: if account creation fails the wizard
      // shows again (needsSetup still true) with the policy already correct, so
      // there's no window where the instance is unexpectedly open.
      await instance.updateSettings({
        registrationMode: mode,
        allowedEmailDomains: body.allowedEmailDomains ?? [],
        ...(body.instanceName?.trim() ? { instanceName: body.instanceName.trim() } : {}),
      });

      try {
        // First user → the registration gate allows it and stamps role 'admin'.
        await auth.api.signUpEmail({ body: { name, email, password } });
      } catch (err) {
        const message = err instanceof Error ? err.message : "sign-up failed";
        return reply.code(400).send({ error: message });
      }

      // The client signs in next to obtain a session cookie.
      return reply.send({ ok: true });
    },
  );
}
