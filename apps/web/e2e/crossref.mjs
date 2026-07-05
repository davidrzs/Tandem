// Cross-references: @-link one page from another, verify the chip and the
// "Linked from" backlink, and that renaming the target updates the chip.
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Ref User");
  const c = `Refs ${Date.now()}`;
  await createCollection(page, c);

  // Target document.
  await newDocument(page, c);
  await page.fill(".title-input", "Target Page");
  await page.waitForTimeout(800); // title-save debounce, so search can find it
  const targetUrl = page.url();

  // Source document that @-links the target.
  await newDocument(page, c);
  await page.fill(".title-input", "Source Page");
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "See ");
  await page.type(".ProseMirror", "@Tar"); // @ + >=2 chars → documents appear
  await page.waitForSelector(".slash-menu");
  await page.locator(".slash-item", { hasText: "Target Page" }).click();

  // The chip renders with the target's title.
  await page.locator(".ProseMirror .page-ref", { hasText: "Target Page" }).waitFor();
  await page.waitForTimeout(2800); // persist the link into content_md for backlinks

  // The target shows the source under "Linked from".
  await page.goto(targetUrl);
  await page.waitForSelector(".ProseMirror");
  await page.locator(".backlinks .backlink", { hasText: "Source Page" }).waitFor();

  // Rename the target; the chip in the source reflects the new title on reload.
  await page.fill(".title-input", "Renamed Target");
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForSelector(".backlinks .backlink");
  await page.locator(".backlink", { hasText: "Source Page" }).click();
  await page.waitForSelector(".ProseMirror .page-ref");
  await page.locator(".page-ref", { hasText: "Renamed Target" }).waitFor();

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("CROSSREF PASS — @-link, backlink, and live rename all work");
} finally {
  await browser.close();
}
