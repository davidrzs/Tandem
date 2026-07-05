// Verifies markdown-zip import (Outline-shaped fixture) and workspace export.
// Needs web+api (run.sh).
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { signUp } from "./_helpers.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/sample.zip", import.meta.url));
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

  // Export the workspace: the link triggers a file download.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".data-actions");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Export workspace" }).click(),
  ]);
  const fname = download.suggestedFilename();
  if (!fname.endsWith("-export.zip")) throw new Error(`unexpected download: "${fname}"`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TRANSFER PASS — imported an Outline zip and exported the workspace");
} finally {
  await browser.close();
}
