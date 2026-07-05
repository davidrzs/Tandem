// Cmd+K search finds a document by body text and navigates to it. Needs web+api.
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Search User");
  const c = `Search ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  await page.fill(".title-input", "Findable Document");
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "Contains a rare token: zonkelberry.");
  await page.waitForTimeout(2800); // persist so the search vector includes it

  await page.keyboard.press("Control+k");
  await page.waitForSelector(".search-box");
  await page.locator(".search-input").fill("zonkelberry");

  const hit = page.locator(".search-hit", { hasText: "Findable Document" });
  await hit.waitFor();
  await hit.click();
  await page.waitForURL(/\/d\//);
  await page.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("zonkelberry"),
  );

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("SEARCH PASS — Cmd+K finds a document by body text and opens it");
} finally {
  await browser.close();
}
