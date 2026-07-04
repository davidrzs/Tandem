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

## 2. Configure env
```bash
cp .env.deploy.example .env.deploy
# edit DOMAIN, DATABASE_URL, BETTER_AUTH_SECRET (openssl rand -base64 32),
# BETTER_AUTH_URL=https://<domain>, WEB_ORIGIN=https://<domain>
```

## 3. Migrate, then start
```bash
# release step — run once per deploy, before (re)starting instances
docker compose --env-file .env.deploy --profile release run --rm migrate

# build + start app and caddy
docker compose --env-file .env.deploy up -d --build
```
Caddy obtains a certificate for `$DOMAIN` automatically and reverse-proxies to
the app (WebSockets upgrade transparently, so `/collab` works over `wss://`).

## 4. Updates
```bash
git pull
docker compose --env-file .env.deploy --profile release run --rm migrate
docker compose --env-file .env.deploy up -d --build
```

## Notes
- **MCP clients** point at `https://<domain>/mcp`; OAuth discovery lives at
  `https://<domain>/.well-known/oauth-authorization-server` (Better Auth).
- **Scaling past one instance:** add Redis + `@hocuspocus/extension-redis` so
  Yjs updates broadcast across instances; migrations are already a separate
  release step, so multiple app instances are safe. Caddy can load-balance, but
  sticky sessions aren't required (Hocuspocus syncs via Redis).
- **Backups:** Neon handles Postgres backups/branching. Document content lives
  in `documents.ydoc_state` (+ derived `content_md`). Uploaded image bytes live
  on the `uploads` Docker volume (`UPLOADS_DIR=/data/uploads`) — include that
  volume in backups; it survives rebuilds/redeploys.
