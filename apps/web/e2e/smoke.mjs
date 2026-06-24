// Headless browser smoke test for the full Phase 2 loop:
// UI -> tRPC -> core -> Postgres -> reload -> persisted. Assumes web (5173)
// and api (3001) are already running. Run via apps/web/e2e/run.sh.
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const collectionName = `E2E ${Date.now()}`;
const title = "Setup Guide";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

try {
  await page.goto(BASE);

  // Sign up (writes are auth-gated). The gate then renders the app.
  await page.getByText("Need an account? Sign up").click();
  await page.fill('input[placeholder="Name"]', "E2E User");
  await page.fill('input[type="email"]', `e2e${Date.now()}@example.com`);
  await page.fill('input[type="password"]', "supersecret123");
  await page.click('button[type="submit"]');

  // Create a collection (name comes from a prompt) and open it.
  await page.waitForSelector(".sidebar");
  page.once("dialog", (d) => d.accept(collectionName));
  await page.locator(".section", { hasText: "Collections" }).locator(".add").click();
  await page.getByText(collectionName, { exact: true }).click();

  // Add a document.
  await page.locator(".section", { hasText: "Documents" }).locator(".add").click();

  // Editor mounts.
  await page.waitForSelector(".title-input");
  await page.fill(".title-input", title);

  // Type a markdown heading (input rule) + a body paragraph in the editor.
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "# Heading One");
  await page.press(".ProseMirror", "Enter");
  await page.type(".ProseMirror", "Install pnpm first.");

  // Body persists via Yjs/Hocuspocus (debounced ~2s server-side). Confirm the
  // heading rendered, then settle past the store debounce before reloading.
  await page.waitForSelector(".ProseMirror h1");
  await page.waitForTimeout(3000);

  // Reload and re-open the document from scratch.
  await page.reload();
  await page.getByText(collectionName).click();
  await page.getByText(title, { exact: true }).click();
  await page.waitForSelector(".title-input");

  const persistedTitle = await page.inputValue(".title-input");
  const body = (await page.textContent(".ProseMirror")) ?? "";

  if (persistedTitle !== title) throw new Error(`title not persisted: "${persistedTitle}"`);
  if (!body.includes("Heading One")) throw new Error(`heading not persisted: "${body}"`);
  if (!body.includes("Install pnpm first.")) throw new Error(`body not persisted: "${body}"`);

  // Confirm the markdown heading actually round-tripped to an <h1>.
  const h1 = await page.textContent(".ProseMirror h1");
  if (!h1 || !h1.includes("Heading One")) throw new Error("markdown heading did not become an <h1>");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);

  console.log("E2E PASS — title + markdown body persisted across reload, heading rendered as <h1>");
} finally {
  await browser.close();
}
