// Cross-user realtime collaboration via an invite: Alice creates a doc and
// invites Bob into her workspace; Bob accepts, opens the doc, and edits sync
// live in both directions. Assumes web (5173) + api (3001) running (run.sh).
import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const stamp = Date.now();
const collectionName = `Shared ${stamp}`;
const title = `Doc ${stamp}`;
const password = "supersecret123";
const browser = await chromium.launch();
const errors = [];

async function signUp(ctx, label, name, email) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
  await page.goto(BASE);
  await page.getByText("Need an account? Sign up").click();
  await page.fill('input[placeholder="Name"]', name);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar");
  return page;
}

const sectionAdd = (page, name) =>
  page.locator(".section", { hasText: name }).locator(".add");

try {
  // Alice: sign up, create a collection + document, type into it.
  const a = await signUp(await browser.newContext(), "Alice", "Alice", `alice-${stamp}@example.com`);
  a.once("dialog", (d) => d.accept(collectionName));
  await sectionAdd(a, "Collections").click();
  await a.getByText(collectionName, { exact: true }).click();
  await sectionAdd(a, "Documents").click();
  await a.waitForSelector(".title-input");
  await a.fill(".title-input", title);
  await a.click(".ProseMirror");
  await a.type(".ProseMirror", "Hello from Alice.");
  await a.getByText(title, { exact: true }).first().waitFor({ timeout: 10000 });
  await a.waitForTimeout(800);

  // Alice generates an invite link.
  await a.getByText("Invite someone").click();
  await a.waitForSelector(".invite-link");
  const inviteUrl = await a.inputValue(".invite-link");
  if (!inviteUrl.includes("/invite?token=")) throw new Error(`bad invite url: ${inviteUrl}`);

  // Bob: a different user. Accept the invite, switch to Alice's workspace, open the doc.
  const b = await signUp(await browser.newContext(), "Bob", "Bob", `bob-${stamp}@example.com`);
  await b.goto(inviteUrl);
  await b.waitForSelector(".sidebar");
  await b.selectOption(".ws-select", { label: "Alice workspace" });
  await b.getByText(collectionName, { exact: true }).click();
  await b.getByText(title, { exact: true }).click();
  await b.waitForSelector(".ProseMirror");

  // Bob sees Alice's text live.
  await b.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("Hello from Alice."),
    { timeout: 10000 },
  );

  // Bob appends; Alice sees it live (bidirectional, cross-user).
  await b.click(".ProseMirror");
  await b.keyboard.press("End");
  await b.type(".ProseMirror", " And hi from Bob.");
  await a.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent?.includes("And hi from Bob."),
    { timeout: 10000 },
  );

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("COLLAB PASS — two users collaborate live after an invite (cross-workspace sharing)");
} finally {
  await browser.close();
}
