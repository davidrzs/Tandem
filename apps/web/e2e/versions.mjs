// Verifies snapshots & restore: edits captured across reloads appear as
// versions; previewing shows the old content; restoring reverts the live doc.
// Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const waitForBody = (text) =>
  page.waitForFunction(
    (t) => document.querySelector(".ProseMirror")?.textContent?.includes(t),
    text,
  );

try {
  await signUp(page, "Version User");
  const c = `Versions ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);

  // Version 1, persist, reload (onLoadDocument captures a boundary snapshot).
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "Version one.");
  await page.waitForTimeout(2800);
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await waitForBody("Version one.");

  // Version 2, persist, reload (second boundary snapshot).
  await page.click(".ProseMirror");
  await page.keyboard.press("Control+End");
  await page.type(".ProseMirror", " Version two.");
  await page.waitForTimeout(2800);
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await waitForBody("Version two.");

  // Open History → the Versions section lists the captured versions.
  await page.getByRole("button", { name: "History" }).click();
  await page.waitForSelector(".history-item.version");
  const count = await page.locator(".history-item.version").count();
  if (count < 2) throw new Error(`expected >=2 versions, got ${count}`);

  // Preview the oldest version (last in the newest-first list).
  await page.locator(".history-item.version").last().click();
  await page.waitForSelector(".preview-banner");
  const previewText = await page.locator(".prose:visible").innerText();
  if (!previewText.includes("Version one.")) throw new Error(`preview missing v1: "${previewText}"`);
  if (previewText.includes("Version two.")) throw new Error(`preview should predate v2: "${previewText}"`);

  // Restore it → the live document reverts and the banner closes.
  await page.getByRole("button", { name: "Restore this version" }).click();
  await page.waitForSelector(".preview-banner", { state: "detached" });
  await page.waitForFunction(() => {
    const t = document.querySelector(".ProseMirror")?.textContent ?? "";
    return t.includes("Version one.") && !t.includes("Version two.");
  });

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("VERSIONS PASS — versions captured, previewed, and restored");
} finally {
  await browser.close();
}
