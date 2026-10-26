# CLAUDE.md

@AGENTS.md

AGENTS.md defines the repository workflow. The reference below describes module boundaries.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck      # type-check without emitting
npm test               # run all tests once (Vitest)
npm run test:watch     # run tests in watch mode
npm run build          # compile TypeScript → dist/
npm run check          # full gate: typecheck + build + test
```

Run a single test file:
```bash
npx vitest run tests/core-service.test.ts
```

Start the HTTP server (requires a prior build):
```bash
node dist/cli.js --db .zigma-core/core.db serve --host 127.0.0.1 --port 4736
```

## Architecture

Zigma Core is the **control plane** for the Zigma platform. It owns the lifecycle of Projects, Tasks, FlowRuns, HumanGates, PermissionSnapshots, EvidenceItems, and AuditEvents. It talks to two external services — `zigma-flow` (executes agent runs) and `zigma-workspace` (prepares Git worktrees) — via CLI adapters, and exposes everything over a Fastify HTTP API and a Commander.js admin CLI.

The code is organized in a clean-architecture style where dependencies point inward:

```
contracts  ←  domain  ←  application  ←  persistence
                                      ←  adapters
                                      ←  api
                                      ←  cli.ts
```

| Layer | Path | Responsibility |
|---|---|---|
| **Contracts** | `src/contracts/` | Zod schemas, TypeScript types, and port interfaces (`FlowExecutor`, `WorkspaceProvider`, `Clock`, `IdGenerator`) |
| **Domain** | `src/domain/` | Entity interfaces (`models.ts`) and status-transition validators (`state-machines.ts`) |
| **Application** | `src/application/core-service.ts` | Single `CoreService` class that orchestrates all business logic (~870 lines) |
| **Persistence** | `src/persistence/sqlite-store.ts` | SQLite via Node.js built-in `node:sqlite` (WAL mode, FK enforcement, synchronous API) |
| **Adapters** | `src/adapters/` | `LocalCliFlowExecutor` (execa → zigma-flow) and `ZigmaWorkspaceCliAdapter` (execa → zigma-workspace) |
| **API** | `src/api/server.ts` | Fastify 5 HTTP server; routes for profiles, projects, tasks, flow events, human gates, evidence |
| **CLI** | `src/cli.ts` | Commander.js admin commands for all entities |

`CoreService` depends on four ports injected at construction time: `FlowExecutor`, `WorkspaceProvider`, `Clock`, and `IdGenerator`. Tests provide fake implementations of all four — see `tests/core-service.test.ts` for the pattern.

## Key design constraints

- **Node.js ≥ 22.5 required** — uses the built-in `node:sqlite` module (no better-sqlite3 or libsql).
- **ESM only** (`"type": "module"` in package.json). All imports must use `.js` extensions pointing at the compiled output.
- **Zod 4** is used for all schema validation; the API has not been migrated to any v3 compatibility shim.
- `SqliteStore` uses the synchronous `DatabaseSync` API — no async/await in persistence code.
- `HumanDecision` and `PermissionSnapshot` rows are **immutable** once written; never update them.
- Versioned FlowEvent callbacks are **idempotent by event ID and content**. Replaying the same event is a no-op; reusing its ID with different content or sending a noncontiguous sequence is rejected. Distinct events may legitimately share a status.
- State transitions are enforced by `src/domain/state-machines.ts` before any DB write.
