# ADR-0001: Parallel Development Execution Contract

- Status: Accepted
- Date: 2026-09-01
- Decision owner: Zigma Core
- Component owners: Zigma Core, Zigma Flow, Zigma Workspace
- Parent milestone: `LummiGhost/zigma-core#9`
- Implementation issue: `LummiGhost/zigma-core#12`

## 1. Context and confirmed drivers

Zigma already has three independently versioned components with distinct runtime
responsibilities:

- Core persists platform tasks, permissions, projections, human decisions,
  evidence references, and audit records.
- Flow interprets workflow DAGs and exclusively advances job, step, attempt, and
  run state.
- Workspace creates and records Git worktrees, repository caches, locks,
  snapshots, and cleanup outcomes.

Flow can execute ready jobs concurrently inside one run. Core currently invokes
Flow and Workspace synchronously from one local process, and Workspace currently
publishes path policy in a manifest without making that manifest a process
sandbox. Therefore Flow-level parallelism is not yet equivalent to safe,
recoverable parallel development across tasks.

The platform needs a contract that lets M1 through M4 evolve independently
without changing the meaning of task state, capacity, cancellation, or
workspace isolation.

### Architecture methods

Primary methods:

- Domain-driven design: the main risk is semantic drift among three bounded
  contexts that use related identifiers and lifecycle terms.
- Quality-attribute design: concurrency safety, recovery, isolation, and
  operability require measurable scenarios rather than feature statements.

Supporting methods:

- Incremental migration: the current CLI adapters and SQLite deployment must
  remain usable while durable asynchronous execution is added.
- Event-driven integration: future execution commands and callbacks need
  at-least-once delivery and idempotency, but do not require CQRS or event
  sourcing.

Rejected for this milestone:

- Microservices: independent processes already provide replaceable adapters;
  distributed deployment is not required to prove reliable local parallelism.
- Event sourcing: append-only audit evidence is required, but replaying all
  platform state from events is not.
- A shared cross-repository runtime package: shared code would couple release
  cadence. Versioned published contracts are the integration boundary.

## 2. Decision

Parallel development is admitted and coordinated by Core. Each admitted
writable task attempt receives a distinct Workspace. Flow may execute work only
inside the Workspace bound to that invocation. Each component remains the sole
writer of its owned state and publishes a versioned machine contract at its
boundary.

M0 defines the published language and invariants. M1 through M4 implement and
prove them.

## 3. Published language

| Term | Canonical meaning | Authority |
| --- | --- | --- |
| Project | Platform configuration that binds repositories, defaults, an execution profile, and workspace policy. | Core |
| Task | Long-lived user intent. A Task may have multiple sequential attempts but at most one active Flow Run. | Core |
| Flow Run | Core's durable projection of one task attempt. It references, but does not replace, the Flow-owned run. | Core |
| Flow runtime run | The authoritative workflow, job, step, attempt, signal, and artifact lifecycle. | Flow |
| Execution Command | Durable intent to provision, start, resume, cancel, reconcile, or collect evidence. Introduced by M2. | Core |
| Invocation | One accepted delivery of an Execution Command to Flow or Workspace, identified by an idempotency key. | Provider component |
| Workspace | Filesystem and Git context assigned to one task attempt. A writable Workspace is never shared by concurrent task attempts. | Workspace |
| Lease | Time-bounded ownership of capacity or a Workspace lock. Expiration permits reconciliation, not silent ownership transfer. | Core for capacity; Workspace for workspace lock |
| Capacity | Configured upper bound for admitted active work at global, project, repository, and backend scopes. | Core |
| Admission | Atomic Core decision to reserve all applicable capacity or leave the task queued with a reason. | Core |
| Cancellation request | Intent to stop new work and propagate cancellation. It is not proof that child work has stopped. | Core |
| Cancelled result | Terminal provider acknowledgement after owned work is stopped and required state/evidence is durably recorded. | Flow or Workspace, projected by Core |
| Reconciliation | Comparison of durable intent, provider state, leases, and side effects after timeout, duplicate delivery, or restart. | Core coordinates; each provider reports its owned state |
| Evidence | Immutable or content-addressed reference proving execution or workspace outcomes. Large bytes remain outside Core. | Producing component; Core owns the evidence index |

Identifiers are opaque strings. Callers must not derive a Flow run ID,
Workspace ID, branch, path, or idempotency key from another identifier unless a
versioned provider contract explicitly defines that mapping.

## 4. Bounded contexts and dependency rules

```text
                       admission / durable intent
                                  |
                                  v
                            Zigma Core
                         /              \
          invocation + callbacks      workspace operations
                       /                  \
                      v                    v
                Zigma Flow          Zigma Workspace
              runtime state         filesystem/Git state
```

### Core owns

- Project, Task, Flow Run projection, Execution Profile, capacity reservation,
  Execution Command, Permission Snapshot, Human Gate and Decision, Evidence
  Bundle, and platform Audit Event.
- Admission order and the reason a task remains queued.
- Correlation among task, command, invocation, Flow run, and Workspace.

Core must not edit Flow job or step state, infer Workspace cleanup from a
process exit code alone, or scan a Workspace as a substitute for provider
evidence.

### Flow owns

- Workflow validation and DAG scheduling.
- Job, step, attempt, iteration, gate, and runtime-run state.
- In-run parallelism, fail-fast behavior, cancellation propagation, child
  process completion, and Flow artifacts/events.

Flow must not admit platform tasks, allocate repository capacity, create a
second writable Workspace for an invocation, or mutate Core state except
through the versioned callback contract.

### Workspace owns

- Repository mirror/cache, worktree, Workspace manifest and path, Workspace
  lifecycle, lock/lease, diff, snapshot, reconciliation report, and cleanup
  result.
- Filesystem facts required to distinguish removed, retained, orphaned, and
  partially cleaned workspaces.

Workspace must not advance Task or Flow state. A manifest or database lock is
coordination metadata; M3 must pair it with execution-boundary path
enforcement before it is treated as an isolation control.

### Integration pattern

Core is the upstream orchestrator. Flow and Workspace expose an open host
service through versioned CLI/JSON contracts today and may expose a library or
service adapter later. Each Core adapter is an anti-corruption layer: provider
status and errors are translated into Core projections without copying the
provider's internal state machine.

## 5. System invariants

1. **One active attempt:** a Task has at most one non-terminal Flow Run.
2. **One writable Workspace per attempt:** every admitted writable attempt has
   exactly one bound Workspace before Flow starts.
3. **No concurrent writable sharing:** two active task attempts never write the
   same Workspace. The default repository admission limit is one writable
   attempt until a project explicitly opts into a higher limit.
4. **All scopes reserve atomically:** an attempt starts only when global,
   project, repository, and backend capacity are all available. Partial
   reservations are rolled back.
5. **Engine owns runtime state:** only Flow advances job, step, attempt, and
   runtime-run state.
6. **Provider owns side-effect truth:** Core stores projections and references;
   it does not fabricate provider completion after a timeout.
7. **At-least-once, idempotent boundaries:** every side-effecting invocation
   carries an operation or command id. Repeating the same id and same input
   returns the same logical result; reusing it with different input fails.
8. **Cancellation is two-phase:** requested and acknowledged are distinct.
   Capacity is not released until provider termination is acknowledged or
   reconciliation records a bounded, operator-visible exception.
9. **Terminal means quiescent:** a cancelled or completed Flow invocation has
   stopped its child processes and flushed owned state/event writers.
10. **Immutable decisions and evidence:** Permission Snapshots, Human Decisions,
    Audit Events, and finalized Evidence Items are append-only.
11. **Cleanup is factual:** a Workspace is `cleaned` only when removal is
    confirmed. Partial cleanup remains recoverable and retains diagnostic data.
12. **Version negotiation fails closed:** an unsupported contract version or
    capability combination is rejected before external side effects.

## 6. Capacity and admission policy

Every Execution Profile will expose normalized capacity policy in M0.2:

- `global`: maximum active task attempts for the profile.
- `perProject`: maximum active attempts for one Project.
- `perRepository`: maximum active attempts touching one repository.
- `perBackend`: maximum active Flow invocations for one backend.
- `writablePerRepository`: maximum active writable attempts for one repository;
  the backward-compatible default is `1`.

All limits are positive integers. A missing field receives a documented finite
default; `null` and magic values such as `0` or `-1` never mean unlimited.
Higher-level limits may be larger or smaller than lower-level limits without
being contradictory because they protect different shared resources.

Admission is FIFO within equal priority for M2. Priority may choose among
queued tasks, but cannot bypass a scope whose capacity is exhausted. Capacity
is associated with a lease so a dead worker can be reconciled without
permanently consuming a slot.

## 7. Integration and failure semantics

### Delivery

- Core persists intent before invoking a provider.
- Provider commands and callbacks use at-least-once delivery.
- The tuple of contract version, operation id, operation type, and canonical
  input hash defines idempotency.
- A response lost after a successful side effect is resolved by retrying with
  the same operation id or by querying provider status.

### Ordering

Only transitions for the same aggregate require order. Events from different
tasks, Flow runs, or Workspaces may interleave. Every callback includes a
stable event id, occurrence time, producer, contract version, and aggregate
reference. Consumers reject impossible transitions and tolerate duplicates.

### Cancellation and timeout

Core records cancellation intent and sends a versioned cancel command. Flow
stops scheduling new work, signals active children, waits for graceful exit,
uses bounded forced termination when required, flushes state/events, and then
reports the terminal result. Workspace does not delete a writable Workspace
until Flow termination is acknowledged. A timeout is a trigger for
reconciliation, not proof of cancellation.

### Partial failures

| Failure | Required response |
| --- | --- |
| Workspace created, response lost | Retry/query with the same operation id; do not create another branch/worktree. |
| Flow started, result lost | Reconcile by external run reference or operation id; do not start a second run. |
| Duplicate callback | Return success without a second state transition or audit fact. |
| Evidence collection fails | Preserve execution result and mark evidence incomplete for independent reconciliation. |
| Cleanup fails | Report partial/failed cleanup and retain the Workspace record for retry. |
| Worker/Core restarts | Reconstruct work from durable commands, leases, provider status, and projections. |

## 8. Quality-attribute scenarios

| Priority | Scenario | Response measure | Required evidence |
| --- | --- | --- | --- |
| P0 | Twenty tasks are submitted concurrently to a profile with global capacity four. | No more than four attempts hold active capacity; every other task remains durably queued with a reason; no reservation is lost. | Core admission integration test and capacity metrics. |
| P0 | Two writable tasks target the same repository under the default policy. | Exactly one is admitted; the other remains queued until release; workspaces and branches are distinct. | Core + Workspace real-Git contract test. |
| P0 | The same side-effecting command or callback is delivered 100 times. | Exactly one logical side effect and state transition; retries return a stable result or duplicate acknowledgement. | Provider and Core idempotency contract tests. |
| P0 | Cancellation arrives while multiple Flow jobs and child processes are active. | No new job starts after acknowledgement; terminal cancellation is reported only after children and writers quiesce; capacity is released once. | Flow cancellation test plus Windows process-tree evidence. |
| P0 | Core or a worker exits at each boundary between persistence and provider invocation. | After restart, every task becomes queued, active, terminal, or explicitly reconciliation-required; no task is silently lost or executed twice. | M2 crash-point integration suite. |
| P0 | A process attempts to write outside its writable Workspace or into a denied path. | The write is blocked before mutation and a structured violation is emitted. | M3 path-enforcement tests on Windows and POSIX. |
| P1 | Parallel development runs continuously for eight hours on Windows with cancellation, timeouts, and task switching. | Zero orphaned tracked children after the idle grace period; process and handle counts return to a stable baseline; no unbounded console-host growth. | M1/M4 soak report with process ancestry and handle metrics. |
| P1 | A Workspace cleanup operation partially removes files and then fails. | Registry does not claim successful cleanup; retry/reconcile preserves enough evidence to finish or escalate. | Workspace cleanup fault-injection test. |

## 9. Migration path

### Stage 0: contract baseline (M0)

- Publish this ADR and provider-owned versioned contracts.
- Add optional Core profile policy fields with finite defaults and a reversible
  SQLite migration.
- Publish the initial compatibility matrix and contract-test ownership.

Rollback: older Core binaries ignore new JSON request fields only where their
existing validation permits it; database migration must preserve old columns
and derive defaults on read. Contract version 1 behavior remains supported.

### Stage 1: stabilize Flow (M1)

- Make cancellation, timeout, child reaping, and concurrent writer completion
  satisfy the P0 scenarios.
- Keep the synchronous Core adapter as the compatibility path.

Rollback: select the previous Flow version in the Execution Profile while no
version-2-only capability is requested.

### Stage 2: durable Core execution (M2)

- Introduce Execution Commands, outbox dispatch, capacity leases, and
  reconciliation behind an execution-mode switch.
- Run synchronous and asynchronous adapters against the same published
  provider contracts, with only one mode accepting writes for a Task.

Rollback: stop admitting asynchronous work, drain/reconcile durable commands,
then restore synchronous mode. Never let both modes dispatch the same command.

### Stage 3: enforce Workspace isolation (M3)

- Add execution-boundary path enforcement, lease recovery, and factual cleanup
  states.
- Negotiate the enforcement capability before admitting writable work that
  requires it.

Rollback: stop new writable admissions, preserve existing Workspaces, and use
  the older coordination-only mode solely for explicitly compatible profiles.

### Stage 4: end-to-end proof (M4)

- Run the golden path, failure matrix, Windows soak, and cross-repository load
  scenarios.
- Promote the compatible version set only after evidence is attached to the
  milestone.

Rollback: compatibility matrix marks the failed combination unsupported and
pins the last proven component set.

## 10. Consequences and tradeoffs

Positive consequences:

- Component teams can change internals without sharing a state machine or
  release cadence.
- Duplicate delivery and process failure become expected contract cases.
- Local CLI deployments remain supported while M2 adds durability.
- Safety claims require executable evidence from the owning component.

Costs and risks:

- Core must maintain explicit projections and reconciliation logic rather than
  treating CLI exit as truth.
- Finite defaults can queue work sooner than users expect; metrics and queued
  reasons are required.
- A Workspace lock alone is intentionally not described as a security sandbox,
  so M3 must add enforcement before the isolation acceptance criterion closes.
- Contract versions add release discipline across three repositories.

## 11. Validation and ownership

| Contract area | Provider evidence | Consumer evidence | Delivery milestone |
| --- | --- | --- | --- |
| Admission and capacity | Core schema/domain/integration tests | Core API/CLI tests | M0.2, M2 |
| Flow invocation and result | Flow CLI/runtime contract tests | Core Flow adapter tests | M0.3, M1 |
| Flow callback and cancellation | Flow event/cancellation tests | Core callback/reconciliation tests | M0.3, M1, M2 |
| Workspace lifecycle and idempotency | Workspace real-Git/CLI tests | Core Workspace adapter tests | M0.4, M3 |
| Workspace path enforcement | Workspace/execution-host security tests | End-to-end policy tests | M3, M4 |
| Compatible release set | Provider contract-version tests | End-to-end matrix test | M0.5, M4 |

M0 closes only when the ADR is merged, every Execution Profile has normalized
capacity/workspace policy, both provider contracts are published by their
owners, and the cross-repository compatibility matrix assigns every required
test.
