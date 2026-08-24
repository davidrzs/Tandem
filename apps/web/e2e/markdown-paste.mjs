// Verifies clipboard Markdown becomes Tandem document structure while rich
// HTML sources retain their native formatting. Needs web+api (run.sh).
import { chromium } from "playwright";
import { signUp, createCollection, newDocument } from "./_helpers.mjs";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));

async function paste(data) {
  await page.locator(".ProseMirror").click();
  await page.evaluate((clipboard) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(clipboard)) {
      transfer.setData(type, value);
    }
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // Chromium's ClipboardEvent constructor ignores a clipboardData init
    // member, so attach the synthetic transfer explicitly.
    Object.defineProperty(event, "clipboardData", { value: transfer });
    document.querySelector(".ProseMirror")?.dispatchEvent(event);
  }, data);
}

try {
  await signUp(page, "Markdown Paste User");
  const collection = `Markdown paste ${Date.now()}`;
  await createCollection(page, collection);
  await newDocument(page, collection);
  await page.waitForFunction(
    () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true",
  );

  await paste({
    "text/plain": [
      "## Pasted heading",
      "",
      "A **bold** paragraph.",
      "",
      "- [ ] pasted task",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "> [!note]",
      "> Parsed callout",
    ].join("\n"),
  });

  await page.waitForSelector(".ProseMirror h2", { state: "visible" });
  await page.waitForSelector(".ProseMirror strong", { state: "visible" });
  await page.waitForSelector('.ProseMirror ul[data-type="taskList"]');
  await page.waitForSelector(".ProseMirror table");
  await page.waitForSelector(".ProseMirror .callout-note");

  // When a source offers rich HTML, retain it instead of interpreting its
  // plain-text fallback as Markdown.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await paste({
    "text/plain": "## Plain fallback",
    "text/html": "<p><em>Rich HTML source</em></p>",
  });
  await page.waitForSelector(".ProseMirror em", { state: "visible" });
  if (await page.getByRole("heading", { name: "Plain fallback" }).count()) {
    throw new Error("rich HTML paste was replaced by its Markdown-looking fallback");
  }

  // An explicit Markdown MIME type is intentional and wins over accompanying
  // HTML supplied by the clipboard producer.
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await paste({
    "text/markdown": "### Explicit Markdown",
    "text/plain": "Explicit Markdown",
    "text/html": "<p>Explicit Markdown</p>",
  });
  await page.waitForSelector(".ProseMirror h3", { state: "visible" });

  await page.waitForTimeout(2800);
  await page.reload();
  await page.waitForSelector(".ProseMirror h2", { state: "visible" });
  await page.waitForSelector(".ProseMirror h3", { state: "visible" });
  await page.waitForSelector(".ProseMirror .callout-note");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("MARKDOWN PASTE PASS — plain Markdown parses, rich HTML stays rich, content persists");
} finally {
  await browser.close();
}
