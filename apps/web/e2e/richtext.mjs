// Verifies tables, code-block syntax highlighting, and inline math render and
// persist across a reload. Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Rich User");
  const c = `Rich ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);

  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "Einstein: $E = mc^2$ done.");
  await page.keyboard.press("Enter");
  // Block/display math on its own line.
  await page.type(".ProseMirror", "$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$");
  await page.keyboard.press("Enter");

  // Code block via the ``` input rule → highlight spans appear.
  await page.type(".ProseMirror", "```js ");
  await page.type(".ProseMirror", "const answer = 42;");
  await page.waitForSelector(".ProseMirror pre .hljs-keyword");
  await page.keyboard.press("ArrowDown"); // exit code block

  // Table via slash menu.
  await page.type(".ProseMirror", "/table");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".ProseMirror table");
  await page.type(".ProseMirror", "Symbol");

  // Math renders once the cursor leaves the paragraph (now in the table):
  // inline ($…$) and block ($$…$$, in display mode).
  await page.waitForSelector(".ProseMirror .katex");
  await page.waitForSelector(".ProseMirror .math-render.math-block .katex");

  // Persist (store debounce ~2s server-side), then reload from scratch.
  await page.waitForTimeout(2800);
  await page.reload();
  await page.waitForSelector(".ProseMirror table");

  const tableText = (await page.textContent(".ProseMirror table")) ?? "";
  if (!tableText.includes("Symbol")) throw new Error(`table cell lost: "${tableText}"`);
  await page.waitForSelector(".ProseMirror pre .hljs-keyword"); // highlight survived
  await page.waitForSelector(".ProseMirror .katex"); // inline math survived
  await page.waitForSelector(".ProseMirror .math-render.math-block .katex"); // block math survived

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("RICHTEXT PASS — table, code, inline + block math render and persist");
} finally {
  await browser.close();
}
