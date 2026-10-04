SHELL := /bin/bash
SHELLFLAGS := -eu -o pipefail -c

.DEFAULT_GOAL := help

NODE_VERSION := 22.23.2
PNPM_VERSION := 9.15.5
PROD_ENV ?= .env.production.example
PROD_COMPOSE := docker compose --env-file $(PROD_ENV) -f docker-compose.prod.yml

.PHONY: help doctor install \
	dev-web dev-api dev-worker infra-up infra-down infra-ps infra-logs \
	db-generate build-internal \
	test-api test-worker test \
	lint-api lint-worker lint-web lint \
	build-web build build-all \
	db-validate db-status db-migrate-deploy \
	check ci \
	prod-config prod-build prod-ps prod-logs

help: ## Show available commands.
	@printf '%s\n' \
	  'Docs Hub commands' \
	  '' \
	  'Setup:' \
	  '  install              Install locked workspace dependencies.' \
	  '  doctor               Verify required tool versions.' \
	  '  db-generate          Generate the Prisma client.' \
	  '' \
	  'Development:' \
	  '  dev-web              Start the web development server.' \
	  '  dev-api              Start the API in watch mode.' \
	  '  dev-worker           Start the worker in watch mode.' \
	  '  infra-up|down|ps     Manage local development infrastructure.' \
	  '  infra-logs           Follow local development infrastructure logs.' \
	  '' \
	  'Testing:' \
	  '  test-api|test-worker Run API or worker tests.' \
	  '  test                 Run API then worker tests.' \
	  '' \
	  'Validation:' \
	  '  lint                 Lint API, worker, and web.' \
	  '  build                Run the repository build.' \
	  '  build-all            Build internal dependencies, then CI application builds.' \
	  '  check                Run normal local validation.' \
	  '  ci                   Approximate the CI validation job (no deployment).' \
	  '' \
	  'Database:' \
	  '  db-validate          Validate the Prisma schema (caller DATABASE_URL or .env).' \
	  '  db-status            Show migration status for DATABASE_URL.' \
	  '  db-migrate-deploy    Apply forward migrations to DATABASE_URL.' \
	  '' \
	  'Production configuration:' \
	  '  prod-config          Validate production Compose config (PROD_ENV=path).' \
	  '  prod-build           Build production Compose images locally.' \
	  '' \
	  'Operations:' \
	  '  prod-ps              Show production Compose service status.' \
	  '  prod-logs SERVICE=x  Follow logs for one production Compose service.'

doctor: ## Verify required local tools and pinned Node/pnpm versions.
	@command -v node >/dev/null || { echo 'node is required (expected $(NODE_VERSION)).' >&2; exit 1; }
	@command -v pnpm >/dev/null || { echo 'pnpm is required (expected $(PNPM_VERSION)).' >&2; exit 1; }
	@command -v docker >/dev/null || { echo 'docker is required.' >&2; exit 1; }
	@node_version="$$(node --version | sed 's/^v//')"; \
	  pnpm_version="$$(pnpm --version)"; \
	  docker_version="$$(docker --version)"; \
	  compose_version="$$(docker compose version)"; \
	  printf 'node: %s\n' "$$node_version"; \
	  printf 'pnpm: %s\n' "$$pnpm_version"; \
	  printf 'docker: %s\n' "$$docker_version"; \
	  printf 'docker compose: %s\n' "$$compose_version"; \
	  [ "$$node_version" = '$(NODE_VERSION)' ] || { echo 'Expected Node $(NODE_VERSION), found' "$$node_version" >&2; exit 1; }; \
	  [ "$$pnpm_version" = '$(PNPM_VERSION)' ] || { echo 'Expected pnpm $(PNPM_VERSION), found' "$$pnpm_version" >&2; exit 1; }

install: ## Install locked workspace dependencies.
	pnpm install --frozen-lockfile

dev-web: ## Start the web development server.
	pnpm dev:web

dev-api: ## Start the API in watch mode.
	pnpm dev:api

dev-worker: ## Start the worker in watch mode.
	pnpm dev:worker

infra-up: ## Start local development infrastructure.
	pnpm infra:up

infra-down: ## Stop local development infrastructure.
	pnpm infra:down

infra-ps: ## Show local development infrastructure status.
	pnpm infra:ps

infra-logs: ## Follow local development infrastructure logs.
	pnpm infra:logs

db-generate: ## Generate the Prisma client.
	pnpm --filter @dochub/database exec prisma generate

build-internal: ## Build workspace packages required by clean-environment tests.
	pnpm -r --filter '@dochub/trash...' build

test-api: ## Run API tests.
	pnpm --filter api test

test-worker: ## Run worker tests.
	pnpm --filter worker test

test: ## Run API then worker tests.
	$(MAKE) test-api
	$(MAKE) test-worker

lint-api: ## Lint the API.
	pnpm --filter api lint

lint-worker: ## Lint the worker.
	pnpm --filter worker lint

lint-web: ## Lint the web app.
	pnpm --filter web lint

lint: ## Lint all applications.
	$(MAKE) lint-api
	$(MAKE) lint-worker
	$(MAKE) lint-web

build-web: ## Build the web app.
	pnpm --filter web build

build: ## Run the repository build.
	pnpm build

build-all: ## Run the application-build portion of CI.
	$(MAKE) build-internal
	pnpm -r --filter '!@dochub/database' --filter '!@dochub/storage' --filter '!@dochub/trash' build

db-validate: ## Validate the Prisma schema without connecting to a database.
	@if [ -z "$${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; source ./.env; set +a; fi; \
	  pnpm --filter @dochub/database exec prisma validate

db-status: ## Show migration status for DATABASE_URL.
	pnpm --filter @dochub/database exec prisma migrate status

db-migrate-deploy: ## Apply forward migrations to DATABASE_URL.
	@echo 'Applying forward Prisma migrations to DATABASE_URL.'
	pnpm --filter @dochub/database exec prisma migrate deploy

check: ## Run normal local validation.
	$(MAKE) doctor
	$(MAKE) build-internal
	$(MAKE) test
	$(MAKE) lint
	$(MAKE) build
	$(MAKE) db-validate
	git diff --check

ci: ## Approximate CI validation; never deploy.
	$(MAKE) doctor
	$(MAKE) build-internal
	$(MAKE) test
	$(MAKE) lint
	pnpm -r --filter '!@dochub/database' --filter '!@dochub/storage' --filter '!@dochub/trash' build
	$(MAKE) db-validate
	git diff --check

prod-config: ## Validate production Compose configuration using PROD_ENV.
	$(PROD_COMPOSE) config -q

prod-build: ## Build production Compose images locally using PROD_ENV.
	$(PROD_COMPOSE) build

prod-ps: ## Show production Compose service status using PROD_ENV.
	$(PROD_COMPOSE) ps

prod-logs: ## Follow logs for one production service; require SERVICE=name.
	@test -n "$(SERVICE)" || { echo 'SERVICE is required (example: make prod-logs SERVICE=api).' >&2; exit 2; }
	$(PROD_COMPOSE) logs --follow --tail=100 "$(SERVICE)"
