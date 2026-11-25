// The title is the page's first line: it wraps, Enter and the arrow keys move
// between it and the body, a second session sees it change live, and it
// persists to the sidebar and across reloads.
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const TITLE = ".title-input[contenteditable=true]";

try {
  await signUp(page, "Title User");
  const c = `Titles ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);

  // A long title wraps onto more lines instead of scrolling sideways.
  const long = "Weekly sync with the advisor about the second reviewer's comments on the ablation study";
  await page.fill(TITLE, long);
  const box = await page.locator(".title-input").evaluate((el) => ({
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    overflow: el.scrollWidth - el.clientWidth,
  }));
  if (box.lines < 2) throw new Error(`long title did not wrap: ${JSON.stringify(box)}`);
  if (box.overflow > 0) throw new Error(`long title overflows sideways: ${JSON.stringify(box)}`);

  // Enter leaves the title for the start of the body; the title keeps its text.
  await page.fill(TITLE, "Advisor 1:1");
  // The sidebar shows the title as it is typed, before the doc is stored.
  await page.locator(".doc-row", { hasText: "Advisor 1:1" }).waitFor({ timeout: 1000 });
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("First line of the body");
  await page.locator(".doc-body", { hasText: "First line of the body" }).waitFor();
  if ((await page.textContent(".title-input")) !== "Advisor 1:1") {
    throw new Error(`Enter changed the title: "${await page.textContent(".title-input")}"`);
  }

  // ArrowUp on the body's first line goes back into the title.
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.type(" notes");
  await page.locator(".title-input", { hasText: "Advisor 1:1 notes" }).waitFor();

  // A second session on the same page sees the title change as it is typed.
  const other = await context.newPage();
  await other.goto(page.url());
  await other.locator(".title-input", { hasText: "Advisor 1:1 notes" }).waitFor();
  await page.click(".title-input");
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await other.locator(".title-input", { hasText: "Advisor 1:1 notes!" }).waitFor({ timeout: 3000 });
  await other.close();

  // The stored title reaches the sidebar and survives a reload.
  await page.locator(".doc-row", { hasText: "Advisor 1:1 notes!" }).waitFor();
  await page.reload();
  await page.locator(TITLE, { hasText: "Advisor 1:1 notes!" }).waitFor();

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TITLE PASS — wraps, Enter/ArrowUp move to and from the body, live in a second session, persists");
} finally {
  await browser.close();
}
