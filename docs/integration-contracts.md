# Zigma Component Integration Contracts

Version: 0.1

## 1. Contract priority

Zigma Core defines the platform-facing contracts for task execution. Component adapters can translate current CLI behavior, but the target contracts should be implemented directly by the component that owns each capability.

## 2. zigma-flow contract

### 2.1 Start request

Core requires a workflow invocation contract equivalent to:

```ts
interface FlowStartRequest {
  taskId: string;
  flowRunId: string;
  workflowRef: string;
  taskText: string;
  projectRoot: string;
  inputs: Record<string, string>;
  callerContext: CallerContext;
  timeoutMs: number;
  dryRun: boolean;
}
```

The MVP adapter maps this to:

```bash
zigma-flow --cwd <workspace> invoke <workflow> \
  --task <description> \
  --input zigma_core_task_id=<id> \
  --input zigma_core_flow_run_id=<id>
```

### 2.2 Required machine result

Target result:

```json
{
  "contractVersion": 1,
  "runId": "...",
  "status": "completed",
  "exitCode": 0,
  "pausedGate": null,
  "artifacts": [],
  "eventLogUri": "file:///.../events.jsonl"
}
```

The current adapter parses the human-readable final line. This is a compatibility bridge and should be removed after `zigma-flow invoke --json` exists.

### 2.3 Event delivery

Core accepts idempotent events at:

```text
POST /v1/flow-runs/:coreFlowRunId/events
```

Every event requires a stable `eventId`, `occurredAt`, and event type. Delivery can be at-least-once because Core deduplicates event IDs.

A future execution mode can provide one of these mechanisms:

- `--event-sink <url>`
- `--event-file <path>` plus a Core watcher
- Library callback
- Service API stream

### 2.4 Human Gate

When a human step pauses, Flow should expose:

- Stable external gate ID
- Run ID
- Job ID
- Step ID
- Prompt
- Input JSON Schema
- Deadline, when configured
- Artifact references relevant to the decision

Core returns a decision through a resume contract. The current CLI adapter uses `resume <run-id> --job <job-id> --input ...`.

### 2.5 Context transport

Large or sensitive Caller Context values should use a file or structured API payload. Repeated `--input` arguments remain suitable for identifiers and small non-secret values.

Target CLI option:

```bash
zigma-flow invoke <workflow> --context-file <path>
```

The file should contain the permission snapshot ID, integrity hash, capabilities, constraints, task source, and Core callback information.

## 3. zigma-workspace contract

The current `zigma-workspace` MVP already provides a usable JSON CLI envelope:

```json
{
  "ok": true,
  "data": {}
}
```

Core uses:

- `create --json`
- `bind-run --json`
- `diff --json`
- `snapshot --json`
- `cleanup --json`

### 3.1 Stability requirements

The JSON contract should add:

- `contract_version`
- Stable machine error code
- `operation_id` for idempotent retries
- Optional `state_dir` override for isolated deployments
- Documented path and URI semantics across Windows and POSIX systems

### 3.2 Library API

A future package export should expose the same operations through TypeScript interfaces. Core can then use the library adapter for an in-process deployment while retaining the CLI adapter for process isolation.

## 4. Ownership matrix

| Capability | Owner | Core record |
|---|---|---|
| Workflow DAG | zigma-flow | Workflow reference |
| Job and step state | zigma-flow | Flow status projection |
| Git worktree | zigma-workspace | Workspace Ref |
| Task lifecycle | zigma-core | Task |
| Authorization decision | zigma-core | Permission Snapshot |
| Human approval | zigma-core | Human Gate and Decision |
| Artifact bytes | Flow, Workspace, object store | Evidence Item URI |
| Platform audit | zigma-core | Audit Event |
| PR and review platform | future zigma-code | External reference |
