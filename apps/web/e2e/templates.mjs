// Templates: save a page (with a sub-page) as a template, make it a folder's
// default, then "+" on that folder asks for the template's prompt and creates
// the expanded page and its sub-page; the ▾ menu still offers a blank page,
// the Contents panel's ▾ (reached by keyboard) and the sidebar's "New from
// template…" offer the template, search skips the template, and changing a
// typed template's type asks first. Needs web+api (run.sh).
import { chromium } from "playwright";
import { BASE, signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const docIdOf = (url) => new URL(url).pathname.split("/").pop();

async function trpcQuery(path, input) {
  const res = await page.request.get(`${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  if (!res.ok()) throw new Error(`${path} failed: ${res.status()}`);
  return (await res.json()).result.data;
}

async function trpcMutation(path, input) {
  const res = await page.request.post(`${BASE}/trpc/${path}`, { data: input });
  if (!res.ok()) throw new Error(`${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).result.data;
}

/** Waits for the debounced collab store to persist a body containing `text`. */
async function waitForBody(id, text) {
  for (let i = 0; i < 40; i++) {
    const { markdown } = await trpcQuery("documents.getMarkdown", { id });
    if (markdown.includes(text)) return markdown;
    await page.waitForTimeout(250);
  }
  throw new Error(`body of ${id} never contained ${JSON.stringify(text)}`);
}

async function fillTitle(id, title) {
  await page.fill(".title-input", title);
  for (let i = 0; i < 40; i++) {
    if ((await trpcQuery("documents.getMeta", { id })).title === title) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`title of ${id} never became ${JSON.stringify(title)}`);
}

async function rowMenu(rowText, item) {
  const row = page.locator(".doc-row", { hasText: rowText });
  await row.hover();
  await row.locator('.row-action[title="More actions"]').click();
  await page.getByRole("menuitem", { name: item }).click();
}

async function createdPage(action) {
  const before = new URL(page.url()).pathname;
  await action();
  await page.waitForURL((url) => url.pathname !== before && url.pathname.startsWith("/d/"));
  await page.waitForSelector(".ProseMirror");
  return docIdOf(page.url());
}

try {
  await signUp(page, "Tess Template");
  const c = `Templates ${Date.now()}`;
  await createCollection(page, c);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // No templates yet: "+" makes a blank page exactly as before.
  await newDocument(page, c);
  await fillTitle(docIdOf(page.url()), "Meetings");

  await newDocument(page, c);
  const templateId = docIdOf(page.url());
  await fillTitle(templateId, "Sync {{date}}");
  await page.click(".ProseMirror");
  await page.keyboard.type("Notes by {{me}} with {{client}} about quokkaplan");
  await waitForBody(templateId, "{{client}}");

  const templateRow = page.locator(".doc-row", { hasText: "Sync {{date}}" });
  await templateRow.hover();
  const childId = await createdPage(() => templateRow.locator('.row-action[title="New sub-document"]').click());
  await fillTitle(childId, "Action items");
  await page.click(".ProseMirror");
  await page.keyboard.type("For {{parent}} quokkaplan");
  await waitForBody(childId, "{{parent}}");

  await rowMenu("Sync {{date}}", "Save as template");
  await page.locator(".dialog-form input").fill("Weekly sync");
  await page.getByRole("button", { name: "Save as template" }).click();
  await templateRow.locator(".template-badge").waitFor();

  await rowMenu("Meetings", "Default template…");
  await page.locator(".dialog-form select").selectOption({ label: "Weekly sync" });
  const saved = page.waitForResponse((r) => r.url().includes("templates.setDefault") && r.ok());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await saved;

  // "+" on the folder applies its default: the prompt is asked, then filled in.
  const meetingsRow = page.locator(".doc-row", { hasText: "Meetings" });
  await meetingsRow.hover();
  await meetingsRow.locator('.row-action[title="New sub-document"]').click();
  await page.getByLabel("client").fill("Acme");
  const fromDefault = await createdPage(() => page.getByRole("button", { name: "Create page" }).click());
  await page.waitForFunction(
    () => document.querySelector(".ProseMirror")?.textContent === "Notes by Tess Template with Acme about quokkaplan",
  );
  if ((await page.inputValue(".title-input")) !== `Sync ${today}`) {
    throw new Error(`title was ${await page.inputValue(".title-input")}`);
  }
  const subtree = (await trpcQuery("documents.tree", { collectionId: (await trpcQuery("documents.getMeta", { id: fromDefault })).collectionId }))
    .find((d) => d.title === "Meetings")
    .children.find((d) => d.id === fromDefault);
  const copiedTitles = subtree.children.map((d) => d.title);
  if (JSON.stringify(copiedTitles) !== JSON.stringify(["Action items"])) {
    throw new Error(`copied children were ${JSON.stringify(copiedTitles)}`);
  }
  const copiedBody = (await trpcQuery("documents.getMarkdown", { id: subtree.children[0].id })).markdown;
  if (copiedBody !== `For Sync ${today} quokkaplan`) throw new Error(`copied child body was ${JSON.stringify(copiedBody)}`);

  // The ▾ menu keeps Blank even where a default applies, in one request.
  const instantiateCalls = [];
  const recordInstantiate = (r) => {
    if (r.url().includes("templates.instantiate")) instantiateCalls.push(r.postData()?.includes('"dryRun":true') ? "dry run" : "create");
  };
  page.on("request", recordInstantiate);
  await meetingsRow.hover();
  await meetingsRow.locator('.row-action[title="New from template"]').click();
  await createdPage(() => page.getByRole("menuitem", { name: "Blank page" }).click());
  page.off("request", recordInstantiate);
  if ((await page.inputValue(".title-input")) !== "") throw new Error("blank page got a title");
  if ((await page.textContent(".ProseMirror"))?.trim()) throw new Error("blank page got a body");
  if (JSON.stringify(instantiateCalls) !== '["create"]') {
    throw new Error(`a blank page made these requests: ${JSON.stringify(instantiateCalls)}`);
  }

  // The Contents panel offers the template too, and its ▾ is reachable by keyboard.
  const collectionId = (await trpcQuery("documents.getMeta", { id: templateId })).collectionId;
  await page.goto(`${BASE}/c/${collectionId}`);
  await page.locator(".outline-panel").waitFor();
  await page.locator(".outline-bar .outline-new").focus();
  await page.keyboard.press("Tab");
  const focusedTitle = await page.evaluate(() => document.activeElement?.getAttribute("title"));
  if (focusedTitle !== "New from template") throw new Error(`Tab from New document reached ${focusedTitle}`);
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Weekly sync" }).focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("client").fill("Globex");
  await createdPage(() => page.getByRole("button", { name: "Create page" }).click());
  await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent?.includes("with Globex"));

  // The sidebar row menu asks which template to start from.
  const collectionRow = page.locator(".collection-row", { hasText: c });
  await collectionRow.hover();
  await collectionRow.locator('.row-action[title="More actions"]').click();
  await page.getByRole("menuitem", { name: "New from template…" }).click();
  const startFrom = page.getByLabel("Start from");
  if ((await startFrom.inputValue()) !== "") throw new Error(`Start from preselected ${await startFrom.inputValue()}`);
  await startFrom.selectOption({ label: "Weekly sync" });
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("client").fill("Initech");
  await createdPage(() => page.getByRole("button", { name: "Create page" }).click());
  await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent?.includes("with Initech"));

  // Search finds the pages made from the template, never the template itself.
  const hits = (await trpcQuery("documents.search", { query: "quokkaplan" })).map((h) => h.id);
  if (hits.includes(templateId) || hits.includes(childId)) throw new Error("search returned the template");
  if (!hits.includes(fromDefault)) throw new Error("search missed the page made from the template");

  // Changing a typed template's type asks first: it clears the defaults.
  const { workspaceId } = await trpcQuery("documents.getMeta", { id: templateId });
  const agenda = await trpcMutation("types.create", { workspaceId, name: "Agenda" });
  const retro = await trpcMutation("types.create", { workspaceId, name: "Retro" });
  const topic = await trpcMutation("types.createField", {
    workspaceId,
    typeId: agenda.id,
    key: "topic",
    label: "Topic",
    kind: "text",
  });
  await trpcMutation("templates.setDefaultType", { templateId, typeId: agenda.id });
  await trpcMutation("templates.setFieldDefault", {
    templateId,
    fieldId: topic.id,
    default: { kind: "value", value: "Roadmap" },
  });
  const weeklySync = async () => {
    const t = (await trpcQuery("templates.list", { workspaceId })).find((t) => t.id === templateId);
    return JSON.stringify({ typeId: t.typeId, defaults: t.defaults });
  };
  await page.goto(`${BASE}/d/${templateId}`);
  await page.getByRole("button", { name: "Type of new pages: Agenda" }).click();
  await page.getByRole("menuitem", { name: "Retro" }).click();
  const confirm = page.getByRole("dialog");
  const confirmBody = await confirm.locator(".dialog-body").textContent();
  if (confirmBody !== "New pages from this template get the Retro type, and its default values are cleared. Pages already made keep theirs.") {
    throw new Error(`type change confirm says: ${confirmBody}`);
  }
  await confirm.getByRole("button", { name: "Cancel" }).click();
  const kept = await weeklySync();
  if (kept !== JSON.stringify({ typeId: agenda.id, defaults: { [topic.id]: { kind: "value", value: "Roadmap" } } })) {
    throw new Error(`cancelling the type change still changed the template: ${kept}`);
  }
  await page.getByRole("button", { name: "Type of new pages: Agenda" }).click();
  await page.getByRole("menuitem", { name: "Retro" }).click();
  const changed = page.waitForResponse((r) => r.url().includes("templates.setDefaultType") && r.ok());
  await page.getByRole("dialog").getByRole("button", { name: "Change type" }).click();
  await changed;
  const after = await weeklySync();
  if (after !== JSON.stringify({ typeId: retro.id, defaults: {} })) throw new Error(`after the type change: ${after}`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "TEMPLATES PASS — folder default with prompt, sub-page copied, Blank kept, Contents menu, search skips templates, type change confirmed",
  );
} finally {
  await browser.close();
}
