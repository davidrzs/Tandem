import assert from "node:assert/strict";
import { test } from "node:test";
import { createDatabase, migrateDatabase } from "@tandem/db";
import { createAuth } from "./auth.js";
import { createMailerFromEnv, type Mailer } from "./mail.js";

// Email is an optional capability: with a mailer, password reset works
// end-to-end through Better Auth; without one, requests degrade instead of
// sending anything. The fake mailer just records outbound messages.

function fakeMailer() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mailer: Mailer = {
    send: async (msg) => {
      sent.push(msg);
    },
  };
  return { mailer, sent };
}

async function fresh(mailer?: Mailer | null) {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  return { db, auth: createAuth(db, mailer) };
}

test("password reset emails a link when SMTP is configured", async () => {
  const { mailer, sent } = fakeMailer();
  const { auth } = await fresh(mailer);
  await auth.api.signUpEmail({
    body: { name: "alice", email: "alice@acme.com", password: "password123" },
  });

  await auth.api.requestPasswordReset({
    body: { email: "alice@acme.com", redirectTo: "/reset-password" },
  });

  assert.equal(sent.length, 1, "one reset email sent");
  assert.equal(sent[0]!.to, "alice@acme.com");
  assert.match(sent[0]!.subject, /reset/i);
  assert.match(sent[0]!.text, /https?:\/\/\S+/, "carries the reset link");
});

test("a reset request for an unknown account sends nothing (no enumeration)", async () => {
  const { mailer, sent } = fakeMailer();
  const { auth } = await fresh(mailer);
  await auth.api.signUpEmail({
    body: { name: "alice", email: "alice@acme.com", password: "password123" },
  });

  // Better Auth answers 200 either way; the observable is the outbox.
  await auth.api
    .requestPasswordReset({ body: { email: "nobody@acme.com", redirectTo: "/reset-password" } })
    .catch(() => {});
  assert.equal(sent.length, 0, "no email for a non-account");
});

test("without a mailer, password reset degrades and never throws unhandled", async () => {
  const { auth } = await fresh(null);
  await auth.api.signUpEmail({
    body: { name: "bob", email: "bob@acme.com", password: "password123" },
  });
  // No sendResetPassword is configured; the endpoint must not crash the server.
  await auth.api
    .requestPasswordReset({ body: { email: "bob@acme.com", redirectTo: "/reset-password" } })
    .catch(() => {
      // An APIError here is acceptable — the UI never offers the flow.
    });
});

test("createMailerFromEnv: absent without SMTP_URL, strict about EMAIL_FROM", () => {
  const prevUrl = process.env.SMTP_URL;
  const prevFrom = process.env.EMAIL_FROM;
  try {
    delete process.env.SMTP_URL;
    delete process.env.EMAIL_FROM;
    assert.equal(createMailerFromEnv(), null, "no SMTP_URL -> no mailer");

    process.env.SMTP_URL = "smtp://user:pass@mail.example.com:587";
    assert.throws(
      () => createMailerFromEnv(),
      /EMAIL_FROM/,
      "SMTP_URL without EMAIL_FROM fails at boot",
    );

    process.env.EMAIL_FROM = "Tandem <tandem@example.com>";
    assert.ok(createMailerFromEnv(), "fully configured -> mailer");
  } finally {
    if (prevUrl === undefined) delete process.env.SMTP_URL;
    else process.env.SMTP_URL = prevUrl;
    if (prevFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = prevFrom;
  }
});
