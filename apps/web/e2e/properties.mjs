// Properties with a page open: a value set through the API reaches the live
// doc and survives the editor's undo, which only reverts body typing.
// Needs web+api (run.sh).
import { chromium } from "playwright";
import { BASE, signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
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

async function waitForMarkdown(id, test, what) {
  for (let i = 0; i < 40; i++) {
    const { markdown } = await trpcQuery("documents.getMarkdown", { id });
    if (test(markdown)) return markdown;
    await page.waitForTimeout(250);
  }
  throw new Error(`body of ${id} never ${what}`);
}

try {
  await signUp(page, "Pat Properties");
  const c = `Properties ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const id = new URL(page.url()).pathname.split("/").pop();
  const { workspaceId } = await trpcQuery("documents.getMeta", { id });

  const type = await trpcMutation("types.create", { workspaceId, name: "Meeting" });
  const status = await trpcMutation("types.createField", {
    workspaceId,
    typeId: type.id,
    key: "status",
    kind: "select",
    options: ["Open", "Done"],
  });
  await trpcMutation("documents.setType", { id, typeId: type.id });

  await page.click(".ProseMirror");
  await page.keyboard.type("Agenda for today.");
  await waitForMarkdown(id, (md) => md.includes("Agenda for today."), "saved the typed text");

  const set = await trpcMutation("documents.setProperties", { id, set: { status: "done" } });
  if (set.values[status.id] !== "Done") throw new Error(`set returned ${JSON.stringify(set.values)}`);

  await page.click(".ProseMirror");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => !document.querySelector(".ProseMirror")?.textContent?.includes("Agenda"));
  await waitForMarkdown(id, (md) => !md.includes("Agenda"), "dropped the undone text");

  const after = await trpcQuery("documents.properties", { id });
  if (after.values[status.id] !== "Done") {
    throw new Error(`undo in the body reverted the property: ${JSON.stringify(after.values)}`);
  }

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("PROPERTIES PASS — a live property set survives body undo");
} finally {
  await browser.close();
}
