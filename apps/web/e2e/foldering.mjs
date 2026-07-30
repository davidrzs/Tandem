// Collapsible document folders: a parent doc's twist hides its children, the
// fold state survives a reload with localStorage wiped (DB-persisted), and
// opening a child directly reveals its ancestors. Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Fold User");
  const c = `Fold ${Date.now()}`;
  await createCollection(page, c);

  await newDocument(page, c);
  await page.fill(".title-input", "Parent Doc");
  await page.waitForTimeout(700);

  // Nest a child via the parent row's action; we land on the child page.
  // Wait for the URL to CHANGE (we already sit on the parent's /d/ page).
  const parentPath = new URL(page.url()).pathname;
  const parentRow = page.locator(".doc-row", { hasText: "Parent Doc" });
  await parentRow.hover();
  await parentRow.locator('.row-action[title="New sub-document"]').click();
  await page.waitForURL((u) => u.pathname !== parentPath && u.pathname.startsWith("/d/"));
  await page.waitForSelector(".ProseMirror");
  await page.fill(".title-input", "Child Doc");
  await page.waitForTimeout(700);
  const childUrl = page.url();

  const childRow = page.locator(".doc-row", { hasText: "Child Doc" });
  await childRow.waitFor();

  // Collapse the parent: the child leaves the tree.
  await parentRow.locator("button.doc-twist").click();
  await childRow.waitFor({ state: "detached" });
  if ((await parentRow.count()) !== 1) throw new Error("parent row gone after collapse");

  // Expand again: the child comes back (the toggle must be two-way).
  await parentRow.locator("button.doc-twist").click();
  await childRow.waitFor();

  // Collapse once more, waiting for the persist to reach the server — the
  // upcoming reload must restore fold state from the DB alone.
  const persisted = page.waitForResponse(
    (r) => r.url().includes("settings.setSidebarNode") && r.ok(),
  );
  await parentRow.locator("button.doc-twist").click();
  await childRow.waitFor({ state: "detached" });
  await persisted;

  await page.goto("http://localhost:5173/");
  await page.waitForSelector(".sidebar");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".sidebar");
  await parentRow.waitFor(); // collection unfolds from DB state
  if ((await childRow.count()) !== 0) {
    throw new Error("child visible after reload — collapse not restored from DB");
  }

  // Opening the child directly reveals its ancestors in the tree.
  await page.goto(childUrl);
  await page.waitForSelector(".ProseMirror");
  await childRow.waitFor();

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "FOLDERING PASS — twist folds the subtree; state survives localStorage wipe; ancestors reveal",
  );
} finally {
  await browser.close();
}
