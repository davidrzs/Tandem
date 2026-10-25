import * as random from "lib0/random";
import * as Y from "yjs";
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { jsonToMarkdown, markdownToJSON } from "./markdown.js";
import { applyPropertyPatch, propertiesToJSON, type PropertiesJSON, type PropertyOp } from "./properties.js";
import { COLLAB_FIELD, schema } from "./schema.js";
import { fillTaskBlockIds, projectTasks, withTaskBlockIds, type ProjectedTask } from "./tasks.js";

/**
 * Authorship (blame) model. Every Yjs client session that inserts content gets
 * an entry in the doc-level `authors` Y.Map, keyed by its Yjs clientID. Since
 * every inserted Y.Item carries its creator's clientID, mapping items back to
 * authors gives per-span attribution that survives reloads (the map is part of
 * the Y.Doc, persisted with ydoc_state) and is invisible to the markdown read
 * model.
 *
 * Humans: the browser's Y.Doc has one clientID per session; the server stamps
 * it from the authenticated connection on first change (clients never
 * self-report, so attribution can't be forged by a cooperating client lying
 * about who it is). Server-side edits (MCP agents): each edit runs under a
 * fresh clientID stamped `ai: true` + the invoking user, so AI content is
 * always tied to the human whose session invoked it.
 */
export const AUTHORS_KEY = "authors";

export interface AuthorInfo {
  /** Better Auth user id, or "system" for the local system-scoped MCP. */
  userId: string;
  /** Display name at stamp time (survives account deletion/rename). */
  name: string;
  /** True when the content was written by an AI acting for `userId`. */
  ai: boolean;
  /** Epoch ms of this session's first write. */
  at: number;
  /** OAuth application name of the agent that wrote, at stamp time. Absent
   * for humans, the local system MCP, and stamps written before agents were
   * recorded. */
  agent?: string;
  /** Id of the document this content was copied from, when it has one. */
  source?: string;
}

/** Who is editing (an AuthorInfo minus the stamp time) — what callers carry. */
export type AuthorIdentity = Omit<AuthorInfo, "at">;

function authorsMap(doc: Y.Doc): Y.Map<AuthorInfo> {
  return doc.getMap<AuthorInfo>(AUTHORS_KEY);
}

/** A clientID not yet present in the doc's history. */
function freshClientId(doc: Y.Doc): number {
  let id = random.uint32();
  while (doc.store.clients.has(id) || id === doc.clientID) id = random.uint32();
  return id;
}

/** Record who a clientID belongs to. First write wins — never overwrites. */
export function stampAuthor(doc: Y.Doc, clientId: number, author: AuthorInfo): void {
  const key = String(clientId);
  if (!authorsMap(doc).has(key)) authorsMap(doc).set(key, author);
}

/** All known session authors of a doc, keyed by clientID. */
export function getAuthors(doc: Y.Doc): Map<number, AuthorInfo> {
  const out = new Map<number, AuthorInfo>();
  authorsMap(doc).forEach((info, key) => {
    out.set(Number(key), info);
  });
  return out;
}

/**
 * Run `write` under a fresh clientID stamped as `author`, so everything it
 * inserts is traceable to exactly this session. `write` returns whether it
 * changed anything; when it didn't, no author is stamped (no phantom
 * session) and the result is null.
 */
function runAttributed(doc: Y.Doc, author: AuthorInfo, write: () => boolean): number | null {
  const previousClientId = doc.clientID;
  doc.clientID = freshClientId(doc);
  const editClientId = doc.clientID;
  let changed = false;
  try {
    doc.transact(() => {
      changed = write();
      if (changed) stampAuthor(doc, editClientId, author);
    });
  } finally {
    doc.clientID = previousClientId;
  }
  return changed ? editClientId : null;
}

/**
 * Apply a structural edit to the doc's collab fragment, attributed to
 * `author`, plus an optional property patch in the same session. Unchanged
 * nodes keep their CRDT identity (and their original authorship) via
 * updateYFragment's structural diff.
 */
export function applyAttributedEdit(
  doc: Y.Doc,
  nextJson: unknown,
  author: AuthorInfo,
  properties: readonly PropertyOp[] = [],
): number {
  return runAttributed(doc, author, () => {
    const fragment = doc.getXmlFragment(COLLAB_FIELD);
    const current = fragment.length > 0 ? yXmlFragmentToProsemirrorJSON(fragment) : null;
    updateYFragment(
      doc,
      fragment,
      schema.nodeFromJSON(withTaskBlockIds(current, nextJson) as never),
      { mapping: new Map(), isOMark: new Map() },
    );
    applyPropertyPatch(doc, properties);
    return true;
  })!;
}

/** Apply a property patch attributed to `author`. Returns the session's
 * clientID, or null when the patch changed nothing. */
export function applyAttributedProperties(
  doc: Y.Doc,
  ops: readonly PropertyOp[],
  author: AuthorInfo,
): number | null {
  return runAttributed(doc, author, () => applyPropertyPatch(doc, ops) > 0);
}

/** Apply a property patch to a persisted state as one attributed session,
 * leaving the body alone. The new state, or null when nothing changed. */
export function applyPropertiesToState(
  state: Uint8Array,
  ops: readonly PropertyOp[],
  author: AuthorInfo,
): Uint8Array | null {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return applyAttributedProperties(doc, ops, author) === null ? null : Y.encodeStateAsUpdate(doc);
}

/** Build a new Y.Doc seeded with `json`, attributed to `author` (creation). */
export function seedAttributedDoc(json: unknown, author: AuthorInfo): Y.Doc {
  const doc = new Y.Doc();
  applyAttributedEdit(doc, json, author);
  return doc;
}

/** ProseMirror JSON of a persisted Yjs state — for rendering a version preview
 * and for restore (which diffs this JSON into the live doc). An empty document
 * normalizes to the schema's empty JSON so it's always a valid node. */
export function stateToJSON(state: Uint8Array): unknown {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const fragment = doc.getXmlFragment(COLLAB_FIELD);
  return fragment.length === 0 ? markdownToJSON("") : yXmlFragmentToProsemirrorJSON(fragment);
}

/** Attribution for content whose author predates blame tracking (legacy docs
 * seeded from markdown at load time). */
export const UNKNOWN_AUTHOR: AuthorInfo = { userId: "", name: "Unknown", ai: false, at: 0 };

/** Attribution for what the server writes on no person's behalf: backfills,
 * upgrades, conversions after a field's kind changes. */
export const SYSTEM_AUTHOR: AuthorIdentity = { userId: "system", name: "System", ai: true };

export interface EditedState {
  ydocState: Uint8Array;
  contentMd: string;
  contentJson: unknown;
  properties: PropertiesJSON;
  tasks: ProjectedTask[];
}

/** A body transform (markdown in, markdown out), a property patch, or both. */
export interface StateEdit {
  body?: (currentMd: string) => string;
  properties?: readonly PropertyOp[];
}

/**
 * The non-live edit path: hydrate the persisted Yjs state (or start fresh),
 * apply the edit as one attributed session, and return the new state plus
 * the derived read model. Keeps ydoc_state, content_md and the properties
 * in lockstep for writers that don't go through a live collaboration
 * session.
 */
export function applyEditToState(
  state: Uint8Array | null,
  edit: StateEdit,
  author: AuthorInfo,
  legacyMd = "",
): EditedState {
  const doc = new Y.Doc();
  if (state && state.length > 0) Y.applyUpdate(doc, state);
  const fragment = doc.getXmlFragment(COLLAB_FIELD);
  // A doc from before Yjs persistence: seed its markdown as pre-blame content
  // so the edit lands on the real body and existing text isn't re-attributed.
  if (fragment.length === 0 && legacyMd) {
    applyAttributedEdit(doc, markdownToJSON(legacyMd), UNKNOWN_AUTHOR);
  }
  if (edit.body) {
    const currentMd =
      fragment.length > 0 ? jsonToMarkdown(yXmlFragmentToProsemirrorJSON(fragment)) : "";
    applyAttributedEdit(doc, markdownToJSON(edit.body(currentMd)), author, edit.properties);
  } else if (edit.properties) {
    applyAttributedProperties(doc, edit.properties, author);
  }
  // A state from before block ids gets them here, so its tasks project. Ids
  // are bookkeeping, not writing: no session is stamped for them.
  doc.transact(() => fillTaskBlockIds(doc));
  const contentJson =
    fragment.length > 0 ? yXmlFragmentToProsemirrorJSON(fragment) : markdownToJSON("");
  return {
    ydocState: Y.encodeStateAsUpdate(doc),
    contentMd: jsonToMarkdown(contentJson),
    contentJson,
    properties: propertiesToJSON(doc),
    tasks: projectTasks(doc, getAuthors(doc)),
  };
}

/**
 * Server-side attribution authority: given an incoming update from an
 * authenticated connection, stamp any clientID it introduces that has no
 * author entry yet. The doc's own clientID is skipped (server-side writes
 * stamp themselves). Returns how many clientIDs were stamped.
 */
export function stampMissingFromUpdate(
  doc: Y.Doc,
  update: Uint8Array,
  author: (clientId: number) => AuthorInfo,
): number {
  const meta = Y.parseUpdateMeta(update);
  const authors = authorsMap(doc);
  const missing = [...meta.to.keys()].filter(
    (clientId) => clientId !== doc.clientID && !authors.has(String(clientId)),
  );
  if (missing.length > 0) {
    doc.transact(() => {
      for (const clientId of missing) authors.set(String(clientId), author(clientId));
    });
  }
  return missing.length;
}

/**
 * Server-side integrity guard for the authors map. Clients must never write
 * it (the server is the attribution authority), but it lives inside the same
 * client-writable Y.Doc, so a crafted update CAN touch it. This inspects an
 * incoming client update and corrects the primary forgery: a session writing
 * an authors entry for its own clientID under a false identity (e.g. claiming
 * to be another user, or relabeling AI output as human). Such entries are
 * overwritten with the connection's authenticated identity.
 *
 * Entries a client writes ABOUT OTHER sessions are left untouched: they are
 * indistinguishable from a legitimate relay of history (a client re-syncing
 * updates the server lost), and deleting those would destroy real
 * attribution. The residual risk — a writable collaborator vandalizing
 * existing entries — is equivalent in trust terms to them vandalizing the
 * document text itself, and is documented as such.
 */
export function sanitizeClientAuthorsWrites(
  doc: Y.Doc,
  update: Uint8Array,
  truthful: (clientId: number) => AuthorInfo,
): number {
  const { structs } = Y.decodeUpdate(update);
  const selfStamped: number[] = [];
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    // Items written directly into the root-level authors map carry its key
    // name as their parent and the map key (a clientID) as parentSub. In a
    // DECODED (unintegrated) item the parent is that raw string, even though
    // the integrated-item type doesn't admit it.
    const parent = struct.parent as unknown;
    if (parent !== AUTHORS_KEY || typeof struct.parentSub !== "string") continue;
    const claimedClient = Number(struct.parentSub);
    if (struct.id.client === claimedClient) selfStamped.push(claimedClient);
  }
  if (selfStamped.length > 0) {
    doc.transact(() => {
      for (const clientId of selfStamped) {
        authorsMap(doc).set(String(clientId), truthful(clientId));
      }
    });
  }
  return selfStamped.length;
}

/** A contiguous run of content inserted by one client session, in ProseMirror
 * document positions (usable directly for editor decorations). */
export interface BlameSpan {
  from: number;
  to: number;
  clientId: number;
}

interface YTypeInternals {
  _item: Y.Item | null;
  _start: Y.Item | null;
}

/**
 * Walk the collab fragment and attribute every ProseMirror position range to
 * the Yjs client that inserted it. Positions follow ProseMirror conventions
 * (element open/close tags count 1 each; text counts per character; leaf nodes
 * count 1), so they line up with the y-prosemirror-bound editor doc.
 */
export function blameSpans(fragment: Y.XmlFragment): BlameSpan[] {
  const out: BlameSpan[] = [];
  walkChildren(fragment, 0, out);
  return mergeSpans(out);
}

/** Walk the children of a fragment/element; returns their total PM size. */
function walkChildren(
  parent: Y.XmlFragment | Y.XmlElement,
  pos: number,
  out: BlameSpan[],
): number {
  const start = pos;
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      // Text content: each undeleted countable item is a run of characters
      // inserted by one client. Formatting (marks) items are not countable
      // and occupy no ProseMirror positions.
      let item = (child as unknown as YTypeInternals)._start;
      while (item) {
        if (!item.deleted && item.countable) {
          out.push({ from: pos, to: pos + item.length, clientId: item.id.client });
          pos += item.length;
        }
        item = item.right;
      }
    } else if (child instanceof Y.XmlElement) {
      const creator = (child as unknown as YTypeInternals)._item?.id.client;
      const nodeType = schema.nodes[child.nodeName];
      if (nodeType?.isLeaf) {
        // Leaf nodes (image, horizontalRule, hardBreak) occupy one position.
        if (creator !== undefined) out.push({ from: pos, to: pos + 1, clientId: creator });
        pos += 1;
      } else {
        // Container: open tag, content, close tag. The structure itself is
        // attributed via its open-tag position so empty blocks stay blameable.
        if (creator !== undefined) out.push({ from: pos, to: pos + 1, clientId: creator });
        pos += 1; // open
        pos += walkChildren(child, pos, out);
        pos += 1; // close
      }
    }
  }
  return pos - start;
}

/** Merge adjacent spans from the same client into one. */
function mergeSpans(spans: BlameSpan[]): BlameSpan[] {
  const out: BlameSpan[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && last.clientId === span.clientId && last.to === span.from) {
      last.to = span.to;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}
