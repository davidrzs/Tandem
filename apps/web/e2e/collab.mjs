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

async function signUp(ctx, label) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
  await page.goto(BASE);
  await page.getByText("Need an account? Sign up").click();
  await page.fill('input[placeholder="Name"]', label);
  await page.fill('input[type="email"]', `${label}-${stamp}@example.com`);
  await page.fill('input[type="password"]', "supersecret123");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar");
  return page;
}

try {
  // Author A: create the collection + document and type into it.
  const ctxA = await browser.newContext();
  const a = await signUp(ctxA, "AuthorA");
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

  // Reader B: a different account opens the SAME document (reads are public).
  // Select by collection name (reliable) then the single doc row (no reliance
  // on the debounced title propagating to B's tree).
  const ctxB = await browser.newContext();
  const b = await signUp(ctxB, "ReaderB");
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
