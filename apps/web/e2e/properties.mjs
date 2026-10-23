// Properties on a page: attach a type from the header, set a date and a
// select in the panel (by keyboard too: a half-cleared date, browsing a
// select, focus after a control goes away, refused numbers and links), see
// them after a reload, see an agent's value marked as AI, detach without
// losing values, sort the parent's Contents by a property column, keep a live
// property set through the body's undo, mark values the server reported and
// remove a retired field's value, and refuse edits offline.
// Needs web+api (run.sh).
import { createHash, randomBytes } from "node:crypto";
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

const valuesOf = (id) => trpcQuery("documents.properties", { id }).then((v) => v.values);

/** An MCP access token for the signed-in user, issued to an app named
 * `agent` (the name blame shows), through the real OAuth flow. */
async function agentToken(agent) {
  const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headers = { origin: BASE };
  const reg = await page.request.post(`${BASE}/api/auth/mcp/register`, {
    headers,
    data: {
      redirect_uris: ["http://localhost:9999/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      client_name: agent,
    },
  });
  const clientId = (await reg.json()).client_id;
  const verifier = b64url(randomBytes(32));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:9999/cb",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    scope: "openid profile",
    state: "st",
    prompt: "consent",
  });
  const authorize = await page.request.get(`${BASE}/api/auth/mcp/authorize?${q}`, { headers, maxRedirects: 0 });
  const consentCode = new URL(authorize.headers().location ?? "", BASE).searchParams.get("consent_code");
  if (!consentCode) throw new Error(`no consent code: ${authorize.status()} ${authorize.headers().location}`);
  const consent = await page.request.post(`${BASE}/api/auth/oauth2/consent`, {
    headers,
    data: { accept: true, consent_code: consentCode },
  });
  const code = new URL((await consent.json()).redirectURI).searchParams.get("code");
  const token = await page.request.post(`${BASE}/api/auth/mcp/token`, {
    headers,
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://localhost:9999/cb",
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  const accessToken = (await token.json()).access_token;
  if (!accessToken) throw new Error("no MCP access token");
  return accessToken;
}

async function mcpCall(token, name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  if (!res.ok || body.error || body.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(body)}`);
  return body.result;
}

async function waitForMarkdown(id, test, what) {
  return waitFor(() => trpcQuery("documents.getMarkdown", { id }).then((r) => r.markdown), test, `body of ${id} never ${what}`);
}

try {
  await signUp(page, "Pat Properties");
  const c = `Properties ${Date.now()}`;
  await createCollection(page, c);
  await newDocument(page, c);
  const parentId = new URL(page.url()).pathname.split("/").pop();
  const { workspaceId, collectionId } = await trpcQuery("documents.getMeta", { id: parentId });

  const type = await trpcMutation("types.create", { workspaceId, name: "Meeting" });
  const field = (key, kind, options) =>
    trpcMutation("types.createField", {
      workspaceId,
      typeId: type.id,
      key,
      label: key[0].toUpperCase() + key.slice(1),
      kind,
      options,
    });
  const status = await field("status", "select", ["Open", "Done"]);
  const date = await field("date", "date");
  const topics = await field("topics", "multi_select", ["Budget", "Hiring"]);
  const owner = await field("owner", "doc");
  await field("count", "number");
  await field("site", "url");
  const longLabel = "Executive summary of the quarterly planning review and its follow-ups";
  await trpcMutation("types.createField", { workspaceId, typeId: type.id, key: "summary", label: longLabel, kind: "text" });

  const retro = await trpcMutation("documents.create", { collectionId, parentDocumentId: parentId, title: "Retro" });
  const planning = await trpcMutation("documents.create", { collectionId, parentDocumentId: parentId, title: "Planning" });

  await page.goto(`${BASE}/d/${retro.id}`);
  await page.waitForSelector(".ProseMirror");
  await page.getByRole("button", { name: "Page type: none" }).click();
  await page.getByRole("menuitem", { name: "Meeting" }).click();
  await page.locator(".props-summary[aria-expanded=true]").waitFor();
  const longTitle = await page.locator('.props-row[data-field="summary"] .props-label').getAttribute("title");
  if (longTitle !== longLabel) throw new Error(`the long label's tooltip reads ${longTitle}`);
  const dateWrites = [];
  const writes = [];
  page.on("request", (r) => {
    if (!r.url().includes("documents.setProperties")) return;
    const body = r.postData() ?? "";
    writes.push(body);
    const set = body.match(/"set":\{"date":"([^"]*)"\}/);
    if (set) dateWrites.push(set[1]);
    if (body.includes('"unset":["date"]')) dateWrites.push(null);
  });
  const writesTo = (key) => writes.filter((body) => body.includes(`"${key}"`)).length;
  const dateInput = page.getByLabel("Date", { exact: true });
  await dateInput.focus();
  await page.keyboard.type("10222026");
  await page.keyboard.press("Enter");
  const statusSelect = page.getByLabel("Status", { exact: true });
  await statusSelect.focus();
  for (const key of ["ArrowDown", "ArrowDown", "ArrowUp"]) await page.keyboard.press(key);
  await page.waitForTimeout(500);
  if (writesTo("status") !== 0) throw new Error(`browsing Status with arrow keys saved ${writesTo("status")} times`);
  await page.keyboard.press("Tab");
  await waitFor(() => valuesOf(retro.id), (v) => v[status.id] === "Open", "leaving Status after browsing never saved it");
  if (writesTo("status") !== 1) throw new Error(`leaving Status saved ${writesTo("status")} times`);
  await page.getByLabel("Status", { exact: true }).selectOption({ label: "Done" });
  const picked = await page.getByLabel("Status", { exact: true }).locator("option:checked").textContent();
  if (picked !== "Done") throw new Error(`the status select shows ${picked} right after picking Done`);
  await waitFor(
    () => valuesOf(retro.id),
    (v) => v[date.id] === "2026-10-22" && v[status.id] === "Done",
    "the panel's date and select never saved",
  );
  if (JSON.stringify(dateWrites) !== '["2026-10-22"]') {
    throw new Error(`typing the date saved ${JSON.stringify(dateWrites)}`);
  }
  await dateInput.focus();
  await page.keyboard.type("11012026");
  await page.keyboard.press("Escape");
  if ((await dateInput.inputValue()) !== "2026-10-22") {
    throw new Error(`Escape left the date at ${await dateInput.inputValue()}`);
  }
  await page.keyboard.press("Tab");
  await page.waitForTimeout(500);
  if (JSON.stringify(dateWrites) !== '["2026-10-22"]') {
    throw new Error(`an escaped date edit saved ${JSON.stringify(dateWrites)}`);
  }
  await dateInput.focus();
  await page.keyboard.press("Backspace");
  await dateInput.blur();
  await page.waitForTimeout(500);
  if ((await dateInput.inputValue()) !== "2026-10-22" || JSON.stringify(dateWrites) !== '["2026-10-22"]') {
    throw new Error(`clearing the month showed ${await dateInput.inputValue()} and saved ${JSON.stringify(dateWrites)}`);
  }
  await dateInput.focus();
  for (let part = 0; part < 3; part++) {
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Enter");
  await waitFor(() => valuesOf(retro.id), (v) => v[date.id] === undefined, "emptying every part of the date never cleared it");
  await dateInput.focus();
  await page.keyboard.type("10222026");
  await page.keyboard.press("Enter");
  await waitFor(() => valuesOf(retro.id), (v) => v[date.id] === "2026-10-22", "the retyped date never saved");
  if (JSON.stringify(dateWrites) !== '["2026-10-22",null,"2026-10-22"]') {
    throw new Error(`clearing and retyping the date saved ${JSON.stringify(dateWrites)}`);
  }
  for (const [label, typed, toastText] of [
    ["Count", "0x1F", "Count takes a number."],
    ["Site", "example.com", "Site takes a link that starts with http:// or https://."],
  ]) {
    const input = page.getByLabel(label, { exact: true });
    await input.fill(typed);
    await input.press("Enter");
    await page.locator(".toast", { hasText: toastText }).waitFor({ timeout: 5000 });
    if ((await input.inputValue()) !== "") throw new Error(`${label} kept ${await input.inputValue()} after a refused value`);
  }
  await page.waitForTimeout(500);
  if (writesTo("count") + writesTo("site") !== 0) throw new Error("a refused number or link was saved");
  const site = page.getByLabel("Site", { exact: true });
  await site.fill("https://example.com");
  await site.press("Enter");
  await waitFor(() => valuesOf(retro.id), (v) => Object.values(v).includes("https://example.com"), "Enter in Site never saved it");
  if (!(await site.evaluate((el) => el === document.activeElement))) throw new Error("Enter in Site moved focus out of the field");
  await site.fill("");
  await site.press("Enter");
  await waitFor(() => valuesOf(retro.id), (v) => !Object.values(v).includes("https://example.com"), "emptying Site never cleared it");

  await page.reload();
  const summary = page.locator(".props-summary");
  await summary.waitFor();
  await waitFor(
    () => summary.textContent(),
    (line) => line === "MeetingStatus: Done · Date: Oct 22, 2026",
    "the collapsed summary never showed the saved values after reload",
  );
  await summary.click();
  const dateValue = await page.getByLabel("Date", { exact: true }).inputValue();
  const statusValue = await page.getByLabel("Status", { exact: true }).locator("option:checked").textContent();
  if (dateValue !== "2026-10-22" || statusValue !== "Done") {
    throw new Error(`after reload the panel shows date ${dateValue}, status ${statusValue}`);
  }

  const token = await agentToken("Claude");
  await mcpCall(token, "set_properties", { id: retro.id, add: { topics: ["Hiring"] } });
  const marker = page.locator('.props-row[data-field="topics"] .prop-chip', { hasText: "Hiring" }).locator(".prop-ai");
  await marker.waitFor({ timeout: 5000 });
  const markerLabel = await marker.getAttribute("data-ai-label");
  if (markerLabel !== "Pat Properties's AI (Claude)") throw new Error(`AI marker reads ${markerLabel}`);
  if ((await page.locator('.props-row[data-field="status"] .prop-ai').count()) !== 0) {
    throw new Error("a value the person set is marked as AI");
  }
  const addTopic = page.getByLabel("Add Topics", { exact: true });
  await addTopic.focus();
  for (const key of ["ArrowDown", "ArrowUp", "ArrowDown"]) await page.keyboard.press(key);
  await page.waitForTimeout(500);
  if (writesTo("topics") !== 0) throw new Error(`browsing Add Topics with arrow keys saved ${writesTo("topics")} times`);
  await page.keyboard.press("Enter");
  await waitFor(
    () => valuesOf(retro.id),
    (v) => JSON.stringify(v[topics.id]) === '["Hiring","Budget"]',
    "Enter on Add Topics never added the option",
  );
  if (writesTo("topics") !== 1) throw new Error(`adding a topic saved ${writesTo("topics")} times`);
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      return !el || el === document.body ? "the page body" : (el.getAttribute("aria-label") ?? el.textContent.trim());
    });
  const waitForFocus = (label, after) => waitFor(focused, (now) => now === label, `focus never reached ${label} after ${after}`);
  await waitForFocus("Remove Budget", "adding the last free topic");
  await page.keyboard.press("Enter");
  await waitForFocus("Add Topics", "removing Budget");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await waitForFocus("Remove Budget", "adding Budget again");
  await page.getByRole("combobox", { name: "Owner" }).focus();
  await page.keyboard.type("Planning");
  await page.getByRole("option", { name: "Planning" }).waitFor();
  await page.keyboard.press("Enter");
  await waitForFocus("Planning", "picking the owner");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitForFocus("Owner", "removing the owner");
  await waitFor(() => valuesOf(retro.id), (v) => v[owner.id] === undefined, "removing the owner never cleared it");

  await page.getByRole("button", { name: "Page type: Meeting" }).click();
  await page.getByRole("menuitem", { name: "Detach type" }).click();
  const dialog = page.getByRole("dialog");
  if (!(await dialog.textContent()).includes("The page keeps every value it holds")) {
    throw new Error(`detach confirm says: ${await dialog.textContent()}`);
  }
  await dialog.getByRole("button", { name: "Detach type" }).click();
  await page.getByRole("button", { name: "Page type: none" }).waitFor();
  await page.locator(".props-type", { hasText: "Properties" }).waitFor();
  const kept = await valuesOf(retro.id);
  if (
    kept[status.id] !== "Done" ||
    kept[date.id] !== "2026-10-22" ||
    JSON.stringify(kept[topics.id]) !== '["Hiring","Budget"]'
  ) {
    throw new Error(`detach lost values: ${JSON.stringify(kept)}`);
  }
  if ((await page.getByLabel("Status", { exact: true }).locator("option:checked").textContent()) !== "Done") {
    throw new Error("the detached page's panel no longer shows its status");
  }

  await trpcMutation("documents.setType", { id: retro.id, typeId: type.id });
  await trpcMutation("documents.setType", { id: planning.id, typeId: type.id });
  await trpcMutation("documents.setProperties", { id: planning.id, set: { status: "Open", date: "2026-11-02" } });
  await waitFor(
    () => trpcQuery("documents.tree", { collectionId }),
    (tree) => {
      const kids = tree.find((n) => n.id === parentId)?.children ?? [];
      return kids.length === 2 && kids.every((k) => k.properties[date.id]);
    },
    "the tree never carried both dates",
  );

  await page.goto(`${BASE}/d/${parentId}`);
  const contents = page.locator(".sub-pages .outline-table");
  await contents.getByRole("columnheader", { name: "Status" }).waitFor();
  const order = () => contents.locator("tbody .outline-link").allTextContents();
  await contents.getByRole("button", { name: "Date", exact: true }).click();
  const asc = await order();
  if (JSON.stringify(asc) !== '["Retro","Planning"]') throw new Error(`date ascending: ${JSON.stringify(asc)}`);
  await contents.getByRole("button", { name: /^Date/ }).click();
  const desc = await order();
  if (JSON.stringify(desc) !== '["Planning","Retro"]') throw new Error(`date descending: ${JSON.stringify(desc)}`);
  const cells = await contents.locator("tbody tr").first().locator("td.outline-field").allTextContents();
  if (JSON.stringify(cells) !== '["Open","Nov 2, 2026",""]') throw new Error(`Planning's cells: ${JSON.stringify(cells)}`);

  const priority = await field("priority", "select", ["Low", "High"]);
  await trpcMutation("documents.setProperties", { id: retro.id, set: { priority: "High" } });
  await trpcMutation("types.updateField", { id: priority.id, kind: "text" });
  await waitFor(() => valuesOf(retro.id), (v) => v[priority.id] === "High", "a select turned text never read as its label");
  const notes = await field("notes", "text");
  const points = await field("points", "number");
  await trpcMutation("documents.setProperties", { id: retro.id, set: { notes: "kickoff zebra notes", points: 12 } });
  await trpcMutation("types.updateField", { id: notes.id, kind: "number" });
  await trpcMutation("types.retireField", { id: points.id });
  const newPoints = await field("points", "number");

  await page.goto(`${BASE}/d/${retro.id}`);
  await page.click(".ProseMirror");
  await page.keyboard.type("Agenda for today.");
  await waitForMarkdown(retro.id, (md) => md.includes("Agenda for today."), "saved the typed text");
  await trpcMutation("documents.setProperties", { id: retro.id, set: { status: "open" } });
  await page.click(".ProseMirror");
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => !document.querySelector(".ProseMirror")?.textContent?.includes("Agenda"));
  await waitForMarkdown(retro.id, (md) => !md.includes("Agenda"), "dropped the undone text");
  const after = await valuesOf(retro.id);
  if (after[status.id] !== "Open") throw new Error(`undo in the body reverted the property: ${JSON.stringify(after)}`);

  if (await page.locator(".props-summary[aria-expanded=false]").isVisible()) await page.locator(".props-summary").click();
  const priorityText = await page.getByLabel("Priority", { exact: true }).inputValue();
  if (priorityText !== "High") throw new Error(`a select turned text shows ${priorityText}`);
  const notesIssue = await page.locator('.props-row[data-field="notes"] .prop-issue').getAttribute("aria-label");
  if (notesIssue !== "expected a number") throw new Error(`the text-turned-number marker reads ${notesIssue}`);
  const retiredRow = page.locator('.props-row[data-field="points"]', { has: page.locator(".prop-remove-field") });
  const retiredText = await retiredRow.locator(".props-value").textContent();
  if (retiredText !== "12!Remove") throw new Error(`the retired field's row reads ${retiredText}`);
  const retiredIssue = await retiredRow.locator(".prop-issue").getAttribute("aria-label");
  if (retiredIssue !== "points is retired") throw new Error(`the retired field's marker reads ${retiredIssue}`);
  await retiredRow.getByRole("button", { name: "Remove Points" }).focus();
  await page.keyboard.press("Enter");
  await waitFor(
    () => valuesOf(retro.id),
    (v) => !(points.id in v) && !(newPoints.id in v),
    "Remove never cleared the retired field",
  );
  await retiredRow.waitFor({ state: "detached" });
  await waitForFocus("Add field", "removing the retired field");
  const statusNow = page.getByLabel("Status", { exact: true });
  const statusDisabled = () => statusNow.evaluate((el) => el.matches(":disabled"));
  await page.context().setOffline(true);
  await page.getByText("Properties can't be edited offline.").waitFor({ timeout: 5000 });
  if (!(await statusDisabled())) throw new Error("Status stays editable offline");
  await page.context().setOffline(false);
  await page.getByText("Properties can't be edited offline.").waitFor({ state: "detached", timeout: 40_000 });
  if (await statusDisabled()) throw new Error("Status stays disabled back online");
  await page.route("**/trpc/documents.setProperties**", (route) => route.abort("internetdisconnected"));
  await statusNow.selectOption({ label: "Done" });
  await page.locator(".toast", { hasText: "Couldn't save that value." }).waitFor({ timeout: 5000 });
  await waitFor(
    () => statusNow.locator("option:checked").textContent(),
    (shown) => shown === "Open",
    "a failed save left the select on the unsaved value",
  );
  await page.unroute("**/trpc/documents.setProperties**");

  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(
    "PROPERTIES PASS — attach, panel date + select persist, keyboard edits, AI marker, detach keeps values, Contents sorts by a property, body undo spares properties, issue markers, retired field removal, offline refusal",
  );
} finally {
  await browser.close();
}
