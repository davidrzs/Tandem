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

  await page.keyboard.press("Control+k");
  await page.waitForSelector(".search-box");

  // The body reaches the search vector only after the debounced (2s) collab
  // store persists it, and the modal doesn't re-query on its own — so poll by
  // re-issuing the search instead of gambling on one fixed sleep (the old
  // 2.8s wait flaked whenever a loaded machine stretched the persist).
  const hit = page.locator(".search-hit", { hasText: "Findable Document" });
  let found = false;
  for (let attempt = 0; attempt < 12 && !found; attempt++) {
    // Re-typing the same string hits react-query's cache and never refetches;
    // remounting the modal (Escape + Ctrl+K) issues a fresh query.
    if (attempt > 0) {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      await page.waitForSelector(".search-box");
    }
    await page.locator(".search-input").fill("zonkelberry");
    found = await hit.waitFor({ timeout: 2500 }).then(
      () => true,
      () => false,
    );
  }
  if (!found) throw new Error("search never surfaced the persisted document");
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
