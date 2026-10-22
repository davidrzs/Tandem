// Templates: save a page (with a sub-page) as a template, make it a folder's
// default, then "+" on that folder asks for the template's prompt and creates
// the expanded page and its sub-page; the ▾ menu still offers a blank page,
// the Contents panel offers the template, and search skips the template.
// Needs web+api (run.sh).
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

  // The ▾ menu keeps Blank even where a default applies.
  await meetingsRow.hover();
  await meetingsRow.locator('.row-action[title="New from template"]').click();
  await createdPage(() => page.getByRole("menuitem", { name: "Blank page" }).click());
  if ((await page.inputValue(".title-input")) !== "") throw new Error("blank page got a title");
  if ((await page.textContent(".ProseMirror"))?.trim()) throw new Error("blank page got a body");

  // The Contents panel offers the template too.
  const collectionId = (await trpcQuery("documents.getMeta", { id: templateId })).collectionId;
  await page.goto(`${BASE}/c/${collectionId}`);
  await page.locator(".outline-panel").waitFor();
  await page.locator('.outline-bar [title="New from template"]').click();
  await page.getByRole("menuitem", { name: "Weekly sync" }).click();
  await page.getByLabel("client").fill("Globex");
  await createdPage(() => page.getByRole("button", { name: "Create page" }).click());
  await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent?.includes("with Globex"));

  // Search finds the pages made from the template, never the template itself.
  const hits = (await trpcQuery("documents.search", { query: "quokkaplan" })).map((h) => h.id);
  if (hits.includes(templateId) || hits.includes(childId)) throw new Error("search returned the template");
  if (!hits.includes(fromDefault)) throw new Error("search missed the page made from the template");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TEMPLATES PASS — folder default with prompt, sub-page copied, Blank kept, Contents menu, search skips templates");
} finally {
  await browser.close();
}
