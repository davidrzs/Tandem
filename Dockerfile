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
RUN pnpm --filter @realtime/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3001
COPY --from=build /app /app
EXPOSE 3001
# Single-instance: migrate then serve. For multi-instance, run `pnpm db:migrate`
# as a separate release step and start with just the serve command.
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @realtime/server exec node --import tsx src/serve.ts"]
