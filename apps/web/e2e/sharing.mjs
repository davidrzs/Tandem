// Per-collection access: Alice sets a collection to "Members can view", invites
// Bob; Bob can read the doc but the editor is read-only. Assumes web+api up.
import { chromium } from "playwright";
import { signUp as signUpPage, createCollection, newDocument } from "./_helpers.mjs";

const stamp = Date.now();
const collectionName = `ReadOnly ${stamp}`;
const title = `Doc ${stamp}`;
const browser = await chromium.launch();
const errors = [];

async function signUp(ctx, label, name) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
  await signUpPage(page, name);
  return page;
}

try {
  // Alice creates a collection + doc, then marks the collection view-only.
  const a = await signUp(await browser.newContext(), "Alice", "Alice");
  await createCollection(a, collectionName);
  await newDocument(a, collectionName);
  await a.fill(".title-input", title);
  await a.click(".ProseMirror");
  await a.type(".ProseMirror", "Read me, do not edit.");
  await a.waitForTimeout(800);

  // Share & access → default role "Can view".
  const row = a.locator(".collection-row", { hasText: collectionName });
  await row.hover();
  await row.locator('.row-action[title="More actions"]').click();
  await a.getByRole("menuitem", { name: "Share & access" }).click();
  await a.locator(".modal select").first().selectOption("read");
  await a.waitForTimeout(400);
  await a.keyboard.press("Escape");

  // Invite Bob.
  await a.getByRole("button", { name: /People/ }).click();
  await a.getByRole("button", { name: "Create invite link" }).click();
  await a.waitForSelector(".invite-link");
  const inviteUrl = await a.inputValue(".invite-link");

  // Bob joins, switches to Alice's workspace, opens the doc.
  const b = await signUp(await browser.newContext(), "Bob", "Bob");
  await b.goto(inviteUrl);
  await b.waitForSelector(".sidebar");
  await b.locator(".ws-button").click();
  await b.getByRole("menuitem", { name: "Alice workspace" }).click();
  await b.locator(".collection-row").getByText(collectionName, { exact: true }).click();
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
