import { createTransport } from "nodemailer";

/**
 * Outbound email is an optional capability: configured via SMTP_URL (+
 * EMAIL_FROM), absent otherwise. Callers must degrade gracefully — without a
 * mailer, invites are copy-link only and password reset is admin-assisted.
 */
export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/**
 * Build the SMTP mailer from env, or null when SMTP_URL isn't set.
 * SMTP_URL: smtp(s)://user:pass@host:port (nodemailer connection URL).
 * EMAIL_FROM: the From header, e.g. `Tandem <tandem@example.com>` — required
 * alongside SMTP_URL so a half-configured instance fails at boot, not on the
 * first reset request.
 */
export function createMailerFromEnv(): Mailer | null {
  const url = process.env.SMTP_URL;
  if (!url) return null;
  const from = process.env.EMAIL_FROM;
  if (!from) {
    throw new Error("EMAIL_FROM must be set when SMTP_URL is configured");
  }
  const transport = createTransport(url);
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
  };
}
