// Layout and accessibility of the typed-page UI: at 800px a long type name
// leaves the breadcrumbs on the doc bar and the Contents table keeps page
// names readable, titling cut-off values; the quiet text of the panels,
// Contents, live sections and Home's due list reads at 4.5:1 in both themes;
// keyboard focus on a panel field shows the accent ring; a sidebar template
// row's accessible name says it is a template.
// Needs web+api (run.sh).
import { chromium } from "playwright";
import { BASE, signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

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

/** WCAG contrast of `el`'s text against the backgrounds painted under it. */
function contrastOf(el) {
  const parse = (css) => {
    const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
    return { r, g, b, a };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  const layers = [];
  for (let node = el; node; node = node.parentElement) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg.a > 0) layers.unshift(bg);
    if (bg.a === 1) break;
  }
  const bg = layers.reduce((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
  const fg = over(parse(getComputedStyle(el).color), bg);
  const lum = ({ r, g, b }) =>
    [r, g, b]
      .map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

try {
  await signUp(page, "Ada Access");
  const c = "Lab";
  await createCollection(page, c);
  await newDocument(page, c);
  const parentId = new URL(page.url()).pathname.split("/").pop();
  const { workspaceId, collectionId } = await trpcQuery("documents.getMeta", { id: parentId });
  await trpcMutation("documents.update", { id: parentId, title: "Research" });

  const typeName = "Research initiative with a deliberately long type name";
  const type = await trpcMutation("types.create", { workspaceId, name: typeName });
  const review = await trpcMutation("documents.create", {
    collectionId,
    parentDocumentId: parentId,
    title: "Quarterly research review",
  });
  await trpcMutation("documents.setType", { id: review.id, typeId: type.id });

  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(`${BASE}/d/${review.id}`);
  const typeButton = page.getByRole("button", { name: `Page type: ${typeName}` });
  await typeButton.waitFor();
  const typeTitle = await typeButton.getAttribute("title");
  if (typeTitle !== `Page type: ${typeName}`) throw new Error(`the type button's title is ${typeTitle}`);
  const typeWidth = (await typeButton.boundingBox()).width;
  if (typeWidth > 160) throw new Error(`the type button is ${typeWidth}px wide at 800px`);
  const crumbsWidth = (await page.locator(".doc-bar .breadcrumbs").boundingBox()).width;
  if (crumbsWidth < 150) throw new Error(`the breadcrumbs are ${crumbsWidth}px wide beside a long type name`);
  const crumb = page.locator(".doc-bar .crumb-current", { hasText: "Quarterly" });
  const crumbWidth = (await crumb.boundingBox())?.width ?? 0;
  if (crumbWidth < 60) throw new Error(`the current-page crumb is ${crumbWidth}px wide beside a long type name`);

  const field = (key, kind, options) =>
    trpcMutation("types.createField", {
      workspaceId,
      typeId: type.id,
      key,
      label: key[0].toUpperCase() + key.slice(1),
      kind,
      options,
    });
  await field("status", "select", ["Planned", "Blocked on an external dependency"]);
  await field("owners", "multi_select", ["Alice Anderson", "Bartholomew Bunting", "Dmitri Dostoevsky-Smith"]);
  await field("summary", "text");
  const sibling = await trpcMutation("documents.create", {
    collectionId,
    parentDocumentId: parentId,
    title: "Second research child",
  });
  await trpcMutation("documents.setType", { id: sibling.id, typeId: type.id });
  await trpcMutation("documents.setProperties", {
    id: review.id,
    set: {
      status: "Blocked on an external dependency",
      owners: ["Alice Anderson", "Bartholomew Bunting", "Dmitri Dostoevsky-Smith"],
      summary: "Brief",
    },
  });
  await trpcMutation("documents.setProperties", { id: sibling.id, set: { status: "Planned" } });

  await page.goto(`${BASE}/d/${parentId}`);
  const contents = page.locator(".sub-pages .outline-table");
  await contents.getByRole("columnheader", { name: "Owners" }).waitFor();
  const nameWidth = (await contents.getByRole("columnheader", { name: "Name" }).boundingBox()).width;
  if (nameWidth < 200) throw new Error(`the Name column is ${nameWidth}px wide beside three property columns`);
  const reviewRow = contents.locator("tbody tr", { hasText: "Quarterly research review" });
  const nameCut = await reviewRow.locator(".outline-link").evaluate((a) => a.scrollWidth > a.clientWidth);
  if (nameCut) throw new Error("the Contents table cuts off “Quarterly research review”");
  const reviewCells = await reviewRow.locator("td.outline-field").evaluateAll((tds) =>
    tds.map((td) => ({ title: td.getAttribute("title"), cut: td.scrollWidth > td.clientWidth })),
  );
  const expectedCells = [
    { title: "Blocked on an external dependency", cut: true },
    { title: "Alice Anderson, Bartholomew Bunting, Dmitri Dostoevsky-Smith", cut: true },
    { title: "Brief", cut: false },
  ];
  if (JSON.stringify(reviewCells) !== JSON.stringify(expectedCells)) {
    throw new Error(`the review's property cells: ${JSON.stringify(reviewCells)}`);
  }
  const blank = contents.locator("tbody tr", { hasText: "Second research child" }).locator("td.outline-field").nth(1);
  if ((await blank.getAttribute("title")) !== null) throw new Error("an empty property cell has a title");

  await trpcMutation("templates.addStarterKit", { workspaceId, collectionId });
  const templates = await trpcQuery("templates.list", { workspaceId });
  const templateId = (name) => templates.find((t) => t.name === name).id;
  const project = (await trpcMutation("templates.instantiate", { templateId: templateId("Project"), collectionId }))
    .documentId;
  const meetings = (await trpcQuery("documents.tree", { collectionId })).find((d) => d.id === project).children[0].id;
  const kickoff = await trpcMutation("documents.create", {
    collectionId,
    parentDocumentId: meetings,
    title: "Kickoff",
    markdown: "## Actions\n\n- [ ] Bring the slides",
  });
  await trpcMutation("documents.setType", { id: kickoff.id, typeId: templates.find((t) => t.name === "Meeting").typeId });
  const secondMeeting = (await trpcMutation("templates.instantiate", {
    templateId: templateId("Meeting"),
    collectionId,
    parentDocumentId: meetings,
  })).documentId;
  for (let i = 0; ; i++) {
    const carried = await trpcQuery("documents.liveSection", { id: secondMeeting, query: "open_from_last_time" });
    if (carried.tasks.length === 1) break;
    if (i === 80) throw new Error(`the second meeting never carried the task: ${JSON.stringify(carried)}`);
    await page.waitForTimeout(250);
  }
  const yesterday = new Date(Date.now() - 86_400_000);
  const day = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  await trpcMutation("documents.setProperties", { id: project, set: { next_review: day } });

  const lowContrast = [];
  const checkContrast = async (theme, selector) => {
    const target = page.locator(selector).first();
    await target.waitFor();
    const ratio = await target.evaluate(contrastOf);
    if (ratio < 4.5) lowContrast.push(`${theme} ${selector} ${ratio}:1`);
  };
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${BASE}/d/${sibling.id}`);
    await checkContrast(theme, ".props-summary-text");
    await page.locator(".props-summary").click();
    for (const s of [".props-label", ".props-add", ".prop-add-option"]) await checkContrast(theme, s);

    await page.goto(`${BASE}/d/${templateId("Meeting")}`);
    const defaults = '.props-panel[aria-label="Template defaults"]';
    for (const s of [`${defaults} .props-label`, `${defaults} .props-summary-text`]) await checkContrast(theme, s);

    await page.goto(`${BASE}/d/${parentId}`);
    await checkContrast(theme, ".outline-table th.outline-col-field button");

    await page.goto(`${BASE}/d/${secondMeeting}`);
    await page.locator(".live-section-from").first().waitFor();
    for (const s of [".doc-origin", ".live-section-source", ".live-section-from", ".live-section h4", ".live-section-empty"]) {
      await checkContrast(theme, s);
    }

    await page.goto(`${BASE}/`);
    await checkContrast(theme, ".due-list .due-field");
  }
  if (lowContrast.length) throw new Error(`text below 4.5:1: ${lowContrast.join(", ")}`);
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto(`${BASE}/d/${sibling.id}`);
  await page.locator(".props-summary").click();
  await page.getByLabel("Status", { exact: true }).focus();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    return {
      label: el.getAttribute("aria-label"),
      className: el.className,
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
    };
  });
  const expectedFocus = { label: "Add Owners", className: "prop-input prop-add-option", outline: "solid 2px rgb(13, 115, 100)" };
  if (JSON.stringify(focused) !== JSON.stringify(expectedFocus)) {
    throw new Error(`a keyboard-focused panel field shows ${JSON.stringify(focused)}`);
  }

  const sync = await trpcMutation("documents.create", { collectionId, title: "Client sync {{date}}" });
  await trpcMutation("templates.templatize", { documentId: sync.id, name: "Client sync" });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto(`${BASE}/d/${sync.id}`);
  const templateRow = page.locator(`.tree .doc-row[href="/d/${sync.id}"]`);
  await templateRow.locator(".template-badge").waitFor();
  const templateName = await templateRow.getAttribute("aria-label");
  if (templateName !== "Client sync {{date}} Template") throw new Error(`the template row is named ${templateName}`);
  const pageName = await page.locator(`.tree .doc-row[href="/d/${parentId}"]`).getAttribute("aria-label");
  if (pageName !== "Research") throw new Error(`a plain page row is named ${pageName}`);

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "A11Y-VISUAL PASS — a long type name keeps the breadcrumbs, Contents keeps names and titles cut values, quiet text reads at 4.5:1 in both themes, panel fields show a focus ring, template rows say they are templates",
  );
} finally {
  await browser.close();
}
