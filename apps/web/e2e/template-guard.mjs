// Template guard: deleting a live section on the Meeting template's page
// toasts "This template lost a live section" with Undo, which brings it back;
// the same deletion on a page made from it stays quiet. Once the template is
// saved without the section, a dry run of create_from_template's tRPC twin
// warns that it has fewer live sections than its last page. Needs web+api.
import { chromium } from "playwright";
import { BASE, signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const docIdOf = (url) => new URL(url).pathname.split("/").pop();
const LOST = "This template lost a live section";

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

async function eventually(read, ok, what) {
  for (let i = 0; i < 60; i++) {
    const value = await read();
    if (ok(value)) return value;
    await page.waitForTimeout(250);
  }
  throw new Error(`never happened: ${what}`);
}

async function openPage(id) {
  await page.goto(`${BASE}/d/${id}`);
  await page.waitForSelector(".ProseMirror");
}

async function deleteSection(query) {
  const section = page.locator(`.live-section[data-live-section="${query}"]`);
  await page.locator(".ProseMirror h2", { hasText: "Agenda" }).click();
  await section.locator(".live-section-head").click();
  await page.locator(`.live-section.selected[data-live-section="${query}"]`).waitFor();
  await page.keyboard.press("Backspace");
  await section.waitFor({ state: "detached" });
}

try {
  await signUp(page, "Gus Guard");
  const c = `Guard ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const { workspaceId, collectionId } = await trpcQuery("documents.getMeta", { id: docIdOf(page.url()) });
  await trpcMutation("templates.addStarterKit", { workspaceId, collectionId });
  const meeting = (await trpcQuery("templates.list", { workspaceId })).find((t) => t.name === "Meeting").id;
  const made = (await trpcMutation("templates.instantiate", { templateId: meeting, collectionId })).documentId;

  await openPage(made);
  await deleteSection("since_last_meeting");
  await page.waitForTimeout(500);
  if ((await page.locator(".toast", { hasText: LOST }).count()) !== 0) {
    throw new Error("an ordinary page warned about losing a live section");
  }

  await openPage(meeting);
  await deleteSection("open_from_last_time");
  const toast = page.locator(".toast", { hasText: LOST });
  await toast.waitFor();
  await toast.getByRole("button", { name: "Undo" }).click();
  await page.locator('.live-section[data-live-section="open_from_last_time"]').waitFor();

  await deleteSection("open_from_last_time");
  await eventually(
    async () => (await trpcQuery("documents.getMarkdown", { id: meeting })).markdown,
    (md) => !md.includes("open_from_last_time"),
    "the template saved without the section",
  );
  const plan = await trpcMutation("templates.instantiate", { templateId: meeting, collectionId, dryRun: true });
  const [lost, changed] = plan.template.warnings;
  if (!lost?.startsWith("It has 1 live section(s) where the page made from it at ") || !lost.endsWith(" had 2: a live section may have been deleted or turned into plain text.")) {
    throw new Error(`no lost-section warning: ${JSON.stringify(plan.template.warnings)}`);
  }
  if (!plan.template.changedSinceLastUse || !changed?.startsWith("It changed after its last use at ")) {
    throw new Error(`no changed warning: ${JSON.stringify(plan.template)}`);
  }
  if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("template-guard: ok");
} catch (e) {
  await page.screenshot({ path: "/tmp/template-guard-fail.png", fullPage: true });
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
