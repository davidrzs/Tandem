// Typed templates and the meeting flow: the owner adds the starter types from
// the Type menu, creates a Project from its template (its Meetings sub-page
// comes along), and "+" under Meetings makes a Meeting dated today that
// copies the previous meeting's attendees. The Meeting template's page shows
// its defaults, and an owner changes one there. Needs web+api (run.sh).
import { chromium } from "playwright";
import { BASE, signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const docIdOf = (url) => new URL(url).pathname.split("/").pop();

async function trpcQuery(path, input) {
  const res = await page.request.get(`${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`);
  if (!res.ok()) throw new Error(`${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).result.data;
}

async function trpcMutation(path, input) {
  const res = await page.request.post(`${BASE}/trpc/${path}`, { data: input });
  if (!res.ok()) throw new Error(`${path} failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).result.data;
}

async function createdPage(action) {
  const before = new URL(page.url()).pathname;
  await action();
  await page.waitForURL((url) => url.pathname !== before && url.pathname.startsWith("/d/"));
  await page.waitForSelector(".ProseMirror");
  return docIdOf(page.url());
}

/** "+" on the sidebar row of the Meetings page (the template has one too). */
async function newUnder(id) {
  const row = page.locator(`.doc-row[href="/d/${id}"]`);
  await row.hover();
  return createdPage(() => row.locator('.row-action[title="New sub-document"]').click());
}

const assertEqual = (actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

try {
  await signUp(page, "Mia Meeting");
  const c = `Series ${Date.now()}`;
  await createCollection(page, c);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  await newDocument(page, c);
  const scratch = docIdOf(page.url());
  const { workspaceId, collectionId } = await trpcQuery("documents.getMeta", { id: scratch });
  await page.getByRole("button", { name: "Page type: none" }).click();
  const seeded = page.waitForResponse((r) => r.url().includes("templates.addStarterKit") && r.ok());
  await page.getByRole("menuitem", { name: "Add starter types" }).click();
  await seeded;
  await page.getByText("Added the Meeting, Project, Person types and the Meeting, Project, Person templates.").waitFor();
  const templates = await trpcQuery("templates.list", { workspaceId });
  const templateId = (name) => templates.find((t) => t.name === name).id;

  // A Project from its template: typed, with its Meetings sub-page.
  const collectionRow = page.locator(".collection-row", { hasText: c });
  await collectionRow.hover();
  await collectionRow.locator('.row-action[title="New from template"]').click();
  const project = await createdPage(() => page.getByRole("menuitem", { name: "Project" }).click());
  await page.locator(".props-panel .props-type", { hasText: "Project" }).waitFor();
  const projectNode = (await trpcQuery("documents.tree", { collectionId })).find((d) => d.id === project);
  assertEqual(
    projectNode.children.map((d) => [d.title, d.defaultTemplateId]),
    [["Meetings", templateId("Meeting")]],
    "the project's sub-pages",
  );
  const meetings = projectNode.children[0].id;

  const ann = (await trpcMutation("templates.instantiate", {
    templateId: templateId("Person"),
    collectionId,
    variables: { title: "Ann" },
  })).documentId;
  const bob = (await trpcMutation("templates.instantiate", {
    templateId: templateId("Person"),
    collectionId,
    variables: { title: "Bob" },
  })).documentId;

  // "+" under Meetings: the Meeting template applies without asking.
  await page.locator(".outline-link", { hasText: "Meetings" }).click();
  await page.waitForURL((url) => url.pathname === `/d/${meetings}`);
  const first = await newUnder(meetings);
  assertEqual((await trpcQuery("documents.getMeta", { id: first })).title, `Meeting ${today}`, "the first meeting's title");
  await page.waitForFunction((t) => document.querySelector(".title-input")?.value === t, `Meeting ${today}`);
  const firstView = await trpcQuery("documents.properties", { id: first });
  assertEqual(firstView.type?.name, "Meeting", "the first meeting's type");
  const key = (view) => Object.fromEntries(view.fields.filter((f) => f.id in view.values).map((f) => [f.key, view.values[f.id]]));
  assertEqual(key(firstView), { date: today, status: "Planned" }, "the first meeting's values");
  await trpcMutation("documents.setProperties", { id: first, set: { attendees: [ann, bob] } });

  await page.goto(`${BASE}/d/${meetings}`);
  await page.waitForSelector(".ProseMirror");
  const second = await newUnder(meetings);
  await page.locator(".props-summary-text", { hasText: "Attendees: Ann, Bob" }).waitFor();
  const secondView = await trpcQuery("documents.properties", { id: second });
  assertEqual(
    key(secondView),
    {
      date: today,
      attendees: [
        { id: ann, title: "Ann" },
        { id: bob, title: "Bob" },
      ],
      status: "Planned",
    },
    "the second meeting's values",
  );

  // The Meeting template's page shows its defaults; the owner changes one.
  await page.goto(`${BASE}/d/${templateId("Meeting")}`);
  const panel = page.locator('.props-panel[aria-label="Template defaults"]');
  await panel.getByText("Pages made from this template are Meeting pages.").waitFor();
  assertEqual(await panel.getByLabel("Default for Date").inputValue(), "today", "the date default");
  assertEqual(
    await panel.getByLabel("Default for Attendees").inputValue(),
    "from_previous_sibling",
    "the attendees default",
  );
  const saved = page.waitForResponse((r) => r.url().includes("templates.setFieldDefault") && r.ok());
  await panel.getByLabel("Status default value").selectOption({ label: "Done" });
  await saved;
  const status = (await trpcQuery("types.fields", { workspaceId })).find(
    (f) => f.key === "status" && f.typeName === "Meeting",
  );
  const done = status.options.find((o) => o.label === "Done").id;
  const updated = (await trpcQuery("templates.list", { workspaceId })).find((t) => t.name === "Meeting");
  assertEqual(updated.defaults[status.id], { kind: "value", value: done }, "the changed status default");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "MEETING PASS — starter types from the Type menu, Project with Meetings, + under Meetings dated today with the previous attendees, template defaults edited",
  );
} finally {
  await browser.close();
}
