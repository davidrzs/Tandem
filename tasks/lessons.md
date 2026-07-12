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

## A CSS keyframe transform REPLACES the element's own transform
`.modal` centred with `transform: translateX(-50%)` + an entrance animation
whose `from` frame only set `translateY/scale` made every dialog slide in
~290px from the right: during the animation the element's base transform is
gone. Keyframes on positioned elements must repeat the positioning transform
in every frame. (This was also the root cause of "clicks near dialog-open get
dropped" e2e flakes — Playwright aimed at pre-slide coordinates.)

## Fastify + tRPC batching needs maxParamLength
fastifyTRPCPlugin routes `/trpc/:path` where `:path` is every batched
procedure name comma-joined. Fastify's default maxParamLength is 100; the
moment a page batches enough queries the whole batch 404s (and react-query's
retries make the app feel broken/slow). Set `maxParamLength: 5000` on the
Fastify instance. Symptom to remember: 404s on /trpc URLs answered in <1ms.

## Controlled checkboxes can silently drop clicks
A checkbox whose `checked` comes from async state (react-query cache) reverts
the native flip synchronously and re-applies it a microtask later — automation
and fast users hit the revert window and the click is lost. Prefer a
`role="switch"` button + local state set inside the click handler (flushed
synchronously); disable it while the save is in flight so a reload can't race
persistence.

## Keyed-editor swap: don't type into the old instance (e2e)
After navigating between documents, `.title-input` still resolves to the OLD
doc's input until React swaps the keyed Editor. A fill() in that window
renames the wrong document (server logs proved it: the mutation carried the
old doc's id). Before typing into a swap-sensitive field, assert its expected
value first (`toHaveValue("")` for a new doc).

## Test users accumulate access across a shared-db test file
core.test.ts shares one PGlite db; "u2"/"u3" join u1's workspace in earlier
tests. A later test needing an outsider must provision a FRESH user id, or
RLS assertions pass/fail depending on test order (and -g isolation lies).

## "Flaky on fast machines" can be a rate limit
The web e2e suite failed a rotating spec ~50% of the time on a fast machine,
always in the back half of the alphabetical order. Root cause: 19 specs each
sign up fresh users from 127.0.0.1 and the sign-up limit is 10/min — the 11th
signup inside a minute got 429 and the spec hung at the auth screen. Speeding
the suite up (the maxParamLength fix) made it WORSE. Diagnose by logging page
`response` events (the 429 was invisible in assertions); fix with an explicit
DISABLE_RATE_LIMITS=1 escape hatch in the harnesses, never by weakening the
production limit.
