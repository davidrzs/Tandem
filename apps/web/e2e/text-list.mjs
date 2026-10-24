// A text list in the properties panel: changing a field from text to a text
// list while the page is open splits its value into chips written as the
// System, Enter adds a value, Backspace in the empty input removes the last
// one, a chip's button removes it, and changing the field back to text joins
// what is left. Needs web+api (run.sh).
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

async function waitFor(read, test, what) {
  let last;
  for (let i = 0; i < 40; i++) {
    last = await read();
    if (test(last)) return last;
    await page.waitForTimeout(250);
  }
  throw new Error(`${what}; last saw ${JSON.stringify(last)}`);
}

const same = (want) => (got) => JSON.stringify(got) === JSON.stringify(want);

try {
  await signUp(page, "Tess Textlist");
  const c = `Text lists ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const docId = new URL(page.url()).pathname.split("/").pop();
  const { workspaceId } = await trpcQuery("documents.getMeta", { id: docId });
  const person = await trpcMutation("types.create", { workspaceId, name: "Person" });
  const aliases = await trpcMutation("types.createField", {
    workspaceId,
    typeId: person.id,
    key: "aliases",
    label: "Aliases",
    kind: "text",
  });
  await page.reload();
  await page.waitForSelector(".ProseMirror");
  await page.getByRole("button", { name: "Page type: none" }).click();
  await page.getByRole("menuitem", { name: "Person" }).click();
  await page.locator(".props-summary[aria-expanded=true]").waitFor();
  const text = page.getByLabel("Aliases", { exact: true });
  await text.fill("Fabrizio, Fabrizo");
  await text.press("Enter");
  const values = () => trpcQuery("documents.properties", { id: docId }).then((v) => v.values[aliases.id]);
  await waitFor(values, same("Fabrizio, Fabrizo"), "the text value never saved");

  await trpcMutation("types.updateField", { id: aliases.id, kind: "text_list" });
  const row = page.locator('.props-row[data-field="aliases"]');
  const chips = () => row.locator(".prop-chip").evaluateAll((els) => els.map((el) => el.firstChild.textContent));
  await waitFor(chips, same(["Fabrizio", "Fabrizo"]), "the open page never showed the split value as chips");
  const marks = await row.locator(".prop-chip .prop-ai").evaluateAll((els) => els.map((el) => el.dataset.aiLabel));
  if (!same(["System", "System"])(marks)) throw new Error(`the split values are marked ${JSON.stringify(marks)}`);

  const add = page.getByLabel("Add Aliases", { exact: true });
  await add.focus();
  await page.keyboard.type("Fab");
  await page.keyboard.press("Enter");
  await waitFor(chips, same(["Fabrizio", "Fabrizo", "Fab"]), "Enter never added the typed value");
  if ((await add.inputValue()) !== "") throw new Error(`the input kept ${await add.inputValue()} after Enter`);
  if (!(await add.evaluate((el) => el === document.activeElement))) throw new Error("Enter moved focus out of the input");
  await page.keyboard.press("Backspace");
  await waitFor(chips, same(["Fabrizio", "Fabrizo"]), "Backspace in the empty input never removed the last value");
  await row.getByRole("button", { name: "Remove Fabrizo" }).click();
  await waitFor(chips, same(["Fabrizio"]), "the chip's remove button never removed it");
  await waitFor(values, same(["Fabrizio"]), "the list never saved");

  await page.reload();
  const summary = page.locator(".props-summary");
  await waitFor(() => summary.textContent(), (t) => t?.endsWith("Aliases: Fabrizio"), "the summary never read the list");
  await summary.click();
  await waitFor(chips, same(["Fabrizio"]), "the list is gone after a reload");

  await trpcMutation("types.updateField", { id: aliases.id, kind: "text" });
  const joined = () => row.locator("input:not([aria-label])").inputValue();
  await waitFor(joined, same("Fabrizio"), "the open page never showed the list joined as text");
  await waitFor(values, same("Fabrizio"), "changing back to text never joined the list");
  if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("text-list: ok");
} finally {
  await browser.close();
}
