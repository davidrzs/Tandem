// Verifies the slash (/) command menu: typing "/" opens it, filtering +
// Enter applies the block. Assumes web (5173) + api (3001) running (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Slash User");
  const collectionName = `Slash ${Date.now()}`;
  await createCollection(page, collectionName);
  await newDocument(page, collectionName);

  // Open the slash menu and filter to a heading.
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "/head");
  await page.waitForSelector(".slash-menu");
  const firstItem = await page.textContent(".slash-item");
  if (!firstItem || !firstItem.includes("Heading 1"))
    throw new Error(`expected Heading 1 first, got: ${firstItem}`);

  // Apply it and type into the heading.
  await page.keyboard.press("Enter");
  await page.type(".ProseMirror", "Slash Heading");

  await page.waitForSelector(".ProseMirror h1");
  const h1 = await page.textContent(".ProseMirror h1");
  if (!h1 || !h1.includes("Slash Heading"))
    throw new Error(`heading not applied via slash menu: "${h1}"`);

  // The "/head" trigger text must be gone (deleteRange ran).
  const body = (await page.textContent(".ProseMirror")) ?? "";
  if (body.includes("/head")) throw new Error(`slash trigger text leaked: "${body}"`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("SLASH PASS — '/' menu filters and applies Heading 1, trigger text removed");
} finally {
  await browser.close();
}
