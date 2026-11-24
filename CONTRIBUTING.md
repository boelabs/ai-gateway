# Contributing to AI Gateway

Thanks for your interest in contributing! This document explains how issues and pull requests are
handled, how to set up the project, and the conventions we follow. Roles and decision-making are in
[GOVERNANCE.md](GOVERNANCE.md).

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How contributions work

Work is accepted before it is written. This keeps review time for changes we actually want.

1. **Search first.** Check the open and closed issues and pull requests for the same problem or idea.
2. **Open an issue** with the [bug report](.github/ISSUE_TEMPLATE/bug_report.yml) or
   [feature request](.github/ISSUE_TEMPLATE/feature_request.yml) template. Typo fixes and one-line
   documentation fixes need an issue too; a maintainer accepts them quickly.
3. **Wait for the `accepted` label.** A maintainer adds it when the change fits the project's scope
   and direction. They may ask questions, propose a different approach, or decline with a reason.
   Do not start a pull request for an issue that is not accepted yet.
4. **Open a pull request** that implements the accepted issue. Fill in every section of the
   [pull request template](.github/PULL_REQUEST_TEMPLATE.md), including `Closes #<number>`.

### What the automation checks

The **PR policy** check runs on every pull request ([`pr-policy.yml`](.github/workflows/pr-policy.yml)):

- All template sections are present and filled in, and one type is ticked.
- The pull request links an issue. For pull requests from outside the maintainer team, that issue
  must carry the `accepted` label.

A pull request that fails the check is not reviewed until the check passes. Edit the description and
the check runs again.

### Scope and size

- **One issue and one concern per pull request.** Split unrelated changes into separate pull requests.
- **Keep it small.** Aim for a few hundred changed lines, excluding generated files such as
  `openapi.yaml`, `catalog.json` and migration snapshots. Larger changes need agreement in the issue
  first.
- **Respect the architecture.** Provider-specific fields never enter `core`, public contracts change
  only together with their tests and docs, and the rules in [AGENTS.md](AGENTS.md) §5 apply. Changes
  that break them will be declined.
- **Drafts are welcome** for early feedback. A draft is not reviewed until it is marked ready.

### Review

- All checks must pass before review: CI and the PR policy.
- A contributor's pull request is merged only after a maintainer approves it.
- Maintainers review on a best-effort basis; there is no fixed response time. Expect questions and
  requests for changes.
- We squash-merge every pull request. Commit history on your branch does not matter; the
  squashed commit message must be clear.
- A pull request with no activity from its author for 30 days may be closed. Reopen it at any time
  once it is ready.

### AI-assisted contributions

You may use any tools to write code. You are responsible for every line you submit: run the gates,
understand the change, and answer review questions yourself.

## Repository layout

This is a [Turborepo](https://turborepo.com) on [Bun](https://bun.sh) workspaces:

- `apps/api` — the AI Gateway service (runs on Bun).
- `apps/dashboard` — the optional operator dashboard (Next.js App Router, runs on Bun).
- `docs` — the documentation (MDX, English and Spanish), served by the gateway for boelabs.com.
- `packages/tsconfig` — shared TypeScript configuration.
- `packages/ai-sdk-provider` — the AI SDK provider, published to npm as `@boelabs/ai-sdk-provider`.

Dependencies, tasks, and both runtimes are Bun (with Turbo orchestrating the workspace). Bun runs
TypeScript directly, so the gateway has no build step; the dashboard is built by Next and served
from that build, still under Bun. Note: Bun's TLS may not accept self-signed
Postgres/Redis certificates — see the docs' Known errors page.

## Requirements

- Bun 1.4+ (gateway runtime, package manager, and task runner — runs TypeScript directly, no build step)
- Postgres 18+
- Redis 8+
- Docker (optional, for spinning up Postgres/Redis locally)

## Local setup

```bash
bun install
docker compose -f docker/compose.yaml -f docker/compose.local.yaml up -d postgres redis
cp apps/api/.env.example apps/api/.env    # then fill in the master key and encryption keyring
bun run --filter @boelabs/ai-gateway-api db:migrate
bun run --filter @boelabs/ai-gateway-api dev
```

Generate a 32-byte hex value for each `ENCRYPTION_KEYRING` entry with:

```bash
openssl rand -hex 32
```

## Before opening a pull request

Run the full local gate from the repo root. CI runs the same checks and will block the PR if any fail.

```bash
bun run check        # Biome format + lint (whole repo)
bun run typecheck    # turbo: TypeScript across the gateway and the dashboard
bun run test         # turbo: unit tests across packages
```

If your change touches database access, the router, rate limiting, or admin endpoints, also run the
integration suite (needs Postgres + Redis running):

```bash
bun run --filter @boelabs/ai-gateway-api test:integration
```

## Conventions

- **Language:** all code, comments, identifiers, commit messages, issues, pull requests, and
  documentation are written in **English**. Localized documentation (`*.es.mdx`) follows its own
  language.
- **Formatting & linting:** [Biome](https://biomejs.dev) is the single source of truth. Tabs for
  indentation, double quotes. Run `bun run check:fix` to auto-fix.
- **Types:** the shared config in `packages/tsconfig/base.json` is strict (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, etc.). Do not weaken it; prefer fixing the types.
- **Architecture:** keep the layering intact. Public request/response shapes live in
  `apps/api/src/contracts`, the provider-agnostic hub in `apps/api/src/core`, upstream
  protocols in `apps/api/src/adapters`, and HTTP handlers in `apps/api/src/endpoints`.
  Adapters translate to/from the canonical format — they never leak provider-specific fields into
  `core`. See the [glossary](docs/(api)/(reference)/glossary.mdx) for the canonical vocabulary.
- **Tests:** colocate unit tests next to the code as `*.test.ts`. Unit tests must not hit the network
  (`apps/api/tests/support/noRealFetch.ts` enforces this). Integration tests live under
  `apps/api/tests/integration`.
- **Database migrations:** the schema is `apps/api/src/db/schema.ts`. Run
  `bun run --filter @boelabs/ai-gateway-api db:generate` (drizzle-kit) to emit a migration after
  changing it, then `bun run --filter @boelabs/ai-gateway-api db:migrate` to apply. Migrations are
  forward-only — never edit an already-applied migration. Historical hand-tuned DDL remains immutable
  even after later migrations remove those structures.

## Adding a provider adapter

Each adapter is a self-contained folder under `apps/api/src/adapters/<provider>/`. Adding one
touches **four** files:

1. `src/adapters/<provider>/index.ts` — the adapter (often a few lines via `makeOpenAIStyleAdapter(...)`),
   exporting the adapter and a `ProviderModule`.
2. `src/adapters/<provider>/catalog.json` — the provider's model catalog.
3. `src/adapters/index.ts` — import the provider and add it to `PROVIDER_REGISTRATIONS` with its
   `catalogUrl`.
4. `scripts/validate-catalog.ts` — add the catalog to the validated list, **or CI won't check it**.

The catalog shape and a full step-by-step (including adding just a model to an existing provider) are
in the [model catalog guide](docs/(docs)/(providers)/model-catalog.mdx#adding-catalog-entries). Use
`POST /admin/deployments/resolve` to verify the effective capabilities and transports before wiring
tests. See the [deployments guide](docs/(docs)/(deploy)/creating-deployments.mdx).

Propose a new provider in a feature request first: the issue must be accepted before the adapter is
written.

## Commit messages

Use clear, imperative-mood messages (e.g. `add deepseek adapter`, `fix cooldown reset on success`).
Conventional Commit prefixes are welcome but not required. Pull requests are squash-merged, so the
pull request title becomes the commit subject: make it count.

## Security

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
