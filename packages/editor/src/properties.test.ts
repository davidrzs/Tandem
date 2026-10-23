import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import {
  applyAttributedProperties,
  applyEditToState,
  getAuthors,
  type AuthorInfo,
} from "./authors.js";
import {
  applyPropertyPatch,
  diffProperties,
  PROPERTIES_KEY,
  propertiesToJSON,
  propertyBlame,
  stateProperties,
  type PropertiesJSON,
  type PropertyOp,
} from "./properties.js";

const alice: AuthorInfo = { userId: "alice", name: "Alice", ai: false, at: 1000 };
const agent: AuthorInfo = { userId: "alice", name: "Alice", ai: true, at: 2000, agent: "Claude" };

/** Field ids sort the JSON so replicas compare equal: Y.Map key order
 * differs between replicas after concurrent adds. */
function sorted(json: PropertiesJSON): PropertiesJSON {
  return Object.fromEntries(Object.keys(json).sort().map((k) => [k, json[k]]));
}

function docWith(json: PropertiesJSON, clientID = 1): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  applyPropertyPatch(doc, diffProperties({}, json));
  return doc;
}

test("set stores {v}, unset stores {v:null}, and blame names whoever cleared it", () => {
  const doc = new Y.Doc();
  applyAttributedProperties(doc, [{ op: "set", field: "f_status", value: "o_done" }], alice);
  const clearer = applyAttributedProperties(doc, [{ op: "unset", field: "f_status" }], agent);
  assert.deepEqual(doc.getMap(PROPERTIES_KEY).toJSON(), { f_status: { v: null } });
  assert.deepEqual(propertiesToJSON(doc), { f_status: null });
  assert.deepEqual(
    propertyBlame(doc).map((b) => ({ ...b, author: getAuthors(doc).get(b.clientId)?.agent })),
    [{ field: "f_status", value: null, clientId: clearer, author: "Claude" }],
  );
});

test("a patch that changes nothing writes nothing and stamps no session", () => {
  const doc = docWith({ f_status: "o_done", f_people: ["ann"] });
  const before = Y.encodeStateAsUpdate(doc);
  const session = applyAttributedProperties(
    doc,
    [
      { op: "set", field: "f_status", value: "o_done" },
      { op: "add", field: "f_people", values: ["ann"] },
      { op: "remove", field: "f_people", values: ["bob"] },
      { op: "unset", field: "f_missing" },
    ],
    agent,
  );
  assert.equal(session, null);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
});

test("list ops: add skips present values, remove drops every copy, setList keeps kept elements' authors", () => {
  const doc = new Y.Doc();
  const first = applyAttributedProperties(doc, [{ op: "add", field: "f_people", values: ["ann", "bob"] }], alice);
  applyPropertyPatch(doc, [{ op: "add", field: "f_people", values: ["bob", "cy", "cy"] }]);
  assert.deepEqual(propertiesToJSON(doc), { f_people: ["ann", "bob", "cy"] });

  applyPropertyPatch(doc, [{ op: "remove", field: "f_people", values: ["cy"] }]);
  const second = applyAttributedProperties(
    doc,
    [{ op: "setList", field: "f_people", values: ["bob", "dee"] }],
    agent,
  );
  assert.deepEqual(propertiesToJSON(doc), { f_people: ["bob", "dee"] });
  assert.deepEqual(
    propertyBlame(doc).map(({ value, clientId }) => [value, clientId]),
    [
      ["bob", first],
      ["dee", second],
    ],
  );
});

test("a list op on a field holding a scalar turns it into a list that keeps the value", () => {
  const doc = docWith({ f_tags: "alpha" });
  applyPropertyPatch(doc, [{ op: "add", field: "f_tags", values: ["beta"] }]);
  assert.ok(doc.getMap(PROPERTIES_KEY).get("f_tags") instanceof Y.Array);
  assert.deepEqual(propertiesToJSON(doc), { f_tags: ["alpha", "beta"] });
});

test("removing a value a scalar field doesn't hold writes nothing; removing the one it holds clears it", () => {
  const doc = docWith({ f_tags: "alpha" });
  const before = Y.encodeStateAsUpdate(doc);
  assert.equal(applyAttributedProperties(doc, [{ op: "remove", field: "f_tags", values: ["beta"] }], agent), null);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
  assert.equal(applyPropertyPatch(doc, [{ op: "remove", field: "f_tags", values: ["alpha"] }]), 1);
  assert.deepEqual(propertiesToJSON(doc), { f_tags: [] });
});

test("reads return what a client stored, unvalidated", () => {
  const doc = new Y.Doc();
  doc.getMap(PROPERTIES_KEY).set("f_raw", "done");
  doc.getMap(PROPERTIES_KEY).set("f_obj", { v: 3, extra: true });
  assert.deepEqual(propertiesToJSON(doc), { f_raw: "done", f_obj: { v: 3, extra: true } });
  assert.deepEqual(stateProperties(Y.encodeStateAsUpdate(doc)), propertiesToJSON(doc));
});

test("diffProperties touches only the fields that differ", () => {
  assert.deepEqual(
    diffProperties(
      { a: "same", b: "old", c: ["x"], d: "gone", e: null, f: [] },
      { a: "same", b: "new", c: ["x", "y"], d: null, e: null, g: 4 },
    ),
    [
      { op: "set", field: "b", value: "new" },
      { op: "setList", field: "c", values: ["x", "y"] },
      { op: "unset", field: "d" },
      { op: "set", field: "g", value: 4 },
    ],
  );
});

test("diffProperties compares lists as sets, as setList applies them", () => {
  assert.deepEqual(diffProperties({ c: ["x", "y"], d: ["x"] }, { c: ["y", "x", "x"], d: ["x", "z"] }), [
    { op: "setList", field: "d", values: ["x", "z"] },
  ]);
});

test("a body edit through applyEditToState keeps the properties map and its authors", () => {
  const seeded = applyEditToState(
    null,
    { body: () => "Hello.", properties: [{ op: "set", field: "f_status", value: "o_open" }] },
    alice,
  );
  const edited = applyEditToState(seeded.ydocState, { body: (md) => `${md}\n\nMore.` }, agent);
  assert.equal(edited.contentMd, "Hello.\n\nMore.");
  assert.deepEqual(edited.properties, { f_status: "o_open" });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, edited.ydocState);
  const [blame] = propertyBlame(doc);
  assert.equal(getAuthors(doc).get(blame!.clientId)?.ai, false);
});

test("a property-only applyEditToState leaves the body alone", () => {
  const seeded = applyEditToState(null, { body: () => "# Notes\n\nBody." }, alice);
  const edited = applyEditToState(
    seeded.ydocState,
    { properties: [{ op: "add", field: "f_people", values: ["ann"] }] },
    agent,
  );
  assert.equal(edited.contentMd, "# Notes\n\nBody.");
  assert.deepEqual(edited.properties, { f_people: ["ann"] });
});

// The yaml-merge scenarios (docs/plans/evidence/yaml-merge.md), replayed
// through applyPropertyPatch. Nested `review.*` keys become flat fields,
// since field kinds are flat; reformatting is a serializer concern, so a
// reformatting client writes nothing.

const BASE: PropertiesJSON = {
  date: "2026-10-20",
  status: "draft",
  project: "[[Apollo]]",
  attendees: ["Alice", "Bob"],
  tags: ["meeting", "planning"],
  "review.owner": "Alice",
  "review.due": "2026-11-01",
};
const LISTS = new Set(["attendees", "tags"]);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261022);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const randInt = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (n: number) => String(n).padStart(2, "0");
function randDate(not: string): string {
  for (;;) {
    const d = `2026-${pad(randInt(10, 12))}-${pad(randInt(1, 28))}`;
    if (d !== not) return d;
  }
}
const NAMES = ["Carol", "Dave", "Erin", "Frank", "Grace", "Heidi", "Ivan", "Judy", "Mallory", "Niaj"];
const STATUSES = ["final", "review", "done", "cancelled", "scheduled"];
const TAGS = ["q4", "roadmap", "budget", "hiring", "retro", "infra"];
const PROJECTS = ["[[Hermes]]", "[[Zeus]]", "[[Atlas]]", "[[Orion]]"];

const set = (field: string, value: string): PropertyOp => ({ op: "set", field, value });
const add = (field: string, value: string): PropertyOp => ({ op: "add", field, values: [value] });

interface Scenario {
  clients: PropertyOp[][];
  /** Every acceptable merge: one when all intents survive, two when the
   * conflict is an inherent last-writer-wins on one field. */
  outcomes: PropertiesJSON[];
}

const withBase = (patch: PropertiesJSON): PropertiesJSON => ({ ...BASE, ...patch });

const SCENARIOS: Record<string, () => Scenario> = {
  S1_same_scalar() {
    const a = randDate("2026-10-20");
    const b = randDate(a);
    return {
      clients: [[set("date", a)], [set("date", b)]],
      outcomes: [withBase({ date: a }), withBase({ date: b })],
    };
  },
  S2_edit_vs_add_key() {
    const s = pick(STATUSES);
    const loc = `Room ${randInt(1, 9)}`;
    return {
      clients: [[set("status", s)], [set("location", loc)]],
      outcomes: [withBase({ status: s, location: loc })],
    };
  },
  S3_both_append_list() {
    const x = pick(NAMES);
    const y = pick(NAMES.filter((n) => n !== x));
    return {
      clients: [[add("attendees", x)], [add("attendees", y)]],
      outcomes: [withBase({ attendees: ["Alice", "Bob", x, y] })],
    };
  },
  S4_reformat_vs_edit() {
    const s = pick(STATUSES);
    return { clients: [[], [set("status", s)]], outcomes: [withBase({ status: s })] };
  },
  S5_delete_vs_edit() {
    const p = pick(PROJECTS);
    return {
      clients: [[{ op: "unset", field: "project" }], [set("project", p)]],
      outcomes: [withBase({ project: null }), withBase({ project: p })],
    };
  },
  S6_nested_both_edit() {
    const d = randDate("2026-11-01");
    const note = pick(["needs legal", "ok", "blocked on infra"]);
    return {
      clients: [[set("review.due", d)], [set("review.notes", note)]],
      outcomes: [withBase({ "review.due": d, "review.notes": note })],
    };
  },
  S7_reindent_vs_nested_add() {
    const n = pick(NAMES.filter((x) => x !== "Alice" && x !== "Bob"));
    return {
      clients: [[], [set("review.approved", "yes"), add("attendees", n)]],
      outcomes: [withBase({ "review.approved": "yes", attendees: ["Alice", "Bob", n] })],
    };
  },
  S8_three_way() {
    const d = randDate("2026-10-20");
    const n = pick(NAMES);
    const tg = pick(TAGS);
    const s = pick(STATUSES);
    return {
      clients: [[set("date", d)], [add("attendees", n)], [add("tags", tg), set("status", s)]],
      outcomes: [
        withBase({ date: d, attendees: ["Alice", "Bob", n], tags: ["meeting", "planning", tg], status: s }),
      ],
    };
  },
  S9_both_add_keys() {
    const loc = `Room ${randInt(1, 9)}`;
    const dur = `${randInt(15, 90)}m`;
    return {
      clients: [[set("location", loc)], [set("duration", dur)]],
      outcomes: [withBase({ location: loc, duration: dur })],
    };
  },
};

type Outcome = "intended" | "lww" | "wrong" | "invalid";

/** List elements compare as sets (concurrent appends interleave by client). */
function canonical(json: PropertiesJSON): string {
  return JSON.stringify(
    sorted(
      Object.fromEntries(
        Object.entries(json).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]),
      ),
    ),
  );
}

function runScenario(sc: Scenario): Outcome {
  const base = docWith(BASE);
  const replicas = sc.clients.map(() => {
    const replica = new Y.Doc();
    replica.clientID = randInt(2, 1e9);
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(base));
    return replica;
  });
  sc.clients.forEach((ops, i) => {
    applyPropertyPatch(replicas[i]!, ops);
  });
  const updates = replicas.map((r) => Y.encodeStateAsUpdate(r));
  for (const r of replicas) for (const u of updates) Y.applyUpdate(r, u);

  const merged = replicas.map((r) => JSON.stringify(sorted(propertiesToJSON(r))));
  assert.equal(new Set(merged).size, 1, "replicas converge");
  const map = replicas[0]!.getMap(PROPERTIES_KEY);
  for (const [field, entry] of map.entries()) {
    if (LISTS.has(field) ? !(entry instanceof Y.Array) : entry instanceof Y.AbstractType) return "invalid";
  }
  const result = canonical(propertiesToJSON(replicas[0]!));
  const index = sc.outcomes.findIndex((o) => canonical(o) === result);
  if (index === -1) return "wrong";
  return sc.outcomes.length === 1 ? "intended" : "lww";
}

const TRIALS = 50;

test("yaml-merge S1-S9 through the real patch apply: 0 wrong, 0 invalid, LWW only on S1 and S5", () => {
  const tally: Record<string, Record<Outcome, number>> = {};
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const counts: Record<Outcome, number> = { intended: 0, lww: 0, wrong: 0, invalid: 0 };
    for (let i = 0; i < TRIALS; i++) counts[runScenario(make())]++;
    tally[name] = counts;
  }
  const intended = { intended: TRIALS, lww: 0, wrong: 0, invalid: 0 };
  const lww = { intended: 0, lww: TRIALS, wrong: 0, invalid: 0 };
  assert.deepEqual(tally, {
    S1_same_scalar: lww,
    S2_edit_vs_add_key: intended,
    S3_both_append_list: intended,
    S4_reformat_vs_edit: intended,
    S5_delete_vs_edit: lww,
    S6_nested_both_edit: intended,
    S7_reindent_vs_nested_add: intended,
    S8_three_way: intended,
    S9_both_add_keys: intended,
  });
});
