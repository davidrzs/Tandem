import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { applyEditToState, getAuthors, type AuthorInfo } from "./authors.js";
import { jsonToMarkdown, markdownToJSON } from "./markdown.js";
import { COLLAB_FIELD } from "./schema.js";
import { fillTaskBlockIds, withTaskBlockIds } from "./tasks.js";

const ann: AuthorInfo = { userId: "ann", name: "Ann", ai: false, at: 1 };
const bot: AuthorInfo = { userId: "ann", name: "Ann", ai: true, at: 2 };

const md = "# Plan\n\n- [ ] @ann write the intro\n- [x] book the room";

const ids = (tasks: Array<{ blockId: string }>) => tasks.map((t) => t.blockId);

test("a new body gets one unique block id per task; the markdown has none", () => {
  const created = applyEditToState(null, { body: () => md }, ann);
  assert.equal(created.contentMd, md);
  assert.equal(new Set(ids(created.tasks)).size, 2);
  assert.match(created.tasks[0]!.blockId, /^[0-9a-f]{12}$/);
});

test("block ids survive edits above, a text edit, and a markdown round trip", () => {
  const created = applyEditToState(null, { body: () => md }, ann);
  const [intro, room] = ids(created.tasks);

  const above = applyEditToState(created.ydocState, { body: (cur) => `New first line\n\n${cur}` }, bot);
  assert.deepEqual(ids(above.tasks), [intro, room]);

  const reworded = applyEditToState(
    above.ydocState,
    { body: (cur) => cur.replace("book the room", "book the big room") },
    bot,
  );
  assert.deepEqual(
    reworded.tasks.map((t) => [t.blockId, t.text]),
    [
      [intro, "@ann write the intro"],
      [room, "book the big room"],
    ],
  );

  const exported = jsonToMarkdown(reworded.contentJson);
  assert.equal(exported, "New first line\n\n# Plan\n\n- [ ] @ann write the intro\n- [x] book the big room");
  const reimported = withTaskBlockIds(reworded.contentJson, markdownToJSON(exported));
  assert.equal(jsonToMarkdown(reimported), exported);
  assert.deepEqual(
    JSON.stringify(reimported).match(/"blockId":"[0-9a-f]+"/g),
    [`"blockId":"${intro}"`, `"blockId":"${room}"`],
  );
});

test("a deleted task's id goes with it; a new task gets a fresh one", () => {
  const created = applyEditToState(null, { body: () => md }, ann);
  const [intro, room] = ids(created.tasks);
  const edited = applyEditToState(
    created.ydocState,
    { body: (cur) => `${cur.replace("- [ ] @ann write the intro\n", "")}\n- [ ] call the venue` },
    ann,
  );
  assert.equal(edited.tasks.length, 2);
  assert.equal(edited.tasks[0]!.blockId, room);
  assert.notEqual(edited.tasks[1]!.blockId, intro);
  assert.notEqual(edited.tasks[1]!.blockId, room);
});

test("projectTasks reports text, state, handles, order and the blamed author", () => {
  const created = applyEditToState(null, { body: () => md }, ann);
  const added = applyEditToState(
    created.ydocState,
    { body: (cur) => `${cur.trimEnd()}\n- [ ] @Bob@x.org and @ann: send notes\n` },
    bot,
  );
  assert.deepEqual(
    added.tasks.map(({ blockId: _, ...row }) => row),
    [
      { text: "@ann write the intro", done: false, handles: ["ann"], position: 0, createdBy: "ann", ai: false },
      { text: "book the room", done: true, handles: [], position: 1, createdBy: "ann", ai: false },
      {
        text: "@Bob@x.org and @ann: send notes",
        done: false,
        handles: ["bob@x.org", "ann"],
        position: 2,
        createdBy: "ann",
        ai: true,
      },
    ],
  );
});

test("a copied task item gets its own id", () => {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(COLLAB_FIELD);
  const list = new Y.XmlElement("taskList");
  const items = [0, 1, 2].map(() => {
    const item = new Y.XmlElement("taskItem");
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("same")]);
    item.insert(0, [para]);
    return item;
  });
  list.insert(0, items);
  fragment.insert(0, [list]);
  items[0]!.setAttribute("blockId", "aaaaaaaaaaaa");
  items[1]!.setAttribute("blockId", "aaaaaaaaaaaa");

  assert.equal(fillTaskBlockIds(doc), 2);
  const after = items.map((el) => el.getAttribute("blockId"));
  assert.equal(after[0], "aaaaaaaaaaaa");
  assert.equal(new Set(after).size, 3);
  assert.equal(fillTaskBlockIds(doc), 0);
});

test("filling ids stamps no session, so history lists only real writing", () => {
  const created = applyEditToState(null, { body: () => md }, ann);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, created.ydocState);
  const before = [...getAuthors(doc).keys()];
  const item = doc.getXmlFragment(COLLAB_FIELD).createTreeWalker((el) => el instanceof Y.XmlElement && el.nodeName === "taskItem").next().value as Y.XmlElement;
  item.removeAttribute("blockId");
  const edited = applyEditToState(Y.encodeStateAsUpdate(doc), { properties: [] }, bot);
  Y.applyUpdate(doc, edited.ydocState);
  assert.deepEqual([...getAuthors(doc).keys()], before);
  assert.equal(edited.tasks.length, 2);
});
