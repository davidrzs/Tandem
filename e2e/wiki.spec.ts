import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * Smoke journey against the real server (in-memory DB, built SPA): sign-up,
 * collection + document creation, live editing over Yjs, authorship (blame),
 * task assignment -> start page, search, archive/restore, deep links, and
 * tenant isolation between two accounts.
 */

async function signUp(page: Page, name: string, email: string) {
  await page.goto("/");
  // A brand-new server shows the first-run setup wizard instead of the
  // sign-in form; the first caller becomes the admin and opens registration so
  // the rest of the suite can self-register. Everyone after sees the form.
  const wizardBtn = page.getByRole("button", { name: "Create admin & finish" });
  const signupToggle = page.getByText("Need an account? Sign up");
  await expect(wizardBtn.or(signupToggle)).toBeVisible();
  if (await wizardBtn.isVisible()) {
    // "Server name" also contains "Name", so match the account field exactly.
    await page.getByPlaceholder("Name", { exact: true }).fill(name);
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder(/Password/).fill("password-123");
    await page.locator("select").selectOption("open");
    await wizardBtn.click();
  } else {
    await signupToggle.click();
    await page.getByPlaceholder("Name", { exact: true }).fill(name);
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder("Password").fill("password-123");
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
  }
  // Signed in: the sidebar footer shows the account with a sign-out control.
  await expect(page.getByTitle("Sign out")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
}

/**
 * Nest one document row under another via synthetic HTML5 drag events. The
 * mouse-based dragTo doesn't drive HTML5 DnD reliably in headless Chromium, and
 * a single drop occasionally doesn't register — so poll, re-dispatching the
 * dragover+drop until the source row reaches the expected indent.
 */
async function dragNest(page: Page, sourceText: string, targetText: string, indent: string) {
  const source = page.locator(".doc-row", { hasText: sourceText });
  await expect
    .poll(
      async () => {
        // Two phases with a tick between: React must apply the dragover
        // drop-target state before the drop handler reads it. The DataTransfer
        // is stashed on window to survive the evaluate boundary.
        await page.evaluate(
          ([s, t]) => {
            const byText = (x: string) =>
              [...document.querySelectorAll(".doc-row")].find((r) => r.textContent?.includes(x));
            const src = byText(s);
            const dst = byText(t);
            if (!src || !dst) return;
            const dt = new DataTransfer();
            (window as unknown as { __dt: DataTransfer }).__dt = dt;
            src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
            const rect = dst.getBoundingClientRect();
            dst.dispatchEvent(
              new DragEvent("dragover", {
                bubbles: true,
                cancelable: true,
                dataTransfer: dt,
                clientY: rect.top + rect.height / 2,
              }),
            );
          },
          [sourceText, targetText],
        );
        await page.waitForTimeout(120);
        await page.evaluate((t) => {
          const dst = [...document.querySelectorAll(".doc-row")].find((r) =>
            r.textContent?.includes(t),
          );
          const dt = (window as unknown as { __dt?: DataTransfer }).__dt;
          if (!dst || !dt) return;
          const rect = dst.getBoundingClientRect();
          dst.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
              clientY: rect.top + rect.height / 2,
            }),
          );
        }, targetText);
        return source.evaluate((el) => getComputedStyle(el).paddingLeft);
      },
      { timeout: 12_000, intervals: [300, 400, 600] },
    )
    .toBe(indent);
}

async function createCollection(page: Page, name: string) {
  await page.getByTitle("New collection").click();
  const dialog = page.getByRole("dialog", { name: "New collection" });
  await dialog.locator("input").fill(name);
  await dialog.getByRole("button", { name: "Create collection" }).click();
  await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
}

test.describe.serial("wiki journey", () => {
  test("sign up, write, blame, tasks, search, archive", async ({ page }) => {
    await signUp(page, "Alice Wonder", "alice@example.com");
    await expect(page.getByRole("heading", { name: "Hi Alice" })).toBeVisible();

    // As the first user Alice is the server admin: the Admin console opens and
    // shows the server-administration surface.
    await page.getByRole("button", { name: "Admin", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Server administration" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Server settings" })).toBeVisible();
    await page.locator(".modal-close").click();

    // --- create a collection and a document ---
    await createCollection(page, "Handbook");
    await page.getByRole("button", { name: /Handbook/ }).click();
    // Row actions only appear on hover.
    await page.locator(".collection-row", { hasText: "Handbook" }).hover();
    await page.getByTitle("New document").first().click();
    await expect(page).toHaveURL(/\/d\//);

    // --- title + body over the live collab channel ---
    await page.locator(".title-input").fill("Onboarding");
    await expect(page.locator(".save-state").last()).toHaveText(/Live|Saving/);
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("Welcome to the team wiki.");
    await page.keyboard.press("Enter");
    // "[ ] " at line start is the checkbox input rule (also: /to-do).
    await page.keyboard.type("[ ] @alice review the handbook");
    // The @ mention suggestion may be open; close it before continuing.
    await page.keyboard.press("Escape");
    await expect(page.locator(".ProseMirror")).toContainText("review the handbook");
    // Task list markdown became a real checkbox item.
    await expect(page.locator('.ProseMirror ul[data-type="taskList"] li')).toHaveCount(1);
    // The @mention resolves to a member and gets its identity tint.
    await expect(page.locator(".mention")).toContainText("@alice");

    // Let the debounced store persist (server debounce is 2s).
    await page.waitForTimeout(2600);

    // --- deep link survives a full reload ---
    const docUrl = page.url();
    await page.reload();
    await expect(page.locator(".ProseMirror")).toContainText("Welcome to the team wiki.");
    await expect(page.locator(".title-input")).toHaveValue("Onboarding");

    // --- history: my typing is attributed to me, calmly hidden by default ---
    await expect(page.locator(".blame-span")).toHaveCount(0);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.locator(".history-item")).toContainText([/All sessions/, /Alice Wonder/]);
    await expect(page.locator(".blame-span").first()).toBeVisible();
    // Selecting one session narrows the highlights to it.
    await page.locator(".history-item", { hasText: "Alice Wonder" }).first().click();
    await expect(page.locator(".blame-span").first()).toBeVisible();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.locator(".blame-span")).toHaveCount(0);

    // --- the assigned task shows up on my start page ---
    await page.getByRole("link", { name: "Home" }).click();
    await expect(page.getByText("1 open task assigned to you.")).toBeVisible();
    await expect(page.getByText("@alice review the handbook")).toBeVisible();
    // The todo card's link (the sidebar also has one).
    await page.getByRole("main").getByRole("link", { name: "Onboarding" }).click();
    await expect(page).toHaveURL(docUrl);

    // --- search finds the document by body text ---
    await page.getByRole("button", { name: /Search/ }).click();
    await page.getByPlaceholder("Search documents…").fill("team wiki");
    await expect(page.locator(".search-hit")).toContainText(["Onboarding"]);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(docUrl);

    // --- archive from the sidebar, restore from the banner ---
    const docRow = page.locator(".doc-row", { hasText: "Onboarding" });
    await docRow.hover();
    await docRow.getByTitle("More actions").click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByRole("heading", { name: "Hi Alice" })).toBeVisible();
    await expect(page.locator(".doc-row", { hasText: "Onboarding" })).toHaveCount(0);
    // Archived tasks leave the start page.
    await expect(page.getByText("No open tasks are assigned to you.")).toBeVisible();

    await page.getByRole("button", { name: /Archived \(1\)/ }).click();
    await page.getByRole("link", { name: "Onboarding" }).click();
    await expect(page.getByText("This document is archived")).toBeVisible();
    // The archived sidebar row has a Restore icon too; use the banner's.
    await page.locator(".archived-banner").getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("This document is archived")).toHaveCount(0);
    await expect(page.locator(".doc-row", { hasText: "Onboarding" })).toBeVisible();

    // --- ticking the checkbox completes the task on the start page ---
    await page.locator('.ProseMirror ul[data-type="taskList"] input[type="checkbox"]').click();
    await page.waitForTimeout(2600); // debounced store
    await page.getByRole("link", { name: "Home" }).click();
    await expect(page.getByText("No open tasks are assigned to you.")).toBeVisible();
    await page.getByRole("button", { name: "Show 1 completed" }).click();
    await expect(page.getByText("@alice review the handbook")).toBeVisible();
  });

  test("a second account sees none of it", async ({ page }) => {
    await signUp(page, "Bob Builder", "bob@example.com");
    await expect(page.getByRole("heading", { name: "Hi Bob" })).toBeVisible();
    await expect(page.getByText("No collections yet — create one.")).toBeVisible();

    // Bob is a regular member: no admin surface.
    await expect(page.getByRole("button", { name: "Admin", exact: true })).toHaveCount(0);

    // Search across the tenant finds nothing of Alice's.
    await page.getByRole("button", { name: /Search/ }).click();
    await page.getByPlaceholder("Search documents…").fill("team wiki");
    await expect(page.getByText(/Nothing matches that search/)).toBeVisible();
    await page.keyboard.press("Escape");

    // Settings: the MCP switch, connect info, and (empty) audit trail.
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByText("Allow AI agents to act as me")).toBeVisible();
    await expect(dialog.locator("code.copyable")).toContainText("/mcp");
    await expect(dialog.getByText("No agent actions recorded yet.")).toBeVisible();
    const toggle = dialog.locator(".switch-row input");
    // The checkbox is disabled until settings.get resolves — wait, or the
    // click is dropped ("did not change its state").
    await expect(toggle).toBeEnabled();
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    // The choice persists across a reload.
    await page.reload();
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("dialog", { name: "Settings" }).locator(".switch-row input")).not.toBeChecked();
  });
});

test("two users: invite, presence, second-author blame, read-only", async ({ browser }) => {
  // --- Carol sets up a workspace with a doc ---
  const carolCtx = await browser.newContext();
  const carol = await carolCtx.newPage();
  await signUp(carol, "Carol Chen", "carol@example.com");
  await createCollection(carol, "Research");
  await carol.getByRole("button", { name: /Research/ }).click();
  await carol.locator(".collection-row", { hasText: "Research" }).hover();
  await carol.getByTitle("New document").first().click();
  await carol.locator(".title-input").fill("Paper draft");
  await carol.locator(".ProseMirror").click();
  await carol.keyboard.type("Carol wrote the abstract.");
  await expect(carol.locator(".save-state").last()).toHaveText(/Live/);

  // --- invite Dave via the People modal (member role) ---
  await carol.getByRole("button", { name: "People & groups" }).click();
  await carol.getByRole("button", { name: "Create invite link" }).click();
  const inviteLink = await carol.locator(".invite-link").inputValue();
  await carol.locator(".modal-close").click();

  const daveCtx = await browser.newContext();
  const dave = await daveCtx.newPage();
  await signUp(dave, "Dave Diaz", "dave@example.com");
  await dave.goto(inviteLink);
  await expect(dave.getByRole("button", { name: /Research/ })).toBeVisible();

  // --- Dave opens the same doc; both see presence; Dave's text is his ---
  const docUrl = carol.url();
  await dave.goto(docUrl);
  await expect(dave.locator(".ProseMirror")).toContainText("Carol wrote the abstract.");
  await expect(carol.locator(".presence-avatar")).toHaveText("D");
  await expect(dave.locator(".presence-avatar")).toHaveText("C");

  await dave.locator(".ProseMirror").click();
  await dave.keyboard.press("ControlOrMeta+End");
  await dave.keyboard.press("Enter");
  await dave.keyboard.type("Dave added the method section.");
  await expect(carol.locator(".ProseMirror")).toContainText("Dave added the method section.");

  // History on Carol's screen attributes each part to its author.
  await carol.getByRole("button", { name: "History", exact: true }).click();
  await expect(carol.locator(".comments-panel")).toContainText("Carol Chen");
  await expect(carol.locator(".comments-panel")).toContainText("Dave Diaz");
  const daveSpan = carol.locator(".blame-span", { hasText: "method section" }).first();
  const carolSpan = carol.locator(".blame-span", { hasText: "abstract" }).first();
  // Human labels are plain names — "Dave Diaz's AI" would mark agent edits.
  await expect(daveSpan).toHaveAttribute("data-blame-label", "Dave Diaz");
  await expect(carolSpan).toHaveAttribute("data-blame-label", "Carol Chen");

  // --- Carol restricts the collection to view-only for members ---
  const researchRow = carol.locator(".collection-row", { hasText: "Research" });
  await researchRow.hover();
  await researchRow.getByTitle("More actions").click();
  await carol.getByRole("menuitem", { name: "Share & access" }).click();
  await carol.locator(".field select").selectOption("read");
  await carol.locator(".modal-close").click();

  await dave.reload();
  await expect(dave.getByText("Read only")).toBeVisible();
  await expect(dave.locator(".ProseMirror")).toContainText("method section");
  const before = await dave.locator(".ProseMirror").innerText();
  await dave.locator(".ProseMirror").click();
  await dave.keyboard.type("SNEAKY EDIT");
  await expect(dave.locator(".ProseMirror")).not.toContainText("SNEAKY EDIT");
  expect(await dave.locator(".ProseMirror").innerText()).toBe(before);

  // --- comments sync live over the collab channel ---
  await carol.locator(".ProseMirror").dblclick({ position: { x: 40, y: 12 } });
  await carol.locator(".bubble-btn").click();
  await carol.locator(".comment-composer textarea").fill("Can we cite this?");
  await carol.locator(".comment-composer").getByRole("button", { name: "Comment" }).click();
  // Dave has the doc open read-only; the thread appears without any reload.
  await dave.getByRole("button", { name: /Comments \(1\)/ }).click();
  await expect(dave.locator(".comment-thread")).toContainText("Can we cite this?");
  // And a read-only member can reply.
  await dave.locator(".comment-thread").getByRole("button", { name: "Reply" }).click();
  await dave.locator(".comment-composer textarea").fill("Adding the DOI.");
  await dave.locator(".comment-composer").getByRole("button", { name: "Reply" }).click();
  await expect(carol.locator(".comment-thread")).toContainText("Adding the DOI.");

  // --- a group grant restores Dave's write access ---
  await carol.getByRole("button", { name: "People & groups" }).click();
  await carol.getByPlaceholder("New group name").fill("Editors");
  await carol.getByRole("button", { name: "Create group" }).click();
  await carol.getByRole("button", { name: /Editors/ }).click();
  await carol.locator(".group-body select").selectOption({ label: "Dave Diaz (dave@example.com)" });
  await expect(carol.locator(".group-member")).toContainText("Dave Diaz");
  await carol.locator(".modal-close").click();

  await researchRow.hover();
  await researchRow.getByTitle("More actions").click();
  await carol.getByRole("menuitem", { name: "Share & access" }).click();
  await carol.locator(".grant-add select").first().selectOption({ label: "Editors (group)" });
  await carol.locator(".grant-add select").nth(1).selectOption("read_write");
  await carol.getByRole("button", { name: "Grant" }).click();
  await expect(carol.locator(".grant-list")).toContainText("Editors (group)");
  await carol.locator(".modal-close").click();

  await dave.reload();
  await expect(dave.locator(".ProseMirror")).toContainText("method section");
  await expect(dave.getByText("Read only")).toHaveCount(0);
  await dave.locator(".ProseMirror").click();
  await dave.keyboard.press("ControlOrMeta+End");
  await dave.keyboard.type(" Group access works.");
  await expect(carol.locator(".ProseMirror")).toContainText("Group access works.");

  await carolCtx.close();
  await daveCtx.close();
});

test("drag and drop nests a document under another", async ({ page }) => {
  await signUp(page, "Erin Ess", "erin@example.com");
  await createCollection(page, "DnD");
  await page.getByRole("button", { name: /DnD/ }).click();
  const row = page.locator(".collection-row", { hasText: "DnD" });
  for (const title of ["First", "Second"]) {
    const before = page.url();
    await row.hover();
    await page.getByTitle("New document").first().click();
    // Wait for the new doc's editor — filling early would rename the old one.
    await expect(page).not.toHaveURL(before);
    await page.locator(".title-input").fill(title);
    await expect(page.locator(".doc-row", { hasText: title })).toBeVisible();
  }

  // Drop "Second" onto the middle of "First" -> nested child (indent 9+14=23px).
  await dragNest(page, "Second", "First", "23px");

  // The nesting survives a reload (persisted through documents.move).
  await page.reload();
  await expect(page.locator(".doc-row", { hasText: "Second" })).toHaveCSS(
    "padding-left",
    "23px",
  );
});

test("comments: select text, discuss, reply, resolve", async ({ page }) => {
  await signUp(page, "Grace Hopper", "grace@example.com");
  await createCollection(page, "Reviews");
  await page.getByRole("button", { name: /Reviews/ }).click();
  await page.locator(".collection-row", { hasText: "Reviews" }).hover();
  await page.getByTitle("New document").first().click();
  await page.locator(".title-input").fill("Draft");
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("The methods section needs work.");
  await expect(page.locator(".save-state").last()).toHaveText(/Live/);

  // Select a word -> bubble -> comment.
  await page.locator(".ProseMirror").dblclick({ position: { x: 40, y: 12 } });
  await page.locator(".bubble-btn").click();
  const composer = page.locator(".comment-composer textarea");
  await composer.fill("Please expand this before Friday.");
  await page.locator(".comment-composer").getByRole("button", { name: "Comment" }).click();

  const thread = page.locator(".comment-thread");
  await expect(thread).toContainText("Grace Hopper");
  await expect(thread).toContainText("Please expand this before Friday.");
  await expect(page.locator(".comment-span").first()).toBeVisible();

  // Reply and resolve.
  await thread.getByRole("button", { name: "Reply" }).click();
  await page.locator(".comment-composer textarea").fill("Done, see the new paragraph.");
  await page.locator(".comment-composer").getByRole("button", { name: "Reply" }).click();
  await expect(thread).toContainText("Done, see the new paragraph.");

  await thread.hover();
  await thread.getByTitle("Resolve").click();
  await expect(page.getByText("No open comments.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Show 1 resolved" }).click();
  await expect(page.locator(".comment-thread.resolved")).toContainText("Please expand this");

  // The highlight is gone once resolved.
  await expect(page.locator(".comment-span")).toHaveCount(0);
});

test("cross-references: @-link a page, rename and move survive, backlinks", async ({ page }) => {
  await signUp(page, "Hana Kim", "hana@example.com");
  await createCollection(page, "Wiki");
  await page.getByRole("button", { name: /Wiki/ }).click();
  const wikiRow = page.locator(".collection-row", { hasText: "Wiki" });

  // Two sibling documents.
  const mkDoc = async (title: string) => {
    const before = page.url();
    await wikiRow.hover();
    await page.getByTitle("New document").first().click();
    await expect(page).not.toHaveURL(before);
    await page.locator(".title-input").fill(title);
    await expect(page.locator(".doc-row", { hasText: title })).toBeVisible();
    return page.url();
  };
  await mkDoc("Alpha notes");
  const urlB = await mkDoc("Beta results");
  await page.waitForTimeout(600); // title save debounce before searching

  // In Alpha, "@" links the Beta page as a first-class reference chip.
  await page.locator(".doc-row", { hasText: "Alpha notes" }).click();
  await page.locator(".ProseMirror").click();
  await page.keyboard.type("Compare with @beta");
  await page.getByRole("button", { name: /Beta results/ }).click();
  await expect(page.locator(".page-ref")).toContainText("Beta results");
  await page.waitForTimeout(2600); // persist (debounced store)

  // The chip navigates by ID.
  await page.locator(".page-ref").click();
  await expect(page).toHaveURL(urlB);

  // Rename the target -> the reference shows the new title (live, no edit).
  await page.locator(".title-input").fill("Beta results v2");
  await page.waitForTimeout(800); // title save debounce
  await page.locator(".doc-row", { hasText: "Alpha notes" }).click();
  await expect(page.locator(".page-ref")).toContainText("Beta results v2");

  // Move the target under Alpha (drag) -> the reference still resolves.
  await dragNest(page, "Beta results v2", "Alpha notes", "23px");
  await page.locator(".page-ref").click();
  await expect(page).toHaveURL(urlB); // same id, new place — still resolves

  // Backlinks: Beta lists Alpha under "Linked from".
  await expect(page.locator(".backlinks")).toContainText("Alpha notes");
  await page.locator(".backlink", { hasText: "Alpha notes" }).click();
  await expect(page.locator(".title-input")).toHaveValue("Alpha notes");
});

// ---------- server administration (Alice became the admin via the wizard) ----------

async function signIn(page: Page, email: string, password = "password-123") {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// Minimal RFC 6238 TOTP (SHA-1/6/30 — better-auth's defaults) so the test can
// act as the authenticator app.
function totp(secretBase32: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const code =
    (((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!) % 1e6;
  return code.toString().padStart(6, "0");
}

// Handed from the admin-console test to the invite-signup test (one worker).
let serverInviteLink = "";

test("admin console: registration policy, server invites, roles, audit", async ({ page }) => {
  await signIn(page, "alice@example.com");
  await expect(page.getByTitle("Sign out")).toBeVisible();

  await page.getByRole("button", { name: "Admin", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Server administration" });
  await expect(dialog).toBeVisible();

  // Switch the instance to invite-only.
  await dialog.locator("select").first().selectOption("invite");
  const save = dialog.getByRole("button", { name: /Save settings/ });
  await save.click();
  await expect(save).toBeDisabled(); // saved -> form no longer dirty

  // Mint a server invite; the link is redeemed by the next test.
  await dialog.getByRole("button", { name: "Create invite link" }).click();
  serverInviteLink = await dialog.locator(".invite-link").inputValue();
  expect(serverInviteLink).toContain("/invite?token=");

  // Promote Bob from the user roster.
  const bobRow = dialog.locator(".member-list li", { hasText: "bob@example.com" });
  await bobRow.getByTitle("More actions").click();
  await page.getByRole("menuitem", { name: "Make admin" }).click();
  await expect(bobRow).toContainText("admin");

  // Every action above is visible in the admin audit trail.
  const audit = dialog.locator(".audit-list");
  await expect(audit).toContainText("update settings");
  await expect(audit).toContainText("create invite");
  await expect(audit).toContainText("set role");
});

test("invite mode: no public signup, but the invite link signs a new user up", async ({ page }) => {
  // The login screen no longer offers self-registration.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Need an account? Sign up")).toHaveCount(0);

  // The server-invite link shows a signup form and lands in the app.
  await page.goto(serverInviteLink);
  await expect(page.getByText("You've been invited.")).toBeVisible();
  await page.getByPlaceholder("Name").fill("Gina Invited");
  await page.getByPlaceholder("Email").fill("gina@example.com");
  await page.getByPlaceholder(/Password/).fill("password-123");
  await page.getByRole("button", { name: "Sign up & join" }).click();
  await expect(page.getByTitle("Sign out")).toBeVisible();
  await expect(page.getByText("gina@example.com")).toBeVisible();
});

test("2FA: enroll in settings, then sign-in requires the code", async ({ page }) => {
  await signIn(page, "gina@example.com");
  await expect(page.getByTitle("Sign out")).toBeVisible();

  // Enroll: password -> secret + backup codes -> confirm with a live code.
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByPlaceholder("Confirm password to set up").fill("password-123");
  await dialog.getByRole("button", { name: "Set up 2FA" }).click();
  const secret = await dialog.locator(".invite-link").first().inputValue();
  expect(secret.length).toBeGreaterThan(10);
  await dialog.getByPlaceholder("6-digit code").fill(totp(secret));
  await dialog.getByRole("button", { name: "Confirm & enable" }).click();
  await expect(dialog.getByText("Two-factor authentication is on.")).toBeVisible();
  await page.locator(".modal-close").click();

  // A fresh sign-in now stops at the challenge until a valid code is entered.
  await page.getByTitle("Sign out").click();
  await signIn(page, "gina@example.com");
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await page.getByPlaceholder("123456").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  try {
    await expect(page.getByTitle("Sign out")).toBeVisible({ timeout: 8000 });
  } catch {
    // A 30s TOTP window can flip between fill and verify; retry with a fresh code.
    await page.getByPlaceholder("123456").fill(totp(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByTitle("Sign out")).toBeVisible();
  }
  await expect(page.getByText("gina@example.com")).toBeVisible();
});
