// Inline comments: select text → comment → reply → resolve. Needs web+api.
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Comment User");
  const c = `Comments ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);

  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "The quick brown fox jumps.");
  await page.keyboard.press("Control+a"); // non-empty selection → comment bubble

  await page.locator(".bubble-btn", { hasText: "Comment" }).click();
  const panel = page.locator(".comments-panel");
  await panel.locator(".comment-composer textarea").fill("Is this the right phrasing?");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();

  const thread = panel.locator(".comment-thread").first();
  await thread.locator(".comment-text", { hasText: "Is this the right phrasing?" }).waitFor();

  // Reply to the thread.
  await thread.getByRole("button", { name: "Reply" }).click();
  await panel.locator(".comment-composer textarea").fill("Yes — ship it.");
  await panel.getByRole("button", { name: "Reply", exact: true }).click();
  await thread.locator(".comment-reply .comment-text", { hasText: "Yes — ship it." }).waitFor();

  // Resolve it — the thread moves behind the "Show N resolved" toggle.
  await thread.locator('.row-action[title="Resolve"]').click();
  await panel.getByText(/Show 1 resolved/).waitFor();

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("COMMENTS PASS — comment, reply, and resolve all work");
} finally {
  await browser.close();
}
