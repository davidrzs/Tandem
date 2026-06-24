// Two-client realtime collaboration proof. Two isolated browser contexts open
// the same document; edits made in one appear live in the other via Yjs +
// Hocuspocus. Assumes web (5173) + api (3001) are running (see run.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const stamp = Date.now();
const collectionName = `Collab ${stamp}`;
const title = `Shared Doc ${stamp}`;

const browser = await chromium.launch();
const errors = [];
// Same user, two clients (two tabs/devices) — they share a workspace, so they
// collaborate. (Cross-user sharing is future work; tenant isolation is enforced.)
const account = `collab-${stamp}@example.com`;
const password = "supersecret123";

async function enter(ctx, label, mode) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
  await page.goto(BASE);
  if (mode === "signup") {
    await page.getByText("Need an account? Sign up").click();
    await page.fill('input[placeholder="Name"]', "Collaborator");
  }
  await page.fill('input[type="email"]', account);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar");
  return page;
}

try {
  // Client A: sign up, create the collection + document, type into it.
  const ctxA = await browser.newContext();
  const a = await enter(ctxA, "ClientA", "signup");
  await a.fill(".new-collection input", collectionName);
  await a.press(".new-collection input", "Enter");
  await a.waitForSelector(".add");
  await a.click(".add");
  await a.waitForSelector(".title-input");
  await a.fill(".title-input", title);
  await a.click(".ProseMirror");
  await a.type(".ProseMirror", "Hello from A.");
  // Confirm the title persisted into A's own sidebar (so B's tree sees it too),
  // and let the Yjs body update reach the server.
  await a.getByText(title, { exact: true }).first().waitFor({ timeout: 10000 });
  await a.waitForTimeout(800);

  // Client B: the SAME user in a second context (same workspace) opens the doc.
  const ctxB = await browser.newContext();
  const b = await enter(ctxB, "ClientB", "signin");
  await b.getByText(collectionName, { exact: true }).click();
  await b.getByText(title, { exact: true }).click();
  await b.waitForSelector(".ProseMirror");

  // B sees A's text live.
  await b.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("Hello from A."),
    { timeout: 10000 },
  );

  // B appends; A sees B's text live (bidirectional).
  await b.click(".ProseMirror");
  await b.keyboard.press("End");
  await b.type(".ProseMirror", " And hello from B.");

  await a.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("And hello from B."),
    { timeout: 10000 },
  );

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("COLLAB PASS — edits sync live in both directions between two clients");
} finally {
  await browser.close();
}
