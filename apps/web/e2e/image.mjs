// Drop an image into the editor -> uploads to the private store -> renders an
// <img src="/api/images/..."> with a resize handle that changes the width.
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const stamp = Date.now();
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Img");
  const collectionName = `Imgs ${stamp}`;
  await createCollection(page, collectionName);
  await newDocument(page, collectionName);
  await page.click(".ProseMirror");

  // Simulate dropping an image file onto the editor (canonical Playwright
  // recipe: build the DataTransfer in-page, pass the handle to dispatchEvent).
  const dataTransfer = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "pic.png", { type: "image/png" }));
    return dt;
  }, PNG_1x1);
  // ProseMirror bails unless the drop coords map to a position in the editor.
  const pm = await page.locator(".ProseMirror").boundingBox();
  await page.dispatchEvent(".ProseMirror", "drop", {
    dataTransfer,
    clientX: Math.round(pm.x + 20),
    clientY: Math.round(pm.y + 10),
  });

  // The uploaded image renders from the private endpoint.
  await page.waitForSelector(".ProseMirror .img-node img", { timeout: 10000 });
  const src = await page.getAttribute(".ProseMirror .img-node img", "src");
  if (!src || !src.includes("/api/images/")) throw new Error(`bad image src: ${src}`);
  // The served bytes actually load (private endpoint, same session).
  const status = await page.evaluate(async (u) => (await fetch(u)).status, src);
  if (status !== 200) throw new Error(`image did not serve: ${status}`);

  // Resize via the drag handle and confirm the width changes.
  const before = await page.evaluate(
    () => document.querySelector(".ProseMirror .img-node img").getBoundingClientRect().width,
  );
  const handle = page.locator(".img-resize-handle");
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 6, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    (w) => document.querySelector(".ProseMirror .img-node img")?.getBoundingClientRect().width > w + 20,
    before,
    { timeout: 5000 },
  );

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("IMAGE PASS — drop uploads + renders from the private store, and resize changes the width");
} finally {
  await browser.close();
}
