// Headless browser smoke test for the full Phase 2 loop:
// UI -> tRPC -> core -> Postgres -> reload -> persisted. Assumes web (5173)
// and api (3001) are already running. Run via apps/web/e2e/run.sh.
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const collectionName = `E2E ${Date.now()}`;
const title = "Setup Guide";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

try {
  await signUp(page, "E2E User");
  await createCollection(page, collectionName);
  await newDocument(page, collectionName);

  // Editor mounts.
  await page.waitForSelector(".title-input");
  await page.fill(".title-input", title);

  // Type a markdown heading (input rule) + a body paragraph in the editor.
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "# Heading One");
  await page.press(".ProseMirror", "Enter");
  await page.type(".ProseMirror", "Install pnpm first.");

  // Body persists via Yjs/Hocuspocus (debounced ~2s server-side). Confirm the
  // heading rendered, then settle well past the store debounce before reload
  // (so a fresh load from the DB has the content, not just Hocuspocus memory).
  await page.waitForSelector(".ProseMirror h1");
  await page.waitForTimeout(4000);

  // Reload: a fresh page load re-reads the document from the DB (and re-syncs
  // Yjs from scratch), which is exactly the persistence path under test.
  await page.reload();
  await page.waitForSelector(".title-input");

  // Body arrives via Yjs sync after the provider reconnects — wait for it.
  await page.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("Install pnpm first."),
    { timeout: 10000 },
  );
  const persistedTitle = await page.inputValue(".title-input");
  const body = (await page.textContent(".ProseMirror")) ?? "";

  if (persistedTitle !== title) throw new Error(`title not persisted: "${persistedTitle}"`);
  if (!body.includes("Heading One")) throw new Error(`heading not persisted: "${body}"`);

  // Confirm the markdown heading actually round-tripped to an <h1>.
  const h1 = await page.textContent(".ProseMirror h1");
  if (!h1 || !h1.includes("Heading One")) throw new Error("markdown heading did not become an <h1>");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);

  console.log("E2E PASS — title + markdown body persisted across reload, heading rendered as <h1>");
} finally {
  await browser.close();
}
