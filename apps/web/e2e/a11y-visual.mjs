// Layout and accessibility of the typed-page UI at 800px: a long type name
// leaves the breadcrumbs on the doc bar.
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

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("A11Y-VISUAL PASS — a long type name keeps the breadcrumbs");
} finally {
  await browser.close();
}
