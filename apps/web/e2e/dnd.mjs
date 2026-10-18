// Drag-to-reparent: dragging one document row into another nests it. HTML5 DnD
// carries a payload, so we share one DataTransfer across a synthetic
// dragstart → dragover → drop (Playwright's dragTo can't populate it). Needs
// web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "DnD User");
  const c = `DnD ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  await page.fill(".title-input", "Parent Doc");
  await page.waitForTimeout(700);
  await newDocument(page, c);
  await page.fill(".title-input", "Child Doc");
  await page.waitForTimeout(700);

  const child = page.locator(".doc-row", { hasText: "Child Doc" });
  const parent = page.locator(".doc-row", { hasText: "Parent Doc" });
  await child.waitFor();
  await parent.waitFor();
  const childLevelBefore = await child.getAttribute("aria-level");

  // The row's dragstart populates this DataTransfer; reuse it for the dragover
  // (mid-height row = "into"/reparent) and the drop. clientX sits mid-row: at
  // the far left of a last-in-group row the tree reads an outdent instead.
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await child.dispatchEvent("dragstart", { dataTransfer: dt });
  const box = await parent.boundingBox();
  const at = { dataTransfer: dt, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await parent.dispatchEvent("dragover", at);
  await page.waitForTimeout(60); // React needs a frame between dragover and drop
  await parent.dispatchEvent("drop", at);

  // Child is now nested under Parent: its treeitem aria-level is one deeper
  // than the top-level level it started at.
  await page.waitForFunction(
    (before) => {
      const row = [...document.querySelectorAll(".doc-row")].find((r) =>
        r.textContent?.includes("Child Doc"),
      );
      return !!row && Number(row.getAttribute("aria-level")) > Number(before);
    },
    childLevelBefore,
    { timeout: 8000 },
  );

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("DND PASS — dragging a document into another nests it");
} finally {
  await browser.close();
}
