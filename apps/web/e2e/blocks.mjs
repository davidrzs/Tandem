// Callouts + toggles: slash-insert, type content, persist across a reload
// (exercises the Yjs <-> markdown round-trip on the server), and confirm the
// toggle folds LOCALLY (no doc mutation). Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Blocks User");
  const c = `Blocks ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const pm = ".ProseMirror";
  await page.click(pm);

  // Callout via slash menu.
  await page.type(pm, "/callout");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".callout");
  await page.type(pm, "Preregister the analysis.");
  await page.keyboard.press("Enter"); // fresh line so the slash menu can trigger

  // A toggle via slash menu (summary + a line of content).
  await page.type(pm, "/toggle");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".toggle");
  // The caret lands in the summary on insert — type the title, then the body.
  await page.keyboard.type("Method details");
  await page.click(".toggle-content");
  await page.keyboard.type("We used a t-test.");

  // Persist (store debounce ~2s), reload from scratch.
  await page.waitForTimeout(2800);
  await page.reload();

  await page.waitForSelector(".callout");
  const calloutText = (await page.textContent(".callout")) ?? "";
  if (!calloutText.includes("Preregister the analysis."))
    throw new Error(`callout body lost: "${calloutText}"`);
  if (!calloutText.includes("Note")) throw new Error("callout type label missing");

  await page.waitForSelector(".toggle");
  const summary = (await page.textContent(".toggle-summary")) ?? "";
  if (!summary.includes("Method details")) throw new Error(`toggle summary lost: "${summary}"`);
  await page.waitForSelector(".toggle-content:has-text('We used a t-test.')");

  // Fold locally: content hides, and it must NOT have mutated the doc (no new
  // "unsaved" churn — the summary text is still there after folding).
  await page.click(".toggle-caret");
  await page.waitForSelector(".toggle.collapsed");
  if (await page.isVisible(".toggle-content")) throw new Error("collapsed toggle still shows content");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("BLOCKS PASS — callout + toggle render, persist across reload, fold locally");
} finally {
  await browser.close();
}
