import { afterEach, describe, expect, it } from "vitest";
import type {
  Clock,
  FlowExecutor,
  FlowGateDecisionRequest,
  FlowStartRequest,
  FlowStartResult,
  IdGenerator,
  PreparedWorkspace,
  WorkspaceEvidence,
  WorkspaceInvocationContext,
  WorkspacePreparationRequest,
  WorkspaceProvider
} from "../src/contracts/ports.js";
import { CoreService } from "../src/application/core-service.js";
import type { DecideHumanGateInput } from "../src/contracts/schemas.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { ForbiddenError } from "../src/domain/errors.js";

class FakeClock implements Clock {
  private tick = 0;
  now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 6, 20, 0, 0, this.tick)).toISOString();
  }
}

class FakeIds implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}_${this.value}`;
  }
}

class FakeFlow implements FlowExecutor {
  readonly decisions: FlowGateDecisionRequest[] = [];
  decisionError?: Error;
  result: FlowStartResult = {
    externalRunId: "zf-run-1",
    status: "completed",
    exitCode: 0,
    summary: "done",
    metadata: { engine: "fake" }
  };

  async start(_request: FlowStartRequest): Promise<FlowStartResult> {
    return this.result;
  }

  async decideGate(request: FlowGateDecisionRequest): Promise<void> {
    this.decisions.push(request);
    if (this.decisionError) throw this.decisionError;
  }
}

class FakeWorkspace implements WorkspaceProvider {
  async prepare(request: WorkspacePreparationRequest): Promise<PreparedWorkspace> {
    return {
      provider: "fake-workspace",
      externalId: `external-${request.flowRunId}`,
      path: "/tmp/zigma-workspace",
      repositoryUrl: request.repository.url,
      baseRef: request.baseRef,
      baseCommit: "abc123",
      branch: request.branch,
      mode: request.policy.mode,
      metadata: {}
    };
  }

  async bindRun(): Promise<void> {}

  async collectEvidence(_externalWorkspaceId: string, _context: WorkspaceInvocationContext): Promise<WorkspaceEvidence> {
    return {
      items: [
        {
          kind: "workspace-diff",
          name: "diff",
          uri: "file:///tmp/change.patch",
          summary: "1 file changed",
          metadata: { files: ["src/a.ts"] }
        }
      ]
    };
  }
}

const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const flow = new FakeFlow();
  const core = new CoreService({
    store,
    flowExecutor: flow,
    workspaceProvider: new FakeWorkspace(),
    clock: new FakeClock(),
    ids: new FakeIds()
  });
  const profile = core.createExecutionProfile({
    name: "local",
    mode: "local-cli",
    flowCommand: "zigma-flow",
    workspaceCommand: "zigma-workspace",
    timeoutMs: 60_000,
    environment: {},
    metadata: {}
  });
  const project = core.createProject({
    key: "zigma-core",
    displayName: "Zigma Core",
    repositories: [
      {
        id: "main",
        provider: "github",
        url: "https://github.com/LummiGhost/zigma-core.git",
        defaultRef: "main",
        writable: true,
        metadata: {}
      }
    ],
    defaultRepositoryId: "main",
    defaultWorkflowRef: "code-change",
    executionProfileId: profile.id,
    workspacePolicy: {
      provider: "zigma-workspace-cli",
      mode: "writable",
      branchTemplate: "zigma/{taskId}",
      cleanup: "manual",
      snapshotOnTerminal: true
    },
    metadata: {}
  });
  const task = core.createTask({
    projectId: project.id,
    title: "Implement model",
    description: "Implement the model and tests",
    priority: "high",
    source: { kind: "api", metadata: {} },
    createdBy: { type: "user", id: "owner" },
    labels: ["mvp"],
    metadata: {}
  });
  return { core, flow, store, project, task };
}

function startInput() {
  return {
    callerContext: {
      actor: { type: "user" as const, id: "owner" },
      capabilities: [
        "task:start" as const,
        "workflow:invoke" as const,
        "workspace:create" as const,
        "workspace:write" as const,
        "gate:approve" as const,
        "gate:reject" as const
      ],
      constraints: {
        repositoryIds: ["main"],
        workflowRefs: ["code-change"],
        toolNames: ["git", "zigma-workspace"],
        branchPatterns: ["zigma/*"]
      },
      source: { kind: "api" as const, metadata: {} }
    },
    inputs: { feature: "models" },
    dryRun: false
  };
}

describe("CoreService", () => {
  it("runs a complete task and assembles workspace evidence", async () => {
    const { core, task } = setup();

    const view = await core.startTask(task.id, startInput());

    expect(view.task.status).toBe("completed");
    expect(view.activeFlowRun?.status).toBe("completed");
    expect(view.activeFlowRun?.externalRunId).toBe("zf-run-1");
    expect(view.workspace?.baseCommit).toBe("abc123");
    expect(view.evidence?.items.map((item) => item.kind)).toEqual([
      "summary",
      "workspace-diff"
    ]);
    expect(core.listTaskAudit(task.id).map((event) => event.action)).toContain("task.completed");
  });

  it("bridges a human gate and resumes the flow", async () => {
    const { core, flow, task } = setup();
    flow.result = {
      externalRunId: "zf-paused",
      status: "awaiting_human",
      exitCode: 0,
      metadata: {}
    };

    const started = await core.startTask(task.id, startInput());
    const run = started.activeFlowRun!;
    expect(started.task.status).toBe("awaiting_human");

    const gate = core.createHumanGate({
      externalGateId: "gate-merge",
      taskId: task.id,
      flowRunId: run.id,
      jobId: "merge",
      stepId: "approval",
      prompt: "Approve merge?",
      inputSchema: {},
      allowedApprovers: [{ type: "user", id: "owner" }],
      metadata: {}
    });

    const decided = await core.decideHumanGate(gate.id, {
      actor: { type: "user", id: "owner" },
      decision: "approve",
      comment: "Looks good",
      input: {},
      callerCapabilities: ["gate:approve"]
    });

    expect(decided.status).toBe("approved");
    expect(flow.decisions).toHaveLength(1);
    expect(core.getTask(task.id).status).toBe("running");

    const completed = core.recordFlowEvent(run.id, {
      eventId: "event-completed",
      type: "run.completed",
      occurredAt: "2026-07-20T01:00:00.000Z",
      externalRunId: "zf-paused",
      payload: {}
    });
    expect(completed.task.status).toBe("completed");

    const duplicate = core.recordFlowEvent(run.id, {
      eventId: "event-completed",
      type: "run.completed",
      occurredAt: "2026-07-20T01:00:00.000Z",
      payload: {}
    });
    expect(duplicate.task.status).toBe("completed");
  });

  it("keeps failed human gate delivery retryable and finalizes it after retry", async () => {
    const { core, flow, store, task } = setup();
    flow.result = {
      externalRunId: "zf-paused-retry",
      status: "awaiting_human",
      exitCode: 0,
      metadata: {}
    };
    const run = (await core.startTask(task.id, startInput())).activeFlowRun!;
    const gate = core.createHumanGate({
      externalGateId: "gate-retry",
      taskId: task.id,
      flowRunId: run.id,
      jobId: "review",
      stepId: "approval",
      prompt: "Approve?",
      inputSchema: {},
      allowedApprovers: [{ type: "user", id: "owner" }],
      metadata: {}
    });
    const input: DecideHumanGateInput = {
      actor: { type: "user" as const, id: "owner" },
      decision: "approve" as const,
      comment: "retry me",
      input: {},
      callerCapabilities: ["gate:approve"]
    };

    flow.decisionError = new Error("flow unavailable");
    await expect(core.decideHumanGate(gate.id, input)).rejects.toMatchObject({
      code: "INTEGRATION_ERROR",
      details: { retryable: true }
    });
    expect(core.getTask(task.id).status).toBe("awaiting_human");
    expect(store.getHumanGate(gate.id).status).toBe("decision_failed");
    expect(store.getHumanDecision(gate.id)).toMatchObject({
      deliveryStatus: "failed",
      lastError: "flow unavailable"
    });

    flow.decisionError = undefined;
    const retried = await core.decideHumanGate(gate.id, input);
    expect(retried.status).toBe("approved");
    expect(flow.decisions).toHaveLength(2);
    expect(core.getTask(task.id).status).toBe("running");
  });

  it("enforces workflow and repository constraints", async () => {
    const { core, task } = setup();
    const input = startInput();
    input.callerContext.constraints.workflowRefs = ["docs-only"];

    await expect(core.startTask(task.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(core.getTask(task.id).status).toBe("created");
  });

  it("completes task when evidence collection fails without affecting task status", async () => {
    class FailingEvidenceWorkspace extends FakeWorkspace {
      async collectEvidence(): Promise<WorkspaceEvidence> {
        throw new Error("workspace already cleaned up");
      }
    }

    const store = new SqliteStore(":memory:");
    stores.push(store);
    const flow = new FakeFlow();
    const core = new CoreService({
      store,
      flowExecutor: flow,
      workspaceProvider: new FailingEvidenceWorkspace(),
      clock: new FakeClock(),
      ids: new FakeIds()
    });
    const profile = core.createExecutionProfile({
      name: "local",
      mode: "local-cli",
      flowCommand: "zigma-flow",
      workspaceCommand: "zigma-workspace",
      timeoutMs: 60_000,
      environment: {},
      metadata: {}
    });
    const project = core.createProject({
      key: "zigma-core",
      displayName: "Zigma Core",
      repositories: [
        {
          id: "main",
          provider: "github",
          url: "https://github.com/LummiGhost/zigma-core.git",
          defaultRef: "main",
          writable: true,
          metadata: {}
        }
      ],
      defaultRepositoryId: "main",
      defaultWorkflowRef: "code-change",
      executionProfileId: profile.id,
      workspacePolicy: {
        provider: "zigma-workspace-cli",
        mode: "writable",
        branchTemplate: "zigma/{taskId}",
        cleanup: "manual",
        snapshotOnTerminal: true
      },
      metadata: {}
    });
    const task = core.createTask({
      projectId: project.id,
      title: "Implement model",
      description: "Implement the model and tests",
      priority: "high",
      source: { kind: "api", metadata: {} },
      createdBy: { type: "user", id: "owner" },
      labels: ["mvp"],
      metadata: {}
    });

    const view = await core.startTask(task.id, startInput());

    expect(view.task.status).toBe("completed");
    expect(view.activeFlowRun?.status).toBe("completed");
    expect(view.evidence?.bundle.status).toBe("incomplete");

    const auditActions = core.listTaskAudit(task.id).map((e) => e.action);
    expect(auditActions).toContain("evidence.collection_failed");
    expect(auditActions).toContain("task.completed");
    expect(auditActions).not.toContain("task.failed");
  });
});
