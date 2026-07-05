// Shared e2e helpers matching the current UI (paper-&-ink design system:
// modal dialogs, hover-revealed row actions). Import into the *.mjs scripts.
export const BASE = "http://localhost:5173";

/** Sign up a fresh account and land on the app shell. */
export async function signUp(page, name = "E2E User") {
  await page.goto(BASE);
  await page.getByText("Need an account? Sign up").click();
  await page.fill('input[placeholder="Name"]', name);
  await page.fill('input[type="email"]', `e2e${Date.now()}${Math.floor(performance.now())}@example.com`);
  await page.fill('input[type="password"]', "supersecret123");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar");
}

/** Create a collection via the New-collection modal; resolve once it appears. */
export async function createCollection(page, name) {
  await page.locator('.row-action[title="New collection"]').click();
  const modal = page.locator(".dialog-form");
  await modal.locator("input").fill(name);
  await modal.getByRole("button", { name: "Create collection" }).click();
  await page.getByText(name, { exact: true }).waitFor();
}

/** Create a document in the named collection and wait for the editor. */
export async function newDocument(page, collectionName) {
  const row = page.locator(".collection-row", { hasText: collectionName });
  await row.hover();
  await row.locator('.row-action[title="New document"]').click();
  await page.waitForURL(/\/d\//);
  await page.waitForSelector(".ProseMirror");
}
