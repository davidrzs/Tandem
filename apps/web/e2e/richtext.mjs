// Verifies tables, code-block syntax highlighting, and inline math render and
// persist across a reload. Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Exactly the two real formulas render; code and prose dollars stay text.
async function onlyRealMath(page) {
  const mathCount = await page.locator(".doc-body .math-render").count();
  if (mathCount !== 2) throw new Error(`expected 2 rendered formulas, got ${mathCount}`);
  const prose = (await page.textContent(".doc-body")) ?? "";
  for (const s of ["Budget $5 and $10", "a$b$", "// $x$"]) {
    if (!prose.includes(s)) throw new Error(`"${s}" not shown as text: "${prose}"`);
  }
}

try {
  await signUp(page, "Rich User");
  const c = `Rich ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);

  await page.click(".doc-body");
  await page.type(".doc-body", "Einstein: $E = mc^2$ done.");
  await page.keyboard.press("Enter");
  // Block/display math on its own line.
  await page.type(".doc-body", "$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$");
  await page.keyboard.press("Enter");
  // Not math: prose money, and dollars inside inline code.
  await page.type(".doc-body", "Budget $5 and $10, `a$b$` here.");
  await page.keyboard.press("Enter");

  // Code block via the ``` input rule → highlight spans appear.
  await page.type(".doc-body", "```js ");
  await page.type(".doc-body", "const answer = 42; // $x$");
  await page.waitForSelector(".doc-body pre .hljs-keyword");
  await page.keyboard.press("ArrowDown"); // exit code block

  // Table via slash menu.
  await page.type(".doc-body", "/table");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".doc-body table");
  await page.type(".doc-body", "Symbol");

  // Math renders once the cursor leaves the paragraph (now in the table):
  // inline ($…$) and block ($$…$$, in display mode).
  await page.waitForSelector(".doc-body .katex");
  await page.waitForSelector(".doc-body .math-render.math-block .katex");

  await onlyRealMath(page);

  // Persist (store debounce ~2s server-side), then reload from scratch.
  await page.waitForTimeout(2800);
  await page.reload();
  await page.waitForSelector(".doc-body table");

  const tableText = (await page.textContent(".doc-body table")) ?? "";
  if (!tableText.includes("Symbol")) throw new Error(`table cell lost: "${tableText}"`);
  await page.waitForSelector(".doc-body pre .hljs-keyword"); // highlight survived
  await page.waitForSelector(".doc-body .katex"); // inline math survived
  await page.waitForSelector(".doc-body .math-render.math-block .katex"); // block math survived

  await onlyRealMath(page);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("RICHTEXT PASS — table, code, inline + block math render and persist");
} finally {
  await browser.close();
}
