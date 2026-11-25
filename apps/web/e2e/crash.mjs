// Crash guard: visit every major view with rich content present and assert the
// error boundary never appears and no uncaught page error fires. This is the
// regression net for "a view white-screens". Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// All three failure surfaces: the view ErrorBoundary ("Something went wrong"),
// the workspace-load panel, and the per-document load panel (both "Couldn't
// load …"). None should ever appear on a healthy path.
async function assertHealthy(where) {
  const boundary = await page.getByText("Something went wrong").count();
  const loadFail = await page.getByText(/Couldn't load/).count();
  if (boundary || loadFail) throw new Error(`error boundary shown at: ${where}`);
  if (errors.length) throw new Error(`page error at ${where}: ${errors.join(" | ")}`);
}

try {
  await signUp(page, "Crash User");
  await assertHealthy("home (fresh)");

  const c = `Crash ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  await page.fill(".title-input[contenteditable=true]", "Everything doc");

  // Rich content: math, a code block, a table, and a tag — the surfaces most
  // likely to break a render.
  await page.click(".doc-body");
  await page.type(".doc-body", "Math $E=mc^2$ here.");
  await page.keyboard.press("Enter");
  await page.type(".doc-body", "```js ");
  await page.type(".doc-body", "const x = 1;");
  await page.keyboard.press("ArrowDown");
  await page.type(".doc-body", "/table");
  await page.waitForSelector(".slash-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".doc-body table");
  await page.getByRole("button", { name: "Add tag" }).click();
  await page.locator(".tag-input").fill("check");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "check", exact: true }).waitFor();
  await assertHealthy("document with rich content");

  // History rail (versions + sessions). The toolbar buttons are icon-only;
  // exact names keep "Close history" / "Close comments" out of the match.
  const historyBtn = page.getByRole("button", { name: "History", exact: true });
  const commentsBtn = page.getByRole("button", { name: /^Comments( \(\d+\))?$/ });
  await historyBtn.click();
  await page.waitForSelector(".history-panel");
  await assertHealthy("history rail");
  await historyBtn.click(); // close

  // Comments rail.
  await commentsBtn.click();
  await page.waitForSelector(".comments-panel");
  await assertHealthy("comments rail");
  await commentsBtn.click(); // close

  // Search modal.
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".search-box");
  await page.locator(".search-input").fill("Everything");
  await assertHealthy("search");
  await page.keyboard.press("Escape");

  // Settings modal.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForSelector(".modal");
  await assertHealthy("settings");
  await page.keyboard.press("Escape");

  // People & groups modal, from the workspace menu.
  await page.locator(".ws-button").click();
  await page.getByRole("menuitem", { name: /People/ }).click();
  await page.waitForSelector(".modal");
  await assertHealthy("people");
  await page.keyboard.press("Escape");

  // Home, then reload the document from scratch.
  await page.getByRole("link", { name: "Home" }).click();
  await assertHealthy("home (with content)");
  await page.reload();
  await page.waitForSelector(".sidebar");
  await assertHealthy("after reload");

  console.log("CRASH-GUARD PASS — every view renders without hitting the error boundary");
} finally {
  await browser.close();
}
