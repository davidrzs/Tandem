import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDatabase, migrateDatabase, user } from "@tandem/db";
import { LOCAL_AGENT, resolveLocalAuthor } from "./services.js";

const db = createDatabase("memory://");

before(async () => {
  await migrateDatabase(db);
  await db.insert(user).values({
    id: "u-david",
    name: "David Zollikofer",
    email: "david@example.com",
    updatedAt: new Date(),
  });
});

after(async () => {
  await db.$dispose();
});

test("TANDEM_USER resolves the stdio agent to the human's AI identity", async () => {
  const byEmail = await resolveLocalAuthor(db, "david@example.com");
  assert.deepEqual(byEmail, { userId: "u-david", name: "David Zollikofer", ai: true });

  const byId = await resolveLocalAuthor(db, "u-david");
  assert.equal(byId.userId, "u-david");
});

test("unset TANDEM_USER falls back to the ownerless local agent", async () => {
  assert.deepEqual(await resolveLocalAuthor(db, undefined), LOCAL_AGENT);
  assert.deepEqual(await resolveLocalAuthor(db, "  "), LOCAL_AGENT);
});

test("an unknown TANDEM_USER fails loud instead of misattributing", async () => {
  await assert.rejects(
    () => resolveLocalAuthor(db, "typo@example.com"),
    /does not match any user/,
  );
});
