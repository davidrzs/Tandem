// Verifies that "- [ ] " typed inside a bullet list converts to a real
// checkbox (task list) live. Assumes web (5173) + api (3001) running (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await signUp(page, "Task User");
  const collectionName = `Tasks ${Date.now()}`;
  await createCollection(page, collectionName);
  await newDocument(page, collectionName);

  // Type a dash (→ bullet), then "[ ] " (→ checkbox), then content. The input
  // rule fires on the space after "]" while the item holds only the marker.
  await page.click(".ProseMirror");
  await page.type(".ProseMirror", "- [ ] Buy milk");

  await page.waitForSelector('.ProseMirror ul[data-type="taskList"]');
  const checkbox = await page.$('.ProseMirror ul[data-type="taskList"] input[type="checkbox"]');
  if (!checkbox) throw new Error("no checkbox rendered — marker did not convert");

  const itemText = (await page.textContent(".ProseMirror li[data-checked]")) ?? "";
  if (!itemText.includes("Buy milk")) throw new Error(`task text missing: "${itemText}"`);
  if (itemText.includes("[ ]")) throw new Error(`marker text leaked into the item: "${itemText}"`);

  // Checking it must persist (controlled checkbox + optimistic round-trip).
  await checkbox.click();
  await page.waitForSelector('.ProseMirror li[data-checked="true"]');

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("TASKS PASS — '- [ ] ' converts to a checkbox and toggles");
} finally {
  await browser.close();
}
