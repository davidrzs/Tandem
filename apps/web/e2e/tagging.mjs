// Verifies tags: add a tag under the title, then find the document by clicking
// the chip (opens search prefilled with #tag). Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Tag User");
  const collectionName = `Tagged ${Date.now()}`;
  await createCollection(page, collectionName);
  await newDocument(page, collectionName);

  await page.fill(".title-input", "Quantum notes");
  await page.waitForTimeout(800); // let the title-save debounce (500ms) flush

  // Add a tag via the inline "+ tag" affordance.
  await page.getByRole("button", { name: "+ tag" }).click();
  await page.locator(".tag-input").fill("physics");
  await page.keyboard.press("Enter");

  // The chip renders once the update round-trips.
  await page.getByRole("button", { name: "physics", exact: true }).waitFor();

  // Clicking the chip opens search prefilled with "#physics" and finds the doc
  // (matched by its tag chip so the assertion doesn't race title persistence).
  await page.getByRole("button", { name: "physics", exact: true }).click();
  await page.waitForSelector(".search-box");
  const hit = page.locator(".search-hit", { has: page.locator(".tag-chip", { hasText: "physics" }) });
  await hit.waitFor();
  const hitText = (await hit.textContent()) ?? "";
  if (!hitText.includes("Quantum notes")) throw new Error(`hit title wrong: "${hitText}"`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TAGGING PASS — tag added and the document is found via #tag search");
} finally {
  await browser.close();
}
