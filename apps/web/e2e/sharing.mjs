// Per-collection access: Alice sets a collection to "Members can view", invites
// Bob; Bob can read the doc but the editor is read-only. Assumes web+api up.
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const stamp = Date.now();
const collectionName = `ReadOnly ${stamp}`;
const title = `Doc ${stamp}`;
const browser = await chromium.launch();
const errors = [];

async function signUp(ctx, label, name, email) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  await page.goto(BASE);
  await page.getByText("Need an account? Sign up").click();
  await page.fill('input[placeholder="Name"]', name);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "supersecret123");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar");
  return page;
}
const sectionAdd = (page, name) =>
  page.locator(".section", { hasText: name }).locator(".add");

try {
  // Alice creates a collection, marks it view-only, adds a doc with content.
  const a = await signUp(await browser.newContext(), "Alice", "Alice", `ro-alice-${stamp}@example.com`);
  a.once("dialog", (d) => d.accept(collectionName));
  await sectionAdd(a, "Collections").click();
  await a.getByText(collectionName, { exact: true }).click();
  await a.selectOption(".access-select", "read");
  await sectionAdd(a, "Documents").click();
  await a.waitForSelector(".title-input");
  await a.fill(".title-input", title);
  await a.click(".ProseMirror");
  await a.type(".ProseMirror", "Read me, do not edit.");
  await a.getByText(title, { exact: true }).first().waitFor({ timeout: 10000 });
  await a.waitForTimeout(800);
  await a.getByText("Invite someone").click();
  await a.waitForSelector(".invite-link");
  const inviteUrl = await a.inputValue(".invite-link");

  // Bob joins and opens the doc — should be read-only.
  const b = await signUp(await browser.newContext(), "Bob", "Bob", `ro-bob-${stamp}@example.com`);
  await b.goto(inviteUrl);
  await b.waitForSelector(".sidebar");
  await b.selectOption(".ws-select", { label: "Alice workspace" });
  await b.getByText(collectionName, { exact: true }).click();
  await b.getByText(title, { exact: true }).click();
  await b.waitForSelector(".ProseMirror");

  // Bob sees the content...
  await b.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("Read me, do not edit."),
    { timeout: 10000 },
  );
  // ...but the editor is read-only.
  await b.waitForFunction(
    () => document.querySelector(".save-state")?.textContent === "Read only",
    { timeout: 5000 },
  );
  const editable = await b.getAttribute(".ProseMirror", "contenteditable");
  if (editable !== "false") throw new Error(`editor should be read-only, got contenteditable=${editable}`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("SHARING PASS — view-only collection: member can read but the editor is read-only");
} finally {
  await browser.close();
}
