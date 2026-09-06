# Zigma Core API Contracts

Version: `v1` MVP

Base path: `/v1`

All successful responses use:

```json
{
  "data": {}
}
```

All errors use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  }
}
```

## Execution profiles

### `POST /execution-profiles`

Registers how Core invokes `zigma-flow` and `zigma-workspace`.

```json
{
  "name": "local-cli",
  "mode": "local-cli",
  "flowCommand": "zigma-flow",
  "workspaceCommand": "zigma-workspace",
  "timeoutMs": 3600000,
  "executionPolicy": {
    "contractVersion": 1,
    "capacity": {
      "global": 4,
      "perProject": 4,
      "perRepository": 2,
      "perBackend": 4
    },
    "admission": {
      "writablePerRepository": 1,
      "queueDiscipline": "fifo",
      "requireDistinctWorkspace": true
    }
  },
  "environment": {},
  "metadata": {}
}
```

`executionPolicy` is normalized on create and is always present in API and CLI
responses. All capacity values are finite positive integers. Omitted fields use
the values shown above. `writablePerRepository` cannot exceed
`capacity.perRepository`; the current contract supports FIFO admission and
requires a distinct Workspace for every writable task attempt.

The current Core runtime accepts only `mode: "local-cli"`; `local-service` and
`remote-host` are reserved for profiles with a wired execution host and are
rejected rather than silently treated as local CLI. Branch constraints are
whole-string globs: `*` matches any sequence (including `/`), `?` matches one
character, and all other characters match literally. An empty pattern list is
unrestricted. M0 currently supports `cleanup: "manual"` and
`snapshotOnTerminal: true`; other workspace policy combinations are rejected
until their provider behavior is implemented and recoverable.

These fields publish the M0 admission contract. Enforcement and durable
capacity leases are delivered by M2; the synchronous MVP records the policy but
does not yet queue competing tasks.

### `GET /execution-profiles/:id`

Returns one execution profile.

## Projects

### `POST /projects`

Registers a project and its execution defaults.

```json
{
  "key": "zigma-core",
  "displayName": "Zigma Core",
  "repositories": [
    {
      "id": "primary",
      "provider": "github",
      "url": "https://github.com/LummiGhost/zigma-core.git",
      "defaultRef": "main",
      "writable": true,
      "metadata": {}
    }
  ],
  "defaultRepositoryId": "primary",
  "defaultWorkflowRef": "code-change",
  "executionProfileId": "profile_...",
  "workspacePolicy": {
    "provider": "zigma-workspace-cli",
    "mode": "writable",
    "branchTemplate": "zigma/{taskId}",
    "cleanup": "manual",
    "snapshotOnTerminal": true
  },
  "metadata": {}
}
```

### `GET /projects/:id`

Accepts a project ID or project key.

## Tasks

### `POST /tasks`

```json
{
  "projectId": "project_...",
  "title": "Implement project model",
  "description": "Implement the project model and tests.",
  "priority": "high",
  "source": {
    "kind": "api",
    "metadata": {}
  },
  "createdBy": {
    "type": "user",
    "id": "user-1"
  },
  "labels": ["mvp"],
  "metadata": {}
}
```

### `GET /tasks/:id`

Returns a Task View containing the task, project, flow attempts, active workspace, and current evidence bundle.

### `POST /tasks/:id/start`

The current local adapter executes synchronously, though the transport returns HTTP 202 to preserve the future asynchronous contract.

```json
{
  "callerContext": {
    "actor": {
      "type": "user",
      "id": "user-1"
    },
    "capabilities": [
      "task:start",
      "workflow:invoke",
      "workspace:create",
      "workspace:write"
    ],
    "constraints": {
      "repositoryIds": ["primary"],
      "workflowRefs": ["code-change"],
      "toolNames": ["git", "npm", "zigma-workspace"],
      "branchPatterns": ["zigma/*"],
      "maxRunDurationMs": 3600000
    },
    "source": {
      "kind": "api",
      "metadata": {}
    }
  },
  "inputs": {},
  "dryRun": false
}
```

### `POST /tasks/:id/cancel`

```json
{
  "reason": "Cancelled by operator"
}
```

## Flow events

### `POST /flow-runs/:id/events`

Provides the versioned, at-least-once callback contract for `zigma-flow`.
For `callbackVersion: 1`, Core requires the route id and body `flowRunId` to
match, and requires the frozen command identity plus a strictly increasing
per-run sequence. Replaying the exact envelope succeeds; a reused event id,
old sequence, skipped sequence, or changed identity is rejected.

```json
{
  "contractVersion": 1,
  "callbackVersion": 1,
  "producer": "zigma-flow",
  "eventId": "event-019...",
  "flowRunId": "flowrun_...",
  "operationId": "command_...",
  "callbackCorrelationId": "correlation_...",
  "externalRunId": "2026-07-20T...",
  "sequence": 1,
  "type": "run.completed",
  "occurredAt": "2026-07-20T03:00:00.000Z",
  "summary": "All jobs completed",
  "payload": {}
}
```

`externalRunId` is bound on the first accepted V1 callback and cannot change
for that Flow run. The full envelope, not only its `eventId`, is the replay
identity.

Event types:

- `run.started`
- `run.progress`
- `run.awaiting-human`
- `run.completed`
- `run.failed`
- `run.cancelled`

## Human Gates

### `POST /human-gates`

```json
{
  "externalGateId": "gate-merge",
  "taskId": "task_...",
  "flowRunId": "flowrun_...",
  "jobId": "merge",
  "stepId": "approval",
  "prompt": "Approve the proposed change?",
  "inputSchema": {},
  "allowedApprovers": [
    {
      "type": "user",
      "id": "user-1"
    }
  ],
  "metadata": {}
}
```

### `POST /human-gates/:id/decisions`

```json
{
  "actor": {
    "type": "user",
    "id": "user-1"
  },
  "decision": "approve",
  "comment": "Approved after review",
  "input": {},
  "callerCapabilities": ["gate:approve"]
}
```

The endpoint may return `502 INTEGRATION_ERROR` with `details.retryable: true` when the decision is persisted but delivery to `zigma-flow` fails. The gate remains `decision_failed`; resubmitting the identical request retries delivery. A different decision or actor returns `409 CONFLICT`.

The `HumanDecision` record is append-only. Each delivery retry is recorded as a
separate delivery attempt; the returned decision status is the latest attempt
projection and does not mutate the original decision row.

## Evidence

### `POST /flow-runs/:id/evidence`

Adds an Evidence Item to the open bundle.

### `GET /flow-runs/:id/evidence`

Returns the bundle and ordered items.

### `POST /flow-runs/:id/evidence/finalize`

```json
{
  "summary": "Implementation and validation completed.",
  "risks": [],
  "conclusions": ["Ready for review"]
}
```

## Audit

### `GET /tasks/:id/audit-events`

Returns append-only task aggregate events in creation order.
