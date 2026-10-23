// Verifies markdown-zip import (nested-wiki fixture) and workspace export.
// Needs web+api (run.sh).
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { signUp } from "./_helpers.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/sample.zip", import.meta.url));
const MISSING_IMAGE = fileURLToPath(new URL("./fixtures/missing-image.zip", import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Transfer User");

  // Import the fixture through Settings → Data.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".data-actions");
  await page.setInputFiles(".data-actions input[type=file]", FIXTURE);
  await page.waitForSelector(".import-summary");
  const summary = (await page.textContent(".import-summary")) ?? "";
  if (!/2 documents/.test(summary)) throw new Error(`unexpected summary: "${summary}"`);
  await page.keyboard.press("Escape");

  // The imported collection + doc appear in the sidebar.
  await page.getByText("Research", { exact: true }).click();
  await page.getByText("Overview", { exact: true }).waitFor();

  // Export the workspace: the button downloads the zip and says it did.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".data-actions");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export workspace" }).click(),
  ]);
  const fname = download.suggestedFilename();
  if (!fname.endsWith("-export.zip")) throw new Error(`unexpected download: "${fname}"`);
  const clean = (await page.locator(".export-summary").textContent()) ?? "";
  if (clean !== `Downloaded ${fname}.`) throw new Error(`unexpected export summary: "${clean}"`);

  // A page whose image is gone: the export says it left the link as it was.
  await page.setInputFiles(".data-actions input[type=file]", MISSING_IMAGE);
  await page.locator(".import-summary", { hasText: "1 document" }).waitFor();
  await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export workspace" }).click(),
  ]);
  const summary2 = page.locator(".export-summary");
  await summary2.getByText("1 thing to review").click();
  const warning = (await summary2.locator("li").textContent()) ?? "";
  const expected = 'image 00000000-0000-4000-8000-000000000000 in "Lost image" is unavailable — link left as-is';
  if (warning !== expected) throw new Error(`unexpected export warning: "${warning}"`);
  await page.keyboard.press("Escape");

  // The same notice when one collection is exported from the sidebar.
  const row = page.locator(".collection-row", { hasText: "Gaps" });
  await row.hover();
  await row.locator('.row-action[title="More actions"]').click();
  const [colDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Export" }).click(),
  ]);
  if (colDownload.suggestedFilename() !== "Gaps-export.zip") {
    throw new Error(`unexpected collection download: "${colDownload.suggestedFilename()}"`);
  }
  const dialog = page.locator(".modal .export-summary");
  await dialog.getByText("1 thing to review").click();
  const colWarning = (await dialog.locator("li").textContent()) ?? "";
  if (colWarning !== expected) throw new Error(`unexpected collection export warning: "${colWarning}"`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TRANSFER PASS — imported a wiki zip, exported the workspace and showed what it left out");
} finally {
  await browser.close();
}
