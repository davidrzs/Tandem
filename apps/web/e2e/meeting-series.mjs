// Meeting series: a project's Meetings page (from the starter Project
// template) reads as one long page of its meetings, newest first, each with
// its body; a live section inside a meeting shows as a link, not resolved.
// The series section stays whole while typing: typing with it selected
// writes after it, and Backspace beside it selects it. Needs web+api (run.sh).
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

const SECTION = "<!-- live-section: meeting_series -->";
const markdownLines = async (id) =>
  (await trpcQuery("documents.getMarkdown", { id })).markdown.split("\n").filter((line) => line.trim() !== "");
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  await signUp(page, "Mo Meetings");
  const c = `Series ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const { workspaceId, collectionId } = await trpcQuery("documents.getMeta", { id: docIdOf(page.url()) });
  await trpcMutation("templates.addStarterKit", { workspaceId, collectionId });
  const templates = await trpcQuery("templates.list", { workspaceId });
  const meetingType = templates.find((t) => t.name === "Meeting").typeId;
  const project = (
    await trpcMutation("templates.instantiate", {
      templateId: templates.find((t) => t.name === "Project").id,
      collectionId,
    })
  ).documentId;
  const meetings = (await trpcQuery("documents.tree", { collectionId })).find((d) => d.id === project).children[0].id;
  const seeded = await markdownLines(meetings);
  if (!sameList(seeded, [SECTION])) throw new Error(`the project's Meetings page reads ${JSON.stringify(seeded)}`);

  const ann = (await trpcMutation("documents.create", { collectionId, title: "Ann Attendee" })).id;
  const meeting = async (title, date, markdown, attendees = []) => {
    const { id } = await trpcMutation("documents.create", { collectionId, parentDocumentId: meetings, title, markdown });
    await trpcMutation("documents.setType", { id, typeId: meetingType });
    await trpcMutation("documents.setProperties", { id, set: { date, attendees } });
    return id;
  };
  const sep = await meeting("Sync September", "2026-09-03", "Sep body\n\n<!-- live-section: open_from_last_time -->");
  const oct = await meeting("Sync October", "2026-10-01", "Oct body", [ann]);
  await meeting("Sync August", "2026-08-06", "Aug body");
  const NEWEST_FIRST = ["Sync October", "Sync September", "Sync August"];
  await eventually(
    () => trpcQuery("documents.meetingSeries", { id: meetings, limit: 10 }),
    (s) => sameList(s.entries.map((e) => [e.title, e.attendees.length]), NEWEST_FIRST.map((t, i) => [t, i === 0 ? 1 : 0])),
    "the series query sees all three dated meetings",
  );

  await page.goto(`${BASE}/d/${meetings}`);
  const series = page.locator('.ProseMirror .live-section[data-live-section="meeting_series"]');
  const entries = series.locator(".series-entry");
  await eventually(() => entries.count(), (n) => n === 3, "three meetings in the series");
  const titles = await entries.locator(".series-entry-head h3").allTextContents();
  if (!sameList(titles, NEWEST_FIRST)) {
    throw new Error(`series order reads ${JSON.stringify(titles)}`);
  }
  const bodies = await entries.locator(".ProseMirror").allTextContents();
  if (!bodies[0].includes("Oct body") || !bodies[1].includes("Sep body") || !bodies[2].includes("Aug body")) {
    throw new Error(`series bodies read ${JSON.stringify(bodies)}`);
  }
  const octHead = await entries.nth(0).locator(".series-entry-head").textContent();
  if (!octHead.includes("Oct 1, 2026") || !octHead.includes("Ann Attendee") || !octHead.includes("Open")) {
    throw new Error(`October's heading row reads "${octHead}"`);
  }
  const openHref = await entries.nth(0).locator("a.series-entry-open").getAttribute("href");
  if (openHref !== `/d/${oct}`) throw new Error(`October's Open link goes to ${openHref}`);
  const nested = entries.nth(1).locator(".live-section-link a");
  if ((await nested.textContent()) !== "Open from last time" || (await nested.getAttribute("href")) !== `/d/${sep}`) {
    throw new Error("September's own live section is not a link to September");
  }
  if ((await series.locator(".live-section").count()) !== 0) {
    throw new Error("a live section inside a meeting was resolved inside the series");
  }

  await series.locator(".live-section-head").click();
  await series.and(page.locator(".selected")).waitFor();
  await page.waitForTimeout(500);
  if (await page.locator(".bubble-group").isVisible()) throw new Error("the format bubble shows over the selected series");
  await page.keyboard.type("x");
  await eventually(
    () => markdownLines(meetings),
    (lines) => sameList(lines, [SECTION, "x"]),
    "typing with the series selected writes a paragraph after it",
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await series.and(page.locator(".selected")).waitFor();
  await page.waitForTimeout(1000);
  const after = await markdownLines(meetings);
  if (!sameList(after, [SECTION, "x"])) throw new Error(`Backspace beside the series changed the page: ${JSON.stringify(after)}`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "MEETING SERIES PASS — seeded on the project's Meetings page; three meetings newest first with bodies, date, attendees and Open; nested section a link; section stays whole while typing",
  );
} catch (error) {
  await page.screenshot({ path: "/tmp/meeting-series-fail.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
