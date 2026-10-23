// Layout and accessibility of the typed-page UI at 800px: a long type name
// leaves the breadcrumbs on the doc bar, and the Contents table keeps page
// names readable and shows a cut-off value in full on hover.
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

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("A11Y-VISUAL PASS — a long type name keeps the breadcrumbs, Contents keeps names and titles cut values");
} finally {
  await browser.close();
}
