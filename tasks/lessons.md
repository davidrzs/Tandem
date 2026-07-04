# Lessons

One lesson per section. Update in place; delete anything that proves wrong.

## Hocuspocus v4 provider: explicit websocketProvider disables auto-attach
Passing `websocketProvider` to `new HocuspocusProvider(...)` sets
`manageSocket=false`: `provider.connect()` becomes a deprecated no-op and the
provider is never attached, so the connection silently stays "connecting".
Pass `url` (managed socket) instead; `autoConnect: false` is forwarded to the
internal websocket at runtime even though the provider config type doesn't
declare it (cast needed). `provider.destroy()` then also destroys the socket.

## React StrictMode + editor-held resources
Anything Tiptap extensions capture at editor creation (the Hocuspocus provider
for CollaborationCursor) must be created once in `useState(() => …)`, not
inside an effect. Handle StrictMode's mount/unmount/mount by
disconnect-on-cleanup + `setTimeout(destroy, 0)` that the immediate re-run
cancels. Creating the provider inside the effect (the previous pattern) breaks
once an extension needs the instance.

## Changing Y.Doc clientID mid-lifetime is safe if IDs are fresh
Server-side attributed edits set `doc.clientID` to a fresh random id inside the
synchronous transaction and restore it afterwards. Items read `doc.clientID`
at creation time, JS is single-threaded, and fresh ids can't collide with
existing clocks — this is the cleanest way to give every MCP edit its own
blame identity on a shared live doc.

## Hocuspocus hooks: transaction origin decides store context
Server-side `document.transact(...)` without an origin makes the next
debounced `onStoreDocument` run with an empty `lastContext` (store then fails
loud under RLS). Wrap server-side writes in
`{ source: "local", context }` origins so persistence keeps the acting user.
`onChange` fires only after `onLoadDocument` completes, so load-time seeding
can't be misattributed by the stamping hook.

## Attribution authority lives on the server, not the client
Clients never write the authors map; the `onChange` hook stamps unknown
clientIDs from the *authenticated connection* (first-write-wins). A writable
client can still vandalize the shared map (it's CRDT state) but cannot make
the server attribute its text to someone else at stamp time.

## prosemirror-markdown lists default to loose
Without `serialize(node, { tightLists: true })`, every list round-trips with
blank lines between items — and GitHub-style task lists (`- [ ]`) look wrong.
Tight/loose isn't represented in the PM document model, so serialization must
normalize it.

## Playwright in this repo
- `webServer.command` runs from repo root where `tsx` isn't resolvable; set
  `cwd: "apps/server"`.
- Accessible names include decorative glyphs (`▸ Handbook`), so `getByRole`
  with `exact: true` fails; use regexes or scope with `.locator(hasText)`.
- Hover-revealed row actions need an explicit `.hover()` on the parent row
  before clicking.
- The e2e server is the real single-process deployment (built SPA + in-memory
  PGlite) via `apps/server/src/e2e-serve.ts`; `buildHttpServer(db?)` accepts an
  injected db so migrations and the server share one PGlite instance.

## Typing "- [ ]" does not create a checkbox in Tiptap
The TaskItem input rule is `[ ] ` at line start ("- " first creates a bullet
list, inside which the marker stays literal). The markdown parser handles
`- [ ]` on import; in the editor, users type `[ ] ` or use the `/to-do` slash
command. Worth remembering when writing docs/tests.
