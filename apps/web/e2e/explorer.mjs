// The Obsidian-style explorer: a resizable, persisted sidebar pane that turns
// back into a drawer on narrow screens, and a compact, keyboard-driven tree
// whose row actions overlay the title instead of reserving width. Needs
// web+api (run.sh).
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
  const longUrl = page.url();
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

  const nestedUrl = page.url();
  const collectionRow = page.locator(".collection-row", { hasText: c });
  const treeDocs = page.locator(".tree .doc-row");
  await page.locator(".nav-row", { hasText: "Home" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  const persisted = page.waitForResponse((r) => r.url().includes("settings.setSidebarNode"));
  await page.getByTitle("Collapse all").click();
  await persisted;
  await treeDocs.first().waitFor({ state: "detached" });
  assert((await collectionRow.getAttribute("aria-expanded")) === "false", "Collapse all folds the collection");
  await page.reload();
  await collectionRow.waitFor();
  await page.waitForTimeout(500);
  assert((await collectionRow.getAttribute("aria-expanded")) === "false", "the collapsed collection stays folded after a reload");
  assert((await treeDocs.count()) === 0, "no document rows after a reload of a collapsed tree");

  await page.goto(nestedUrl);
  await page.waitForSelector(".ProseMirror");
  await nested.waitFor();
  await page.getByTitle("Collapse all").click();
  await nested.waitFor({ state: "detached" });
  await page.getByTitle("Reveal active document").click();
  await nested.waitFor();
  const inView = await nested.evaluate((row) => {
    const pane = document.querySelector(".sidebar-scroll").getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return r.top >= pane.top && r.bottom <= pane.bottom;
  });
  assert(inView, "Reveal unfolds the path to the open document and scrolls its row into view");
  assert((await nested.getAttribute("tabindex")) === "0", "the revealed row is the tree's tab stop");

  await page.goto(longUrl);
  await page.waitForSelector(".ProseMirror");
  await longRow.hover();
  await longRow.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await page.goto(longUrl);
  await page.waitForSelector(".ProseMirror");
  const archivedRow = page.locator(".archived-row", { hasText: long.slice(0, 30) });
  await page.getByTitle("Collapse all").click();
  await archivedRow.waitFor({ state: "detached" });
  await page.getByTitle("Reveal active document").click();
  await archivedRow.waitFor();

  const isActive = async (locator, msg) => {
    const el = await locator.elementHandle();
    await page.waitForFunction((el) => document.activeElement === el, el, { timeout: 3000 }).catch(() => {
      throw new Error(msg);
    });
  };
  const treeItems = page.locator('.tree [role="treeitem"]');
  await page.locator(".tree .collection-row").first().focus();
  await page.keyboard.press("ArrowDown");
  await isActive(treeItems.nth(1), "ArrowDown on the first collection focuses the next tree row");

  await collectionRow.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((el) => el.getAttribute("aria-expanded") === "false", await collectionRow.elementHandle());
  await page.keyboard.press("Enter");
  await page.waitForFunction((el) => el.getAttribute("aria-expanded") === "true", await collectionRow.elementHandle());

  await short.focus();
  await page.keyboard.press("ArrowRight");
  await nested.waitFor();
  await page.keyboard.press("ArrowDown");
  await isActive(nested, "ArrowRight unfolds a document and ArrowDown reaches its child");
  assert((await nested.getAttribute("aria-level")) === "3", "the child starts nested under its parent");
  await page.keyboard.press("Control+Shift+KeyD");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByText('Moved "Nested"').waitFor();
  await page.waitForFunction((el) => el.getAttribute("aria-level") === "2", await nested.elementHandle());

  await isActive(nested, "the moved row keeps focus");
  await page.keyboard.press("Enter");
  await page.waitForURL(nestedUrl);

  await nested.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "New sub-document" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached" });

  await newDocument(page, c);
  const parentUrl = page.url();
  await page.fill(".title-input", "Research");
  const research = page.locator(".doc-row", { hasText: "Research" });
  await research.waitFor();
  assert((await page.locator(".sub-pages").count()) === 0, "a document without children shows no Pages section");
  await research.hover();
  await research.locator('.row-action[title="New sub-document"]').click();
  await page.waitForURL((url) => url.href !== parentUrl && url.pathname.startsWith("/d/"));
  const findingsUrl = page.url();
  await page.waitForSelector(".ProseMirror");
  await page.fill(".title-input", "Findings");
  await page.locator(".doc-row", { hasText: "Findings" }).waitFor();

  await page.goto(parentUrl);
  const pages = page.locator(".sub-pages");
  await pages.getByRole("link", { name: /Findings/ }).waitFor();
  const head = await pages.locator(".sub-pages-toggle").textContent();
  assert(head.trim() === "1 page", `the Pages section counts the sub-pages (got ${JSON.stringify(head)})`);
  await pages.locator(".sub-pages-toggle").click();
  await pages.getByRole("link", { name: /Findings/ }).waitFor({ state: "detached" });
  await pages.locator(".sub-pages-toggle").click();
  await pages.getByRole("link", { name: /Findings/ }).click();
  await page.waitForURL(findingsUrl);

  await page.goto(parentUrl);
  await pages.getByRole("button", { name: "New page" }).click();
  await page.waitForURL((url) => url.href !== parentUrl && url.href !== findingsUrl && url.pathname.startsWith("/d/"));
  await page.waitForSelector(".ProseMirror");
  await page.fill(".title-input", "Fresh page");
  const fresh = page.locator(".doc-row", { hasText: "Fresh page" });
  await fresh.waitFor();
  const freshLevel = await fresh.getAttribute("aria-level");
  const researchLevel = Number(await research.getAttribute("aria-level"));
  assert(Number(freshLevel) === researchLevel + 1, `"New page" files the page under its parent in the sidebar (level ${freshLevel})`);
  await page.goto(parentUrl);
  await pages.getByRole("link", { name: /Fresh page/ }).waitFor();
  assert((await pages.locator(".sub-pages-toggle").textContent()).trim() === "2 pages", "the new page joins the Pages section");

  const onCollectionPage = async (msg) => {
    await page.waitForURL((url) => url.pathname.startsWith("/c/"));
    const heading = await page.locator(".collection-page h1").textContent();
    assert(heading === c, `${msg} (heading ${JSON.stringify(heading)})`);
    await page.locator(".collection-page .doc-outline").getByRole("link", { name: /Research/ }).waitFor();
  };
  await page.locator(".breadcrumbs .crumb-collection").click();
  await onCollectionPage("the collection crumb opens the collection page");

  await page.goto(parentUrl);
  await page.waitForSelector(".ProseMirror");
  await collectionRow.hover();
  await collectionRow.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Open collection page" }).click();
  await onCollectionPage("the collection menu opens the collection page");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "EXPLORER PASS — resizable, persisted pane; drawer under 900px; overlay actions, tooltips, guides; collapse all, reveal active; keyboard navigation, move and row menu; sub-page outline; collection page links",
  );
} finally {
  await browser.close();
}
