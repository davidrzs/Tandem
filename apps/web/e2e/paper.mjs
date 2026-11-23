// The document view's quiet defaults: the sidebar steps aside on document
// pages when tucked away (peek at the left edge, pin with the toggle), a "+" on empty lines
// opens the block menu, open comments sit in the margin beside their text,
// and the header fades while typing. Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const expect = async (cond, what) => {
  try {
    await page.waitForFunction(cond, null, { timeout: 5000 });
  } catch {
    throw new Error(`expected: ${what}`);
  }
};

try {
  await signUp(page, "Paula Paper", { tuckSidebar: true });
  const c = `Paper ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);

  // --- sidebar: collapsed on a document page, peeks at the edge, pins ---
  await expect(() => !!document.querySelector(".app[data-sidebar-collapsed]"), "collapsed on a doc page");
  await page.locator(".sidebar").waitFor({ state: "hidden" });
  await page.mouse.move(3, 500);
  await page.locator(".sidebar[data-peek]").waitFor({ state: "visible" });
  await page.mouse.move(900, 500);
  await page.locator(".sidebar").waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Show sidebar" }).click();
  await page.locator(".sidebar").waitFor({ state: "visible" });
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  if (!(await page.locator(".sidebar").isVisible())) throw new Error("pinned sidebar not kept across reload");
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await page.locator(".sidebar").waitFor({ state: "hidden" });

  // Leaving the document brings the sidebar back at full width.
  const docUrl = page.url();
  await page.mouse.move(3, 500);
  await page.locator(".sidebar[data-peek]").getByRole("link", { name: "Home" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await expect(
    () => document.querySelector(".sidebar").getBoundingClientRect().width >= 200 &&
      !document.querySelector(".app[data-sidebar-collapsed]"),
    "sidebar open at full width off a document page",
  );
  await page.goto(docUrl);
  await page.waitForSelector(".ProseMirror");
  await page.locator(".sidebar").waitFor({ state: "hidden" });

  // --- "+" on an empty line opens the block menu ---
  await page.click(".ProseMirror");
  await page.keyboard.type("Alpha beta gamma.");
  await page.keyboard.press("Enter");
  const plus = page.getByRole("button", { name: "Insert block" });
  await plus.waitFor();
  await plus.click();
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter"); // Heading 1
  await page.waitForSelector(".ProseMirror h1");
  await page.keyboard.type("Next part");
  if (await plus.isVisible()) throw new Error("inserter shown on a non-empty line");

  // --- typing fades the header; the pointer brings it back ---
  await expect(() => !!document.querySelector(".doc-page.is-typing"), "header fades while typing");
  await page.mouse.move(700, 300);
  await page.mouse.move(720, 320);
  await expect(() => !document.querySelector(".doc-page.is-typing"), "header returns on pointer move");

  // --- margin comments ---
  const para = page.locator(".ProseMirror p", { hasText: "Alpha beta gamma." });
  await para.click({ clickCount: 3 });
  await page.locator(".bubble-btn", { hasText: "Comment" }).click();
  const margin = page.locator(".margin-comments");
  await margin.locator(".comment-composer textarea").fill("Too vague?");
  if (await page.locator(".comments-panel").isVisible()) throw new Error("panel opened in margin mode");
  await margin.getByRole("button", { name: "Comment", exact: true }).click();

  const card = margin.locator(".margin-slot.active .comment-thread");
  await card.locator(".comment-text", { hasText: "Too vague?" }).waitFor();
  // Beside its text: the card's top lines up with the paragraph.
  await page.waitForTimeout(400); // the slide into place
  const [cardBox, paraBox] = [await card.boundingBox(), await para.boundingBox()];
  if (Math.abs(cardBox.y - paraBox.y) > 24) {
    throw new Error(`margin card at y=${cardBox.y}, its text at y=${paraBox.y}`);
  }
  if (cardBox.x < paraBox.x + paraBox.width) throw new Error("margin card overlaps the text");

  await card.getByRole("button", { name: "Reply" }).click();
  await margin.locator(".comment-composer textarea").fill("Agreed.");
  await margin.getByRole("button", { name: "Reply", exact: true }).click();
  await card.locator(".comment-reply .comment-text", { hasText: "Agreed." }).waitFor();

  // Clicking other text folds the thread to a summary; clicking its
  // highlighted text opens it again.
  await page.locator(".ProseMirror h1").click();
  const summary = margin.locator(".margin-summary");
  await summary.waitFor();
  if (!(await summary.textContent()).includes("1 reply")) throw new Error("summary lacks reply count");
  await page.locator(".comment-span").click();
  await card.waitFor();

  // The Comments button opens the full panel, and the margin gives way.
  await page.getByRole("button", { name: /^Comments( \(\d+\))?$/ }).click();
  await page.locator(".comments-panel").waitFor();
  await margin.waitFor({ state: "detached" });

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("PAPER PASS — sidebar peek/pin, block inserter, typing fade, margin comments");
} catch (e) {
  await page.screenshot({ path: "/tmp/paper-fail.png", fullPage: true });
  throw e;
} finally {
  await browser.close();
}
