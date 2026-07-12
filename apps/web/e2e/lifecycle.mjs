// Document lifecycle: archive a doc (leaves the tree), then restore it. Needs
// web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Life User");
  const c = `Life ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  await page.fill(".title-input", "Archive Me");
  await page.waitForTimeout(700);
  const docUrl = page.url();

  // Archive via the doc-row menu.
  const row = page.locator(".doc-row", { hasText: "Archive Me" });
  await row.hover();
  await row.locator('.row-action[title="More actions"]').click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/d/"));

  // It's gone from the active tree.
  // Scoped to the sidebar: the doc-page breadcrumb also shows the name.
  await page.locator(".collection-row").getByText(c, { exact: true }).click(); // ensure expanded
  if ((await page.locator(".doc-row", { hasText: "Archive Me" }).count()) !== 0) {
    throw new Error("archived doc still in the active tree");
  }

  // Reopening it shows the archived banner; Restore brings it back.
  await page.goto(docUrl);
  await page.waitForSelector(".archived-banner");
  await page.getByRole("button", { name: "Restore" }).click();
  await page.waitForSelector(".archived-banner", { state: "detached" });

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("LIFECYCLE PASS — archive removes from the tree; restore brings it back");
} finally {
  await browser.close();
}
