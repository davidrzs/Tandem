// The Obsidian-style explorer: a resizable, persisted sidebar pane that turns
// back into a drawer on narrow screens, and a compact tree whose row actions
// overlay the title instead of reserving width. Needs web+api (run.sh).
import { chromium } from "playwright";
import { createCollection, newDocument, signUp } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const sidebarWidth = () => page.locator(".sidebar").evaluate((el) => el.getBoundingClientRect().width);
const assert = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
/** Panel layout follows a ResizeObserver, so widths settle a frame or two late. */
async function expectWidth(lo, hi, msg) {
  try {
    await page.waitForFunction(
      ([lo, hi]) => {
        const w = document.querySelector(".sidebar").getBoundingClientRect().width;
        return w >= lo && w <= hi;
      },
      [lo, hi],
      { timeout: 3000 },
    );
  } catch {
    throw new Error(`${msg} (width ${await sidebarWidth()})`);
  }
  return sidebarWidth();
}

try {
  await signUp(page, "Explorer User");
  const resizer = page.locator(".sidebar-resizer");
  await expectWidth(247, 249, "the sidebar starts at 248px");

  const box = await resizer.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 5 });
  await page.mouse.move(x + 120, y, { steps: 5 });
  await page.mouse.up();
  const dragged = await expectWidth(366, 370, "dragging the separator 120px right widens the sidebar");

  await page.reload();
  await page.waitForSelector(".sidebar");
  await expectWidth(dragged - 1, dragged + 1, "the dragged width survives a reload");

  await resizer.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  await expectWidth(0, dragged - 2, "ArrowLeft on the focused separator narrows the sidebar");

  const kbox = await resizer.boundingBox();
  await page.mouse.move(kbox.x + kbox.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(20, y, { steps: 8 });
  await page.mouse.up();
  const floor = await expectWidth(199.5, 201, "the sidebar stops at its 200px minimum");

  await page.setViewportSize({ width: 800, height: 700 });
  await resizer.waitFor({ state: "hidden" });
  const mainWidth = await page.locator(".main").evaluate((el) => el.getBoundingClientRect().width);
  assert(Math.abs(mainWidth - 800) <= 1, `under 900px the document takes the full width (got ${mainWidth})`);
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.locator(".sidebar[data-open]").waitFor({ state: "visible" });
  await page.locator(".sidebar-scrim").click({ position: { x: 780, y: 300 } });
  await page.locator(".sidebar").waitFor({ state: "hidden" });

  await page.setViewportSize({ width: 1280, height: 800 });
  await resizer.waitFor({ state: "visible" });
  await expectWidth(floor - 1, floor + 1, "back on a wide screen the sidebar keeps its width");

  const rbox = await resizer.boundingBox();
  await page.mouse.dblclick(rbox.x + rbox.width / 2, y);
  await expectWidth(247, 249, "double-clicking the separator resets the sidebar to 248px");
  await page.reload();
  await page.waitForSelector(".sidebar");
  await expectWidth(247, 249, "the reset width is persisted");

  const c = `Explorer ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  await page.fill(".title-input", "Short");
  const short = page.locator(".doc-row", { hasText: "Short" });
  await short.waitFor();
  const titleGap = () =>
    short.evaluate((row) => {
      const r = row.getBoundingClientRect();
      const padRight = Number.parseFloat(getComputedStyle(row).paddingRight);
      const borderRight = Number.parseFloat(getComputedStyle(row).borderRightWidth);
      return r.right - borderRight - padRight - row.querySelector(".doc-title").getBoundingClientRect().right;
    });
  await page.mouse.move(900, 400);
  const idleGap = await titleGap();
  assert(Math.abs(idleGap) <= 12, `an idle row reserves no width for its actions (gap ${idleGap})`);
  await short.hover();
  await short.locator('.row-action[title="New sub-document"]').waitFor({ state: "visible" });
  const hoverGap = await titleGap();
  assert(Math.abs(hoverGap) <= 12, `hovered actions overlay the title instead of shrinking it (gap ${hoverGap})`);

  await short.locator(".doc-title").hover();
  await page.waitForTimeout(800);
  assert((await page.getByRole("tooltip").count()) === 0, "a short title gets no tooltip");

  const long = `A deliberately long document title that cannot fit ${"in a sidebar row ".repeat(4)}`.trim();
  await newDocument(page, c);
  await page.fill(".title-input", long);
  const longRow = page.locator(".doc-row", { hasText: long.slice(0, 30) });
  await longRow.waitFor();
  await page.mouse.move(900, 400);
  await longRow.locator(".doc-title").hover();
  await page.getByRole("tooltip").waitFor();
  const tip = await page.getByRole("tooltip").textContent();
  assert(tip === long, `hovering a truncated title shows it in full (got ${JSON.stringify(tip)})`);

  const before = new URL(page.url()).pathname;
  await short.hover();
  await short.locator('.row-action[title="New sub-document"]').click();
  await page.waitForURL((url) => url.pathname !== before && url.pathname.startsWith("/d/"));
  await page.waitForSelector(".ProseMirror");
  await page.fill(".title-input", "Nested");
  const nested = page.locator(".doc-row", { hasText: "Nested" });
  await nested.waitFor();
  const level = await nested.getAttribute("aria-level");
  assert(level === "3", `a sub-document sits at aria-level 3 (got ${level})`);
  const guides = await nested.evaluate((row) => getComputedStyle(row, "::before").width);
  assert(guides === "16px", `two ancestor guides at 8px per level (got ${guides})`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("EXPLORER PASS — resizable, persisted pane; drawer under 900px; overlay actions, tooltips, guides");
} finally {
  await browser.close();
}
