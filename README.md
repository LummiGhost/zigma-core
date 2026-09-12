# Zigma Core

Zigma Core is the control plane of the Zigma platform. It owns long-lived project and task state, run-level permission snapshots, workspace and flow references, human approvals, evidence bundles, and audit events.

The MVP is contract-first. Domain contracts are exported as TypeScript types and Zod schemas, while integrations with `zigma-flow` and `zigma-workspace` are isolated behind ports.

## Current scope

The MVP includes:

- Project and execution profile registration
- Task lifecycle and optimistic revision control
- Immutable permission snapshots
- `zigma-workspace` CLI integration
- `zigma-flow` CLI integration
- Human Gate registration and decisions
- Evidence Bundle collection and finalization
- Append-only audit events
- SQLite persistence
- HTTP API and administration CLI

Distributed execution, organization membership, policy languages, mail ingestion, Web UI, and native code-hosting services remain outside the MVP.

## Requirements

- Node.js 22.5 or newer
- `zigma-flow` available on `PATH` for real workflow execution
- `zigma-workspace` available on `PATH` when a project uses the workspace CLI provider

The MVP standardizes on Node.js 22 and uses the built-in `node:sqlite` module. `better-sqlite3` remains a possible optional adapter for deployments that need its native implementation, but it is not a runtime dependency and the MVP does not migrate to it. Persistence remains isolated in `SqliteStore` so a later adapter can preserve the application and API contracts.

## Development

```bash
npm install
npm run check
```

### Real provider-contract gate

The ordinary unit suite skips the real-provider file when sibling source
checkouts are unavailable. The dedicated gate rebuilds those checkouts first,
then injects their absolute CLI paths into Vitest; it never accepts a stale
provider `dist/` from `PATH`.

```bash
$env:ZIGMA_FLOW_REPO = 'D:\zigma\zigma-flow'
$env:ZIGMA_WORKSPACE_REPO = 'D:\zigma\zigma-workspace'
npm run test:m0-cross-repo
```

It proves the Flow `CallerContextV1` is accepted and frozen, and that Core
rejects unknown provider versions and workspace artifact bytes whose `sha256`
does not match the emitted `file:` URI. CI checks out the public handshake
commits before running this same command.

The M4 gate runs the full managed lifecycle against real Core/Flow/Workspace
processes:

```bash
$env:ZIGMA_FLOW_REPO = 'D:\zigma\zigma-flow'
$env:ZIGMA_WORKSPACE_REPO = 'D:\zigma\zigma-workspace'
npm run test:m4-cross-repo
```

It covers parallel dispatch with per-run execution metrics, external-commit
merge-conflict rollback, cancel + abort quiescence with per-result retention,
restart recovery in two crash windows, worker-kill fail-safe, and
single-writable admission invariants. Evidence and the pinned provider commits
are recorded in `docs/m4-results.md`.

## Run the API

```bash
npm run build
node dist/cli.js --db .zigma-core/core.db serve --host 127.0.0.1 --port 4736
```

Health check:

```bash
curl http://127.0.0.1:4736/health
```

## Bootstrap through the CLI

Create an execution profile:

```bash
zigma-core --db .zigma-core/core.db profile create \
  --file examples/execution-profile.json
```

Create a project after replacing `executionProfileId` in the example:

```bash
zigma-core --db .zigma-core/core.db project create \
  --file examples/project.json
```

Create and start a task after replacing referenced IDs:

```bash
zigma-core --db .zigma-core/core.db task create --file examples/task.json
zigma-core --db .zigma-core/core.db task start <task-id> --file examples/start-task.json
```

## Architecture

The application core depends on two execution ports:

```text
HTTP API / CLI
      |
  CoreService
      |
      +-- SqliteStore
      +-- FlowExecutor
      +-- WorkspaceProvider
```

`CoreService` owns platform state transitions. `zigma-flow` continues to own workflow, job, and step transitions. `zigma-workspace` continues to own Git worktree and workspace mechanics.

See:

- `docs/prd.md`
- `docs/architecture.md`
- `docs/api-contracts.md`
- `docs/integration-contracts.md`
