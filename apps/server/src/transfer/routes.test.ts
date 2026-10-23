import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createDatabase, migrateDatabase, user, workspaceMembers } from "@tandem/db";
import { buildHttpServer } from "../http.js";
import { createServices } from "../services.js";
import { EXPORT_WARNINGS_HEADER } from "./routes.js";

process.env.BETTER_AUTH_SECRET ??= "test-secret-value-at-least-16-chars-long";

test("GET /api/export sends the export's warnings in a header", async () => {
  const db = createDatabase("memory://");
  await migrateDatabase(db);
  const app = await buildHttpServer(db);
  await app.ready();
  try {
    await app.inject({
      method: "POST",
      url: "/api/setup/init",
      payload: { name: "Admin", email: "admin@x.com", password: "password123", registrationMode: "open" },
    });
    const signin = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "admin@x.com", password: "password123" },
    });
    const setCookie = signin.headers["set-cookie"];
    const cookie = [setCookie]
      .flat()
      .map((c) => String(c).split(";")[0])
      .join("; ");
    const [admin] = await db.select().from(user).where(eq(user.email, "admin@x.com"));
    const [member] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, admin!.id));
    const workspaceId = member!.workspaceId;
    const services = createServices(
      db,
      { kind: "user", userId: admin!.id },
      { userId: admin!.id, name: "Admin", ai: false },
    );
    const col = await services.collections.create({ workspaceId, name: "Notes", slug: "notes" });
    await services.documents.create({
      collectionId: col.id,
      title: "Café",
      markdown: "![gone](/api/images/00000000-0000-4000-8000-000000000000)",
    });
    await services.types.createField({ workspaceId, typeId: null, key: "Tags", kind: "text" });
    await services.types.createField({ workspaceId, typeId: null, key: "tandem-id", kind: "text" });

    const res = await app.inject({ method: "GET", url: `/api/export?workspace=${workspaceId}`, headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(JSON.parse(decodeURIComponent(String(res.headers[EXPORT_WARNINGS_HEADER]))), [
      'Values of the field "Tags" aren\'t in the export: front matter uses that key for itself.',
      'Values of the field "tandem-id" aren\'t in the export: front matter uses that key for itself.',
      'image 00000000-0000-4000-8000-000000000000 in "Café" is unavailable — link left as-is',
    ]);
  } finally {
    await app.close();
    await db.$dispose();
  }
});
