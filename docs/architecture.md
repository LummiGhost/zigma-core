# Zigma Core Architecture

Version: 0.1

## Architecture decisions

- [ADR-0001: Parallel Development Execution Contract](adr/0001-parallel-development-execution-contract.md)
- [Cross-repository compatibility matrix and contract-test plan](compatibility-matrix.md)

ADR-0001 defines the published language, bounded-context ownership, invariants,
quality scenarios, and staged migration that govern parallel task execution
across Zigma Core, Zigma Flow, and Zigma Workspace.

## 1. Responsibility boundary

Zigma Core is the Zigma control plane. It owns durable platform state and coordination across long-lived tasks.

Core owns:

- Projects and repository bindings
- Execution profiles
- Tasks and task revisions
- Permission snapshots
- References to workspaces and flow runs
- Human Gate mirrors and decisions
- Evidence Bundles
- Audit events
- External API contracts

Core does not own:

- Workflow DAG interpretation
- Job and step state transitions
- Agent prompts
- Git worktree mechanics
- Build and test execution
- Code-hosting primitives
- Large artifact bytes

## 2. Layering

```text
src/contracts
  Stable public schemas, DTOs, and integration ports

src/domain
  Entity models, errors, and transition rules

src/application
  Use cases and orchestration through CoreService

src/persistence
  SQLite implementation of durable state

src/adapters
  zigma-flow and zigma-workspace CLI adapters

src/api
  HTTP transport

src/cli.ts
  Administration and local deployment entry point
```

Dependencies point inward. Domain and application code do not import CLI implementations.

## 3. Aggregate ownership

### Project aggregate

The Project aggregate defines defaults and constraints for task execution. Repository bindings are embedded because the MVP updates the project configuration as one unit.

### Task aggregate

Task is the long-lived platform aggregate. A Task can have multiple Flow Runs over its lifetime. `activeFlowRunId` identifies the current attempt. `revision` implements optimistic concurrency control.

### Flow Run aggregate

Flow Run mirrors a `zigma-flow` run at platform level. Core stores a status projection and external identifier. Core does not edit the flow engine's internal state.

### Human Gate aggregate

Human Gate mirrors a human step raised by a Flow Run. Decisions are immutable child records. A gate accepts at most one terminal decision. Delivery uses `decision_pending` and `decision_failed` intermediate states: Core only marks a gate `approved` or `rejected` after `zigma-flow` accepts the decision, and the same decision can be retried after a delivery failure.

### Evidence Bundle aggregate

One bundle is created per Flow Run. Evidence Items remain append-only while the bundle is open. Finalization freezes the bundle summary, risk list, and conclusions.

## 4. Consistency model

SQLite transactions protect local aggregate updates. The execution adapters are external side effects, so Core uses a state-first sequence:

1. Persist Task, Permission Snapshot, Flow Run, and open Evidence Bundle.
2. Persist provisioning state.
3. Request workspace preparation.
4. Persist Workspace Ref.
5. Persist Flow Run starting state.
6. Invoke the workflow.
7. Persist the returned result or a structured integration failure.

This sequence preserves enough state to diagnose partial failures. Future asynchronous execution should use an outbox table so external commands can be retried independently.

## 5. Idempotency

Flow callback events use a globally unique `eventId`. The SQLite adapter stores events with `INSERT OR IGNORE`, making repeated callback delivery safe.

Human Gates use a unique `(flow_run_id, external_gate_id)` key, and decisions use a unique `gate_id` key so retries reuse the persisted decision instead of creating duplicates.

Project keys and execution profile names are unique.

Task mutations use `revision` as an optimistic lock.

## 6. Permission model

Caller Context is validated at task start, then copied into an immutable Permission Snapshot.

A snapshot contains:

- Actor identity
- Explicit capabilities
- Repository scope
- Workflow scope
- Tool scope
- Branch constraints
- Run duration limit
- Expiration
- Source identity
- SHA-256 integrity hash

Permission changes during a run do not mutate the snapshot. A new authorization decision creates a new task attempt and snapshot.

The current MVP enforces task start, workflow invocation, workspace creation, workspace write, gate approval, and gate rejection capabilities. Tool constraints are carried in the contract and should be enforced by execution hosts and future policy adapters.

Core also enforces the caller's branch constraint at start admission. Branch
patterns use whole-string glob matching (`*` matches any sequence, including
`/`; `?` matches one character); an empty list means unrestricted. The local
runtime currently fails closed for unsupported execution profile modes and
workspace policies rather than treating them as local behavior. M0 supports
only `local-cli`, `cleanup: "manual"`, and `snapshotOnTerminal: true`.

## 7. Failure handling

Integration failures are represented with stable Core error codes and persisted on Task and Flow Run records.

Terminal statuses are immutable, except a failed Task can be queued for a new attempt. Completed and cancelled tasks cannot restart in the MVP.

Workspace evidence collection occurs after a synchronous adapter result. Evidence collection failure currently fails the start operation. A later version should separate execution status from evidence collection status through an outbox and reconciliation worker.

## 8. Deployment model

The MVP supports a single Core process with a local SQLite database. WAL mode permits concurrent reads while one writer transaction is active.

The intended platform evolution is:

1. Local Core process and SQLite

The baseline runtime is Node.js 22 with the built-in `node:sqlite` driver. A `better-sqlite3` implementation may be added later as an optional adapter; it is deliberately not required by or bundled with the MVP.
2. Persistent Core service and PostgreSQL
3. Asynchronous execution host protocol
4. Multi-tenant organization and policy service
5. High-availability control plane
