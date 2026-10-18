# Deploy (VPS + Docker + Neon)

One Node service (tRPC API, Better Auth, Hocuspocus `/collab`, MCP `/mcp`, and
the web SPA) behind Caddy (auto-TLS + WebSockets), with Postgres on Neon.

## Prerequisites
- A VPS with Docker + Docker Compose.
- A domain with an A record pointing at the VPS (Caddy issues TLS for it).
- A Neon Postgres database.

## 1. Neon
1. Create a project + database; copy the connection string into `DATABASE_URL`
   (keep `?sslmode=require`).
2. The migration creates a non-login `app_user` role and `GRANT app_user TO
   current_user`, so the connecting role can `SET LOCAL ROLE app_user` (used for
   RLS-scoped requests). The connecting role owns the tables it creates, so the
   `SYSTEM` actor (signup provisioning, invites) bypasses RLS while `app_user`
   stays enforced — no superuser or `BYPASSRLS` needed.
   - Neon roles can `CREATE ROLE` by default; if `CREATE ROLE app_user` is ever
     rejected, create it once as an admin: `CREATE ROLE app_user NOLOGIN;`.
3. Search migrations enable PostgreSQL's trusted `pg_trgm` extension. If your
   migration role cannot create extensions, run `CREATE EXTENSION pg_trgm;`
   once as the database owner before applying Tandem migrations.

## 2. Configure env
```bash
cp .env.deploy.example .env.deploy
# edit DOMAIN, DATABASE_URL, BETTER_AUTH_SECRET (openssl rand -base64 32),
# BETTER_AUTH_URL=https://<domain>, WEB_ORIGIN=https://<domain>
# optional: SMTP_URL + EMAIL_FROM (see "Email" below)
```

## 3. Start
```bash
docker compose --env-file .env.deploy up -d --build
```
The app applies pending migrations on boot, before it serves. Running several
instances? Set `MIGRATE_ON_BOOT=0` and run the release step once per deploy
instead: `docker compose --env-file .env.deploy --profile release run --rm migrate`.

Rate limits key on the client IP from `X-Forwarded-For`. `TRUST_PROXY` is the
number of proxies in front of the app: 1 for this compose (Caddy) or a platform
proxy like Traefik alone, 2 for Traefik in front of Caddy, 0 if the app port is
exposed directly.
Caddy obtains a certificate for `$DOMAIN` automatically and reverse-proxies to
the app (WebSockets upgrade transparently, so `/collab` works over `wss://`).

## 4. Updates
```bash
git pull
docker compose --env-file .env.deploy up -d --build
```
Some migrations rewrite a table under an exclusive lock — `0024` retypes
`documents.updated_at` to millisecond precision, which rewrites every row and
index of `documents`. Collaboration saves pause for the duration: seconds on a
wiki-sized table, but run it in a quiet moment on a large one.

## First run
The first visit to a fresh instance shows the setup wizard: it creates the
server administrator and sets the registration policy (invite-only by default
is a good choice). Everything is changeable later under the sidebar's Admin
entry — registration mode, allowed email domains, server invites, users.

## Restore drill (do this once before you rely on backups)
1. In Neon, create a branch (or point-in-time restore) of the database.
2. Point a scratch `.env.deploy` at the branch and boot a second app container.
3. Confirm documents open and history/blame render (content lives in
   `documents.ydoc_state`; if that column restores, everything does).
4. Copy a few files out of the `uploads` volume (`docker compose cp
   app:/data/uploads /tmp/check`) and confirm images load on the scratch
   instance. Uploaded bytes are NOT in Postgres — back up this volume
   (e.g. nightly `docker run --rm -v tandem_uploads:/u -v /backup:/b alpine
   tar czf /b/uploads-$(date +%F).tgz -C /u .`).

## Email (optional but recommended)
Set `SMTP_URL` (`smtp://user:pass@host:587`, `smtps://…:465` for implicit TLS)
and `EMAIL_FROM` (`Tandem <tandem@example.com>`). With email configured:
- users get a **"Forgot your password?"** flow on the login screen;
- invites addressed to an email (workspace and server invites) are
  **delivered by email** as well as shown as a copy-link.

Without SMTP, invites are copy-link only and a locked-out user needs a server
admin to set a new password (Admin → user → set password). A half-configured
instance (SMTP_URL without EMAIL_FROM) refuses to boot.

## Notes
- **Rate limits** are in-memory and per-instance: they reset on restart and
  aren't shared across replicas. Fine for the single-node deploy this compose
  file describes; add a Redis-backed store if you ever run multiple app
  instances.
- **MCP clients** point at `https://<domain>/mcp`; OAuth discovery lives at
  `https://<domain>/.well-known/oauth-authorization-server` (Better Auth).
- **Scaling past one instance:** add Redis + `@hocuspocus/extension-redis` so
  Yjs updates broadcast across instances, and set `MIGRATE_ON_BOOT=0` with the
  release step from section 3 so instances don't race to migrate on boot.
  Caddy can load-balance, but sticky sessions aren't required (Hocuspocus
  syncs via Redis).
- **Backups:** Neon handles Postgres backups/branching. Document content lives
  in `documents.ydoc_state` (+ derived `content_md`). Uploaded image bytes live
  on the `uploads` Docker volume (`UPLOADS_DIR=/data/uploads`) — include that
  volume in backups; it survives rebuilds/redeploys.
