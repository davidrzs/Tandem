// Live sections and Home's due list: two meetings in a project's series, an
// open task typed in the first shows in the second's "Open from last time";
// ticking it in the first takes it out once saved. "Open tasks under this
// page" goes in through the slash menu. Home lists a project whose review
// date has passed. Needs web+api (run.sh).
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

/** Poll until `check(value)` holds; the collab store saves after a debounce. */
async function eventually(read, check, what) {
  const deadline = Date.now() + 20_000;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (check(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
}

async function openPage(id) {
  await page.goto(`${BASE}/d/${id}`);
  await page.waitForSelector(".ProseMirror");
}

/** Whether the editor's own selection (TipTap keeps the editor on its DOM
 * node) is a caret at the end of the heading reading `text`. The DOM caret
 * alone is not enough: ProseMirror reads it back asynchronously. */
const caretAtEndOf = (text) =>
  page.evaluate((text) => {
    const { selection } = document.querySelector(".ProseMirror").editor.state;
    const { $from, empty } = selection;
    return empty && $from.parent.type.name === "heading" && $from.parent.textContent === text && $from.parentOffset === $from.parent.content.size;
  }, text);

/** Start a new line after the heading `text`. Live sections above it can
 * still be growing when it is clicked, so the click is retried until the
 * caret really sits at the heading's end. */
async function lineAfter(text) {
  const heading = page.locator(".ProseMirror h2", { hasText: text });
  await heading.waitFor();
  const deadline = Date.now() + 20_000;
  for (;;) {
    await heading.click();
    await page.keyboard.press("End");
    if (await caretAtEndOf(text)) break;
    if (Date.now() > deadline) throw new Error(`could not put the caret at the end of "${text}"`);
    await page.waitForTimeout(250);
  }
  await page.keyboard.press("Enter");
}

const fromLastTime = (id) => trpcQuery("documents.liveSection", { id, query: "open_from_last_time" });
const SLIDES = "Bring the slides";

try {
  await signUp(page, "Lev Live");
  const c = `Live ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const { workspaceId, collectionId } = await trpcQuery("documents.getMeta", { id: docIdOf(page.url()) });
  await trpcMutation("templates.addStarterKit", { workspaceId, collectionId });
  const templates = await trpcQuery("templates.list", { workspaceId });
  const templateId = (name) => templates.find((t) => t.name === name).id;

  const project = (await trpcMutation("templates.instantiate", { templateId: templateId("Project"), collectionId }))
    .documentId;
  const meetings = (await trpcQuery("documents.tree", { collectionId })).find((d) => d.id === project).children[0].id;
  const meeting = async () =>
    (await trpcMutation("templates.instantiate", {
      templateId: templateId("Meeting"),
      collectionId,
      parentDocumentId: meetings,
    })).documentId;
  const first = await meeting();
  const second = await meeting();

  await openPage(first);
  await page.locator('.live-section[data-live-section="open_from_last_time"]').getByText(
    "No earlier page of this type sits beside this one.",
  ).waitFor();
  await lineAfter("Actions");
  await page.keyboard.type(`- [ ] ${SLIDES}`);
  await page.waitForSelector('.ProseMirror li[data-checked="false"]');
  await eventually(
    () => fromLastTime(second),
    (s) => s.tasks.some((t) => t.text === SLIDES),
    "the second meeting's open-from-last-time after the first is saved",
  );

  await openPage(second);
  const section = page.locator('.live-section[data-live-section="open_from_last_time"]');
  await section.locator(".live-section-tasks li", { hasText: SLIDES }).waitFor();
  await page.locator('.live-section[data-live-section="since_last_meeting"] h4', { hasText: "Tasks added" }).waitFor();

  await openPage(project);
  await lineAfter("Overview");
  await page.keyboard.type("/under");
  await page.locator(".slash-item.selected", { hasText: "Open tasks under this page" }).waitFor();
  await page.keyboard.press("Enter");
  const inserted = page.locator('.live-section[data-live-section="open_tasks_here"]');
  await inserted.locator(".live-section-tasks li", { hasText: SLIDES }).first().waitFor();
  const SECTION = "<!-- live-section: open_tasks_here -->";
  const order = await eventually(
    async () =>
      (await trpcQuery("documents.getMarkdown", { id: project })).markdown
        .split("\n")
        .filter((line) => line.trim() !== ""),
    (lines) => lines.filter((line) => line === SECTION).length === 2,
    "the inserted section saved as a comment beside the template's own",
  );
  if (JSON.stringify(order) !== JSON.stringify(["## Overview", SECTION, "## Next steps", SECTION])) {
    throw new Error(`the inserted section is not right after Overview: ${JSON.stringify(order)}`);
  }

  await openPage(first);
  await page.locator('.ProseMirror li[data-checked="false"]', { hasText: SLIDES }).locator('input[type="checkbox"]').click();
  await page.waitForSelector('.ProseMirror li[data-checked="true"]');
  await eventually(
    () => fromLastTime(second),
    (s) => s.tasks.length === 0,
    "the ticked task leaves the second meeting's section after save",
  );
  await openPage(second);
  await section.getByText("Everything from last time is done.").waitFor();
  if ((await section.locator(".live-section-tasks li").count()) !== 0) {
    throw new Error("the ticked task still shows in the second meeting");
  }

  const yesterday = new Date(Date.now() - 86_400_000);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  await trpcMutation("documents.setProperties", { id: project, set: { next_review: day } });
  await page.goto(`${BASE}/`);
  const due = page.locator(".due-list li.overdue", { hasText: "New project" });
  await due.waitFor();
  const dueText = await due.textContent();
  const shownDay = yesterday.toLocaleDateString("en-US", { dateStyle: "medium" });
  if (!dueText.includes(`Overdue · ${shownDay}`) || !dueText.includes("Next review")) {
    throw new Error(`Home's due row reads "${dueText}"`);
  }

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "LIVE SECTIONS PASS — open task carried to the next meeting, gone once ticked; slash-inserted section; overdue review on Home",
  );
} catch (error) {
  await page.screenshot({ path: "/tmp/p7-live-fail.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
