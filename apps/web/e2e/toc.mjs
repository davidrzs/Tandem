// The contents rail: it lists the document's headings, scrolls to
// one on click, hides (instead of displacing the column) when the viewport
// can't fit it beside the centered document, and yields to a right rail when
// History/Comments opens. Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
// Wide enough for the rail to fit in the gutter (it hides below 1450px).
const page = await browser.newPage({ viewport: { width: 1600, height: 640 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Toc User");
  const c = `Toc ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  await page.fill(".title-input", "Protocol");
  const pm = ".ProseMirror";
  await page.click(pm);

  // Several sections with filler so the document actually scrolls.
  for (const h of ["Background", "Method", "Results"]) {
    await page.type(pm, "# " + h);
    await page.keyboard.press("Enter");
    for (let i = 0; i < 6; i++) {
      await page.type(pm, `${h} paragraph ${i} with enough text to take a line.`);
      await page.keyboard.press("Enter");
    }
  }

  await page.waitForSelector(".toc-rail");
  const entries = await page.$$eval(".toc-entry", (els) => els.map((e) => e.textContent));
  const expected = ["Background", "Method", "Results"];
  if (JSON.stringify(entries) !== JSON.stringify(expected))
    throw new Error(`toc entries: ${JSON.stringify(entries)}`);

  // Click "Method" (a middle section, so it can reach the top) — it scrolls up
  // to just below the sticky toolbar (scroll-margin-top).
  await page.click(".toc-entry:has-text('Method')");
  await page.waitForTimeout(900); // smooth scroll
  const top = await page.evaluate(() => {
    const h = [...document.querySelectorAll(".ProseMirror h1")].find((e) => e.textContent === "Method");
    return h ? h.getBoundingClientRect().top : 9999;
  });
  if (top > 140) throw new Error(`clicking a TOC entry did not scroll to it (top=${top})`);

  // Mid widths: the rail hides rather than displacing the centered column.
  await page.setViewportSize({ width: 1360, height: 640 });
  await page.waitForSelector(".toc-rail", { state: "hidden" });
  await page.setViewportSize({ width: 1600, height: 640 });
  await page.waitForSelector(".toc-rail", { state: "visible" });

  // Opening a right rail hides the TOC (avoids cramming four columns).
  await page.getByRole("button", { name: "History" }).click();
  await page.waitForSelector(".toc-rail", { state: "detached" });

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TOC PASS — lists headings, scrolls on click, hides for a right rail");
} finally {
  await browser.close();
}
