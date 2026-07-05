.PHONY: dev install migrate reset-db build test e2e pg lint help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev: .env node_modules migrate ## Start API (:3001) + web (:5173) together
	pnpm dev

.env: ## Create .env from the example if missing
	@test -f .env || (cp .env.example .env && echo "created .env")

node_modules: package.json ## Install dependencies when they change
	pnpm install
	@touch node_modules

install: ## Install dependencies
	pnpm install

migrate: .env ## Apply database migrations (PGlite dev DB by default)
	pnpm db:migrate

reset-db: ## Wipe and recreate the local PGlite dev database
	rm -rf .pglite && pnpm db:migrate

build: ## Production build (web bundle + typecheck)
	pnpm -r typecheck && pnpm --filter @tandem/web build

test: .env migrate ## Run unit/integration tests
	pnpm --filter @tandem/editor --filter @tandem/core --filter @tandem/server test

e2e: ## Run a browser e2e (usage: make e2e T=collab) — default smoke
	bash apps/web/e2e/run.sh $(or $(T),smoke)

e2e-all: ## Run the whole browser e2e suite against one booted stack (as CI does)
	bash apps/web/e2e/run-all.sh

pg: ## Start a local Postgres 18 (podman) for prod-like testing
	podman start tandem-pg 2>/dev/null || \
	  podman run -d --name tandem-pg -e POSTGRES_PASSWORD=postgres \
	    -e POSTGRES_USER=postgres -e POSTGRES_DB=tandem -p 5432:5432 \
	    docker.io/library/postgres:18
