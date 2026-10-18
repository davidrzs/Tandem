# Single-deployable image: one Node service hosting the tRPC API, Better Auth,
# Hocuspocus (/collab), the MCP endpoint (/mcp), and the built web SPA.
# The server and its workspace packages are TypeScript run via tsx (a runtime
# dependency of @tandem/server and @tandem/db); there is no JS build step.
FROM node:22.23-bookworm-slim AS base
RUN npm install -g pnpm@11.8.0
WORKDIR /app

FROM base AS build
# Manifests first so the dependency layer is cached until they change.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/editor/package.json packages/editor/
RUN pnpm install --frozen-lockfile
COPY turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @tandem/web build
# Production-only node_modules for the server, workspace deps copied in.
# --legacy: the non-legacy deploy requires injectWorkspacePackages globally.
RUN pnpm --filter @tandem/server deploy --prod --legacy /out/server

FROM node:22.23-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app/apps/server
# http.ts serves ../../web/dist relative to apps/server/src.
COPY --from=build --chown=node:node /out/server /app/apps/server
COPY --from=build --chown=node:node /app/apps/web/dist /app/apps/web/dist
# Never root: the app writes only UPLOADS_DIR. Creating it here (owned by
# node) also seeds the named volume's ownership on first mount.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 3001
# serve.ts applies pending migrations on boot. With MIGRATE_ON_BOOT=0 (several
# instances), run them once per deploy as a release step instead (docker-compose
# `migrate` service / DEPLOY.md):
#   node --import tsx node_modules/@tandem/db/src/migrate-run.ts
CMD ["node", "--import", "tsx", "src/serve.ts"]
