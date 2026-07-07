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
    await expect(page.getByText(/No documents match/)).toBeVisible();
    await page.keyboard.press("Escape");

    // Settings: the MCP switch, connect info, and (empty) audit trail.
    await page.getByRole("button", { name: "Settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByText("Allow AI agents to act as me")).toBeVisible();
    await expect(dialog.locator("code.copyable")).toContainText("/mcp");
    await expect(dialog.getByText("No agent actions recorded yet.")).toBeVisible();
    const toggle = dialog.locator(".switch-row input");
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
  await expect(carol.locator(".presence-dot")).toHaveText("D");
  await expect(dave.locator(".presence-dot")).toHaveText("C");

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

  // Drop "Second" onto the middle of "First" -> nested child (indented).
  // Synthetic DragEvents: Playwright's mouse-based dragTo doesn't drive HTML5
  // DnD reliably, and the two-phase dispatch lets React apply the dragover
  // state before the drop reads it.
  const rowByText = (text: string) =>
    `[...document.querySelectorAll(".doc-row")].find((r) => r.textContent?.includes("${text}"))`;
  await page.evaluate(`
    (() => {
      const second = ${rowByText("Second")};
      const first = ${rowByText("First")};
      const dt = new DataTransfer();
      window.__dnd = { dt, first };
      second.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const rect = first.getBoundingClientRect();
      first.dispatchEvent(new DragEvent("dragover", {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientY: rect.top + rect.height / 2,
      }));
    })()
  `);
  await page.waitForTimeout(120);
  await page.evaluate(`
    (() => {
      const { dt, first } = window.__dnd;
      const rect = first.getBoundingClientRect();
      first.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientY: rect.top + rect.height / 2,
      }));
    })()
  `);
  await expect
    .poll(async () =>
      page.locator(".doc-row", { hasText: "Second" }).evaluate((el) => getComputedStyle(el).paddingLeft),
    )
    .toBe("40px"); // depth 1 = 26 + 14

  // The nesting survives a reload (persisted through documents.move).
  await page.reload();
  await expect(page.locator(".doc-row", { hasText: "Second" })).toHaveCSS(
    "padding-left",
    "40px",
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
  const alpha = page.locator(".doc-row", { hasText: "Alpha notes" });
  const beta = page.locator(".doc-row", { hasText: "Beta results v2" });
  await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll(".doc-row")];
      const src = rows.find((r) => r.textContent?.includes("Beta results v2"));
      const dst = rows.find((r) => r.textContent?.includes("Alpha notes"));
      const dt = new DataTransfer();
      window.__xref = { dt, dst };
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const rect = dst.getBoundingClientRect();
      dst.dispatchEvent(new DragEvent("dragover", {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientY: rect.top + rect.height / 2,
      }));
    })()
  `);
  await page.waitForTimeout(120);
  await page.evaluate(`
    (() => {
      const { dt, dst } = window.__xref;
      const rect = dst.getBoundingClientRect();
      dst.dispatchEvent(new DragEvent("drop", {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientY: rect.top + rect.height / 2,
      }));
    })()
  `);
  await expect(beta).toHaveCSS("padding-left", "40px"); // nested now
  await page.locator(".page-ref").click();
  await expect(page).toHaveURL(urlB); // same id, new place — still resolves

  // Backlinks: Beta lists Alpha under "Linked from".
  await expect(page.locator(".backlinks")).toContainText("Alpha notes");
  await page.locator(".backlink", { hasText: "Alpha notes" }).click();
  await expect(page.locator(".title-input")).toHaveValue("Alpha notes");
  void alpha;
});
