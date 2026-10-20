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
  const localFolds = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("tandem.sidebar.expanded:"));
    return [key, localStorage.getItem(key)];
  });
  assert(localFolds[1]?.includes('"'), `the open collection is cached locally (got ${JSON.stringify(localFolds)})`);
  const persisted = page.waitForResponse((r) => r.url().includes("settings.setSidebarNode"));
  await page.getByTitle("Collapse all").click();
  await persisted;
  await treeDocs.first().waitFor({ state: "detached" });
  assert((await collectionRow.getAttribute("aria-expanded")) === "false", "Collapse all folds the collection");
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), localFolds);
  const serverFolds = page.waitForResponse((r) => r.url().includes("settings.sidebar"));
  await page.reload();
  await serverFolds;
  await page
    .waitForFunction(
      (name) =>
        [...document.querySelectorAll(".collection-row")]
          .find((row) => row.textContent.includes(name))
          ?.getAttribute("aria-expanded") === "false",
      c,
      { timeout: 3000 },
    )
    .catch(() => {
      throw new Error("the server's collapse wins over a stale local cache after a reload");
    });
  await treeDocs.first().waitFor({ state: "detached" });

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
  // Collapse all folds only the documents the sidebar has loaded.
  await short.waitFor();
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

  assert((await short.getAttribute("aria-expanded")) === "false", "Collapse all folded the document");
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
  await isActive(nested, "Escape from the row menu returns focus to its row");
  await page.keyboard.press("ArrowUp");
  await isActive(short, "arrow keys keep working after the row menu closes");

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
  const findings = page.locator(".doc-row", { hasText: "Findings" });
  await findings.waitFor();
  await findings.hover();
  await findings.locator('.row-action[title="New sub-document"]').click();
  await page.waitForURL((url) => url.href !== findingsUrl && url.pathname.startsWith("/d/"));
  await page.waitForSelector(".ProseMirror");
  await page.fill(".title-input", "Evidence");
  await page.locator(".doc-row", { hasText: "Evidence" }).waitFor();

  await page.goto(parentUrl);
  const pages = page.locator(".sub-pages");
  const table = pages.locator(".outline-table");
  const count = () => pages.locator(".outline-count").textContent();
  const rowNames = () => table.locator("tbody .outline-link").allTextContents();
  await table.getByRole("link", { name: "Findings" }).waitFor();
  assert((await count()) === "2 pages", `the Contents bar counts every sub-page (got ${JSON.stringify(await count())})`);
  assert(
    JSON.stringify(await rowNames()) === '["Findings"]',
    `nested rows start folded (got ${JSON.stringify(await rowNames())})`,
  );
  const findingsRow = table.locator("tr", { has: page.getByRole("link", { name: "Findings" }) });
  assert((await findingsRow.locator(".outline-pages").textContent()) === "1", "a folder row shows its page count");
  const twist = table.getByRole("button", { name: "Expand Findings" });
  await twist.click();
  await table.getByRole("link", { name: "Evidence" }).waitFor();
  assert((await table.getByRole("button", { name: "Collapse Findings" }).getAttribute("aria-expanded")) === "true", "the chevron reports the open row");
  const evidenceRow = table.locator("tr", { has: page.getByRole("link", { name: "Evidence" }) });
  assert((await evidenceRow.locator(".outline-pages").textContent()) === "—", "a leaf row shows a dash for pages");
  await table.getByRole("button", { name: "Collapse Findings" }).click();
  await table.getByRole("link", { name: "Evidence" }).waitFor({ state: "detached" });

  const filter = pages.getByRole("searchbox", { name: "Filter pages" });
  await filter.fill("EVID");
  await table.getByRole("link", { name: "Evidence" }).waitFor();
  assert(
    JSON.stringify(await rowNames()) === '["Findings","Evidence"]',
    `filtering keeps the matches and their ancestors (got ${JSON.stringify(await rowNames())})`,
  );
  await filter.fill("zzz");
  await table.getByText("No pages match").waitFor();
  await filter.fill("");
  await table.getByRole("link", { name: "Evidence" }).waitFor({ state: "detached" });

  await table.getByRole("link", { name: "Findings" }).click();
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
  await table.getByRole("link", { name: "Fresh page" }).waitFor();
  assert((await count()) === "3 pages", "the new page joins the Contents count");
  assert(
    JSON.stringify(await rowNames()) === '["Findings","Fresh page"]',
    `rows keep the sidebar's order until a header is clicked (got ${JSON.stringify(await rowNames())})`,
  );
  const updated = table.getByRole("button", { name: /^Updated/ });
  await updated.click();
  assert((await updated.textContent()) === "Updated ↓", "the active column shows its direction");
  assert(
    JSON.stringify(await rowNames()) === '["Fresh page","Findings"]',
    `the Updated header sorts newest first (got ${JSON.stringify(await rowNames())})`,
  );
  await updated.click();
  assert((await updated.textContent()) === "Updated ↑", "a second click flips the direction");
  assert(
    JSON.stringify(await rowNames()) === '["Findings","Fresh page"]',
    `the flipped sort reads oldest first (got ${JSON.stringify(await rowNames())})`,
  );

  const onCollectionPage = async (msg) => {
    await page.waitForURL((url) => url.pathname.startsWith("/c/"));
    const heading = await page.locator(".collection-page h1").textContent();
    assert(heading === c, `${msg} (heading ${JSON.stringify(heading)})`);
    const contents = page.locator(".collection-page .outline-table");
    await contents.getByRole("link", { name: "Research" }).waitFor();
    assert((await contents.getByRole("link", { name: "Findings" }).count()) === 0, "the collection table starts with nested rows folded");
    await page.locator(".collection-page .outline-bar").getByRole("button", { name: "New document" }).waitFor();
  };
  await page.locator(".breadcrumbs .crumb-collection").click();
  await onCollectionPage("the collection crumb opens the collection page");

  await page.goto(parentUrl);
  await page.waitForSelector(".ProseMirror");
  const openCollectionPage = async (row) => {
    await row.hover();
    await row.getByTitle("More actions").click();
    await page.getByRole("menuitem", { name: "Open collection page" }).click();
  };
  await openCollectionPage(collectionRow);
  await onCollectionPage("the collection menu opens the collection page");

  const other = `Other ${Date.now()}`;
  await createCollection(page, other);
  const otherRow = page.locator(".collection-row", { hasText: other });
  const treeRequests = /\/trpc\/[^?]*documents\.tree/;
  await page.route(treeRequests, (route) => route.fulfill({ status: 500, body: "down" }));
  await otherRow.locator(".collection-name").click();
  await page.locator(".tree-note", { hasText: "Couldn't load documents." }).waitFor({ timeout: 20000 });
  const describedBy = () => otherRow.evaluate((row) => document.getElementById(row.getAttribute("aria-describedby"))?.textContent);
  assert((await describedBy()) === "Couldn't load documents.", "a failed load describes its collection row");
  await page.unroute(treeRequests);
  await otherRow.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Retry loading" }).press("Enter");
  await page.locator(".tree-note", { hasText: "No documents yet." }).waitFor();
  const description = await describedBy();
  assert(description === "No documents yet.", `the empty note describes its collection row (got ${JSON.stringify(description)})`);
  const treeSnapshot = await page.locator(".tree").ariaSnapshot();
  assert(!treeSnapshot.includes("No documents yet"), `the tree owns only tree items (got ${treeSnapshot})`);
  await newDocument(page, other);
  await page.fill(".title-input", "Elsewhere");
  await page.locator(".doc-row", { hasText: "Elsewhere" }).waitFor();
  await openCollectionPage(collectionRow);
  await onCollectionPage("the collection menu opens the collection page from another collection");
  const collectionPage = page.locator(".collection-page");
  const pageFilter = collectionPage.getByRole("searchbox", { name: "Filter pages" });
  await pageFilter.fill("zzz");
  await collectionPage.getByText("No pages match").waitFor();
  await openCollectionPage(otherRow);
  await collectionPage.locator("h1", { hasText: other }).waitFor();
  await collectionPage.getByRole("link", { name: "Elsewhere" }).waitFor({ timeout: 3000 });
  assert((await pageFilter.inputValue()) === "", "another collection's page opens with an empty filter");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "EXPLORER PASS — resizable, persisted pane; drawer under 900px; overlay actions, tooltips, guides; collapse all, reveal active; keyboard navigation, move and row menu; collection notes as row descriptions, keyboard retry; folder-table contents (fold, filter, sort, new page); collection page links; contents reset per collection",
  );
} finally {
  await browser.close();
}
