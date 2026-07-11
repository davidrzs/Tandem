# Single-deployable image: one Node service hosting the tRPC API, Better Auth,
# Hocuspocus (/collab), the MCP endpoint (/mcp), and the built web SPA.
FROM node:22-bookworm-slim AS base
RUN npm install -g pnpm@11.8.0
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @tandem/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app /app
# Never root: the app writes only UPLOADS_DIR. Creating it here (owned by
# node) also seeds the named volume's ownership on first mount.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 3001
# Migrations run as a separate release step (see docker-compose `migrate`
# service / DEPLOY.md), not on start — safe for multiple instances.
CMD ["pnpm", "--filter", "@tandem/server", "exec", "node", "--import", "tsx", "src/serve.ts"]
