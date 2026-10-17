import { afterEach, describe, expect, it } from "vitest";
import type {
  Clock,
  FlowCancelRequest,
  FlowCancelResult,
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
import { CoreService, DispatchCrashpointError, type DispatchExecutionPhase } from "../src/application/core-service.js";
import { ExecutionAdmissionService, executionFence } from "../src/application/execution-admission.js";
import { AsyncExecutionRuntime } from "../src/application/async-execution-runtime.js";
import type { DecideHumanGateInput, ExecutionPolicy } from "../src/contracts/schemas.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";
import { ConflictError, ForbiddenError } from "../src/domain/errors.js";

class FakeClock implements Clock {
  private tick = 0;
  now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 6, 20, 0, 0, this.tick)).toISOString();
  }
}

class ManualClock implements Clock {
  private milliseconds = Date.UTC(2026, 6, 20, 0, 0, 0);

  now(): string {
    return new Date(this.milliseconds).toISOString();
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

class TickingClock implements Clock {
  private milliseconds = Date.UTC(2026, 6, 20, 0, 0, 0);

  now(): string {
    this.milliseconds += 10;
    return new Date(this.milliseconds).toISOString();
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
  readonly cancellations: FlowCancelRequest[] = [];
  starts = 0;
  startBarrier?: Promise<void>;
  startError?: Error;
  reconcile?: FlowExecutor["reconcile"];

  async preflight(): Promise<void> {}
  decisionError?: Error;
  result: FlowStartResult = {
    externalRunId: "zf-run-1",
    status: "completed",
    exitCode: 0,
    summary: "done",
    metadata: { engine: "fake" }
  };

  async start(_request: FlowStartRequest): Promise<FlowStartResult> {
    this.starts += 1;
    await this.startBarrier;
    if (this.startError) throw this.startError;
    return this.result;
  }

  async decideGate(request: FlowGateDecisionRequest): Promise<void> {
    this.decisions.push(request);
    if (this.decisionError) throw this.decisionError;
  }

  cancelResult: FlowCancelResult = {
    externalRunId: "zf-run-1",
    status: "cancelled",
    quiescent: true,
    metadata: { engine: "fake" }
  };

  async cancel(request: FlowCancelRequest): Promise<FlowCancelResult> {
    this.cancellations.push(request);
    return this.cancelResult;
  }
}

class FakeWorkspace implements WorkspaceProvider {
  async preflight(): Promise<void> {}

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

function setup(options?: {
  workspaceProvider?: WorkspaceProvider;
  executionMode?: "synchronous" | "asynchronous";
  clock?: Clock;
  repositoryWritable?: boolean;
  executionPolicy?: ExecutionPolicy;
  workspacePolicy?: {
    provider: "zigma-workspace-cli" | "existing-directory" | "none";
    mode: "writable" | "read-only";
    branchTemplate: string;
    cleanup: "always" | "on-success" | "manual";
    snapshotOnTerminal: boolean;
  };
}) {
  const store = new SqliteStore(":memory:");
  stores.push(store);
  const flow = new FakeFlow();
  const clock = options?.clock ?? new FakeClock();
  const ids = new FakeIds();
  const core = new CoreService({
    store,
    flowExecutor: flow,
    workspaceProvider: options?.workspaceProvider ?? new FakeWorkspace(),
    clock,
    ids,
    executionMode: options?.executionMode
  });
  const profile = core.createExecutionProfile({
    name: "local",
    mode: "local-cli",
    flowCommand: "zigma-flow",
    workspaceCommand: "zigma-workspace",
    timeoutMs: 60_000,
    ...(options?.executionPolicy !== undefined ? { executionPolicy: options.executionPolicy } : {}),
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
        writable: options?.repositoryWritable ?? true,
        metadata: {}
      }
    ],
    defaultRepositoryId: "main",
    defaultWorkflowRef: "code-change",
    executionProfileId: profile.id,
    workspacePolicy: options?.workspacePolicy ?? {
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
  return { core, flow, store, project, task, clock, ids };
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
  it("fails provider preflight before persisting or starting an admission", async () => {
    const { core, flow, store, task } = setup();
    flow.preflight = async () => { throw new Error("provider handshake rejected"); };

    await expect(core.startTask(task.id, startInput())).rejects.toThrow("provider handshake rejected");

    expect(flow.starts).toBe(0);
    expect(core.getTask(task.id)).toMatchObject({ status: "created", revision: 1 });
    expect(store.listFlowRunsForTask(task.id)).toEqual([]);
    expect(store.listOutboxDeliveries()).toEqual([]);
  });

  it("returns accepted durable intent before background Flow execution and recovers it after restart", async () => {
    const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous" });
    let releaseFlow!: () => void;
    flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });

    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "async-start" });
    expect(accepted.task.status).toBe("queued");
    expect(accepted.activeFlowRun?.status).toBe("created");
    expect(accepted.executionCommand?.status).toBe("pending");
    expect(flow.starts).toBe(0);

    const restartedCore = new CoreService({
      store, flowExecutor: flow, workspaceProvider: new FakeWorkspace(),
      clock, ids, executionMode: "asynchronous"
    });
    const runtime = new AsyncExecutionRuntime(
      store, restartedCore,
      new ExecutionAdmissionService(store, clock, ids),
      {
        ownerId: "worker-after-restart",
        policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
      }
    );
    const dispatch = runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flow.starts).toBe(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("dispatching");
    releaseFlow();
    expect(await dispatch).toBe(1);
    expect(core.getTaskView(task.id)).toMatchObject({
      task: { status: "completed" }, executionCommand: { status: "completed", attempt: 1 }
    });
    expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("released");
    expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "delivered", attempt: 1 })]);
  });

  it("cancels queued durable intent before a worker can invoke Flow", async () => {
    const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous" });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "cancel-before-dispatch" });

    await core.cancelTask(task.id, "no longer needed");
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-cancel-test",
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });

    expect(await runtime.runOnce()).toBe(0);
    expect(flow.starts).toBe(0);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("cancelled");
    expect(core.getTask(task.id).status).toBe("cancelled");
  });

  it("does not invoke Flow when cancellation wins between admission and the dispatch marker", async () => {
    const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous" });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "cancel-before-marker" });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-cancel-before-marker",
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy,
      onPhase: async (phase) => {
        if (phase === "before-dispatch-marker") {
          await core.cancelTask(task.id, "cancelled in admission-to-dispatch window");
        }
      }
    });

    await runtime.runOnce();

    expect(flow.starts).toBe(0);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("cancelled");
    expect(core.getTask(task.id).status).toBe("cancelled");
    expect(store.getOutboxDeliveryForCommand(accepted.executionCommand!.id)?.status).toBe("cancelled");
    expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("released");
  });

  it("dispatches independent durable commands concurrently without exceeding persisted capacity", async () => {
    const clock = new ManualClock();
    const { core, flow, store, project, task, ids } = setup({
      executionMode: "asynchronous",
      clock,
      workspacePolicy: {
        provider: "none",
        mode: "read-only",
        branchTemplate: "zigma/{taskId}",
        cleanup: "manual",
        snapshotOnTerminal: true
      }
    });
    const second = core.createTask({
      projectId: project.id, title: "Second", description: "Second independent task", priority: "high",
      source: { kind: "api", metadata: {} }, createdBy: { type: "user", id: "owner" }, labels: [], metadata: {}
    });
    const third = core.createTask({
      projectId: project.id, title: "Third", description: "Third independent task", priority: "high",
      source: { kind: "api", metadata: {} }, createdBy: { type: "user", id: "owner" }, labels: [], metadata: {}
    });
    await Promise.all([core.startTask(task.id, startInput()), core.startTask(second.id, startInput()), core.startTask(third.id, startInput())]);

    let releaseFlow!: () => void;
    flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-parallel-capacity",
      workerConcurrency: 3,
      policyFor: (commandId) => store.getExecutionProfile(store.getProject(store.getExecutionCommand(commandId).projectId).executionProfileId).executionPolicy
    });

    const firstSweep = runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The default persisted policy allows two read-only commands per repository;
    // the third worker loses the atomic admission race rather than oversubscribing.
    expect(flow.starts).toBe(2);
    expect(store.listExecutionLeases().filter((lease) => lease.status === "active")).toHaveLength(2);

    releaseFlow();
    const firstDispatched = await firstSweep;
    expect(firstDispatched).toBe(2);
    expect(await runtime.runOnce()).toBe(1);
    expect(flow.starts).toBe(3);
  });

  it("bounds one runtime sweep to its configured worker count", async () => {
    const clock = new ManualClock();
    const { core, flow, store, project, task, ids } = setup({
      executionMode: "asynchronous",
      clock,
      workspacePolicy: {
        provider: "none",
        mode: "read-only",
        branchTemplate: "zigma/{taskId}",
        cleanup: "manual",
        snapshotOnTerminal: true
      }
    });
    const second = core.createTask({
      projectId: project.id, title: "Second", description: "Second independent task", priority: "high",
      source: { kind: "api", metadata: {} }, createdBy: { type: "user", id: "owner" }, labels: [], metadata: {}
    });
    await Promise.all([core.startTask(task.id, startInput()), core.startTask(second.id, startInput())]);

    let releaseFlow!: () => void;
    flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-single-slot",
      workerConcurrency: 1,
      policyFor: (commandId) => store.getExecutionProfile(store.getProject(store.getExecutionCommand(commandId).projectId).executionProfileId).executionPolicy
    });

    const sweep = runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flow.starts).toBe(1);
    releaseFlow();
    expect(await sweep).toBe(2);
    expect(flow.starts).toBe(2);
  });

  it("stops polling but waits for active parallel workers to settle", async () => {
    const clock = new ManualClock();
    const { core, flow, store, project, task, ids } = setup({
      executionMode: "asynchronous",
      clock,
      workspacePolicy: {
        provider: "none",
        mode: "read-only",
        branchTemplate: "zigma/{taskId}",
        cleanup: "manual",
        snapshotOnTerminal: true
      }
    });
    const second = core.createTask({
      projectId: project.id, title: "Second", description: "Second independent task", priority: "high",
      source: { kind: "api", metadata: {} }, createdBy: { type: "user", id: "owner" }, labels: [], metadata: {}
    });
    await Promise.all([core.startTask(task.id, startInput()), core.startTask(second.id, startInput())]);

    let releaseFlow!: () => void;
    flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-stop-parallel",
      workerConcurrency: 2,
      pollIntervalMs: 1,
      policyFor: (commandId) => store.getExecutionProfile(store.getProject(store.getExecutionCommand(commandId).projectId).executionProfileId).executionPolicy
    });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flow.starts).toBe(2);

    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    releaseFlow();
    await stopping;
    expect(stopped).toBe(true);
    expect(flow.starts).toBe(2);
  });

  it("does not ACK a claimed delivery until the provider response is durable", async () => {
    const clock = new ManualClock();
    const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "crash-after-response" });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-crash-a",
      leaseDurationMs: 1_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy,
      onPhase: (phase) => {
        if (phase === "provider-response-received") throw new DispatchCrashpointError(phase);
      }
    });

    await expect(runtime.runOnce()).rejects.toBeInstanceOf(DispatchCrashpointError);
    expect(flow.starts).toBe(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id)).toMatchObject({ status: "dispatching" });
    expect(store.getExecutionCommand(accepted.executionCommand!.id).providerResponse).toBeUndefined();
    expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "claimed" })]);

    // The response could have reached Flow just before the process died. With
    // no inspect capability, restart must retain the command as ambiguous.
    clock.advance(2_000);
    const restarted = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-crash-b",
      leaseDurationMs: 1_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });
    expect(await restarted.runOnce()).toBe(0);
    expect(flow.starts).toBe(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id)).toMatchObject({
      status: "reconciling",
      lastError: expect.stringContaining("inspection capability")
    });
    expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("reconciling");
  });

  it("recovers a crash before provider dispatch by resetting the claimed outbox delivery", async () => {
    const clock = new ManualClock();
    const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "crash-after-claim" });
    const crashing = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-claim-a",
      leaseDurationMs: 1_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy,
      onPhase: (phase) => {
        if (phase === "outbox-claimed") throw new DispatchCrashpointError(phase);
      }
    });

    await expect(crashing.runOnce()).rejects.toBeInstanceOf(DispatchCrashpointError);
    expect(flow.starts).toBe(0);
    expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "claimed" })]);

    clock.advance(2_000);
    const restarted = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-claim-b",
      leaseDurationMs: 1_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });
    // Reconciliation precedes the outbox scan in the same iteration, so an
    // interrupted pre-dispatch claim can be reclaimed immediately and safely.
    expect(await restarted.runOnce()).toBe(1);
    expect(flow.starts).toBe(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("completed");
  });

  it("recovers a crash immediately after lease acquisition without invoking Flow", async () => {
    const clock = new ManualClock();
    const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "crash-after-lease" });
    const crashing = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-lease-a",
      leaseDurationMs: 1_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy,
      onPhase: (phase) => {
        if (phase === "lease-acquired") throw new DispatchCrashpointError(phase);
      }
    });

    await expect(crashing.runOnce()).rejects.toBeInstanceOf(DispatchCrashpointError);
    expect(flow.starts).toBe(0);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("leased");
    expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "pending" })]);

    clock.advance(2_000);
    const restarted = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-lease-b",
      leaseDurationMs: 1_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });
    expect(await restarted.runOnce()).toBe(1);
    expect(flow.starts).toBe(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("completed");
  });

  it("finishes an already durable provider result after crash points before and after outbox ACK", async () => {
    const phases: DispatchExecutionPhase[] = ["provider-result-persisted", "outbox-acknowledged"];
    for (const phase of phases) {
      const clock = new ManualClock();
      const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
      const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: `crash-${phase}` });
      const crashing = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: `worker-${phase}-a`,
        leaseDurationMs: 1_000,
        policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy,
        onPhase: (current) => {
          if (current === phase) throw new DispatchCrashpointError(current);
        }
      });

      await expect(crashing.runOnce()).rejects.toBeInstanceOf(DispatchCrashpointError);
      expect(store.getExecutionCommand(accepted.executionCommand!.id)).toMatchObject({ status: "completed", providerResponse: expect.any(Object) });
      if (phase === "provider-result-persisted") {
        expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "claimed" })]);
      } else {
        expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "delivered" })]);
      }

      clock.advance(2_000);
      const restarted = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: `worker-${phase}-b`,
        leaseDurationMs: 1_000,
        policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
      });
      expect(await restarted.runOnce()).toBe(0);
      expect(flow.starts).toBe(1);
      expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "delivered" })]);
      expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("released");
    }
  });

  it("ACKs a durably recorded provider failure instead of treating it as an outbox delivery failure", async () => {
    const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous" });
    flow.result = { externalRunId: "zf-failed", status: "failed", exitCode: 1, metadata: { reason: "workflow failed" } };
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "provider-failure" });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-provider-failure",
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });

    expect(await runtime.runOnce()).toBe(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id)).toMatchObject({
      status: "failed",
      providerResponse: expect.objectContaining({ status: "failed" })
    });
    expect(store.listOutboxDeliveries()).toEqual([expect.objectContaining({ status: "delivered" })]);
    expect(core.getTask(task.id).status).toBe("failed");
    expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("released");
  });

  it("heartbeats a live lease and rejects stale owners after reconciliation takeover", async () => {
    const clock = new TickingClock();
    const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
    let releaseFlow!: () => void;
    flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "heartbeat" });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-heartbeat",
      leaseDurationMs: 60_000,
      heartbeatIntervalMs: 1,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });
    const dispatch = runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flow.starts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const heartbeatLease = store.getExecutionLease(accepted.executionCommand!.id)!;
    expect(heartbeatLease.renewedAt).not.toBe(heartbeatLease.acquiredAt);
    releaseFlow();
    await dispatch;

    const command = store.getExecutionCommand(accepted.executionCommand!.id);
    store.updateExecutionCommand({ ...command, status: "pending", providerResponse: undefined, completedAt: undefined, updatedAt: clock.now() });
    const admission = new ExecutionAdmissionService(store, clock, ids);
    const acquired = admission.admit(
      command.id,
      "worker-stale-a",
      store.getExecutionProfile(project.executionProfileId).executionPolicy,
      1
    );
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") throw new Error("expected lease");
    const staleFence = executionFence(acquired.lease);
    const replacement = admission.takeoverForReconciliation(command.id, "worker-stale-b", 60_000);
    expect(replacement).toBeDefined();
    expect(() => admission.renew(staleFence, 60_000)).toThrow(ConflictError);
  });

  it("keeps capacity reserved through cancellation request until Flow proves quiescence", async () => {
    const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous" });
    flow.result = { externalRunId: "zf-running", status: "running", exitCode: 0, metadata: {} };
    flow.cancelResult = { externalRunId: "zf-running", status: "cancelled", quiescent: true, metadata: { reaped: true } };
    let releaseFlow!: () => void;
    flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "cancel-race" });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-cancel-race",
      leaseDurationMs: 60_000,
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });
    const dispatch = runtime.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("dispatching");

    await core.cancelTask(task.id, "user requested cancellation");
    expect(store.getExecutionCommand(accepted.executionCommand!.id).status).toBe("cancel_requested");
    expect(core.getTask(task.id).status).toBe("blocked");
    expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("active");
    expect(flow.cancellations).toHaveLength(0);

    releaseFlow();
    expect(await dispatch).toBe(1);
    expect(flow.cancellations).toHaveLength(1);
    expect(store.getExecutionCommand(accepted.executionCommand!.id)).toMatchObject({
      status: "cancelled",
      cancelRequestedAt: expect.any(String),
      cancelAcknowledgedAt: expect.any(String)
    });
    expect(core.getTask(task.id).status).toBe("cancelled");
    expect(store.getExecutionLease(accepted.executionCommand!.id)?.status).toBe("released");
  });

  it("fails closed after an ambiguous Workspace provider failure instead of replaying Flow", async () => {
    class FlakyWorkspace extends FakeWorkspace {
      attempts = 0;
      async prepare(request: WorkspacePreparationRequest): Promise<PreparedWorkspace> {
        this.attempts += 1;
        if (this.attempts < 3) throw new Error("workspace temporarily unavailable");
        return super.prepare(request);
      }
    }
    const workspace = new FlakyWorkspace();
    const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous", workspaceProvider: workspace });
    const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "bounded-retry" });
    const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
      ownerId: "worker-retry-test",
      policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
    });

    expect(await runtime.runOnce()).toBe(0);
    expect(await runtime.runOnce()).toBe(0);
    expect(await runtime.runOnce()).toBe(0);
    expect(workspace.attempts).toBe(1);
    expect(flow.starts).toBe(0);
    expect(store.getExecutionCommand(accepted.executionCommand!.id)).toMatchObject({
      status: "reconciling",
      lastError: expect.stringContaining("inspection capability")
    });
  });

  it("atomically limits admission across 20 queued commands", async () => {
    const { core, store, project, task } = setup();
    const tasks = [task];
    for (let index = 1; index < 20; index += 1) {
      tasks.push(core.createTask({
        projectId: project.id, title: `Task ${index}`, description: `Run ${index}`,
        priority: "normal", source: { kind: "api", metadata: {} },
        createdBy: { type: "user", id: "owner" }, labels: [], metadata: {}
      }));
    }
    const commandIds: string[] = [];
    for (const current of tasks) {
      const view = await core.startTask(current.id, { ...startInput(), idempotencyKey: `start-${current.id}` });
      const command = view.executionCommand!;
      store.updateExecutionCommand({ ...command, status: "pending", attempt: 0, completedAt: undefined, updatedAt: command.updatedAt });
      commandIds.push(command.id);
    }
    const admission = new ExecutionAdmissionService(store, new FakeClock(), new FakeIds());
    const policy = {
      contractVersion: 1 as const,
      capacity: { global: 4, perProject: 4, perRepository: 4, perBackend: 4 },
      admission: { writablePerRepository: 4, queueDiscipline: "fifo" as const, requireDistinctWorkspace: true as const }
    };

    const results = commandIds.map((id, index) => admission.admit(id, `worker-${index}`, policy, 60_000));

    expect(results.filter((result) => result.outcome === "acquired")).toHaveLength(4);
    expect(results.slice(4).every((result) => result.outcome === "queued" && result.limitedBy.includes("global"))).toBe(true);
  });

  it("fences stale owners and reconciles an expired lease before reacquisition", async () => {
    const { core, store, task } = setup();
    const view = await core.startTask(task.id, { ...startInput(), idempotencyKey: "lease-test" });
    const command = view.executionCommand!;
    store.updateExecutionCommand({ ...command, status: "pending", completedAt: undefined, updatedAt: command.updatedAt });
    const admission = new ExecutionAdmissionService(store, new FakeClock(), new FakeIds());
    const policy = {
      contractVersion: 1 as const,
      capacity: { global: 4, perProject: 4, perRepository: 2, perBackend: 4 },
      admission: { writablePerRepository: 1, queueDiscipline: "fifo" as const, requireDistinctWorkspace: true as const }
    };
    const acquired = admission.admit(command.id, "worker-a", policy, 1);
    expect(acquired.outcome).toBe("acquired");
    if (acquired.outcome !== "acquired") throw new Error("expected lease");

    expect(() => admission.release({ ...executionFence(acquired.lease), ownerId: "worker-b" })).toThrow(ConflictError);
    const expired = admission.admit(command.id, "worker-b", policy, 60_000);
    expect(expired).toMatchObject({ outcome: "reconcile", lease: { status: "reconciling", fencingToken: 1 } });
    expect(store.getExecutionCommand(command.id).status).toBe("reconciling");
  });

  it("persists one command and outbox record for an idempotent start", async () => {
    const { core, flow, store, task } = setup();
    const input = { ...startInput(), idempotencyKey: "start-model-v1" };

    const first = await core.startTask(task.id, input);
    const repeated = await core.startTask(task.id, input);

    expect(repeated.activeFlowRun?.id).toBe(first.activeFlowRun?.id);
    expect(repeated.executionCommand).toMatchObject({
      operationId: first.executionCommand?.id,
      idempotencyKey: "start-model-v1",
      status: "completed",
      attempt: 1,
      repositoryId: "main",
      baseRef: "main",
      callbackCorrelationId: first.executionCommand?.id
    });
    expect(flow.starts).toBe(1);
    expect(store.listOutboxDeliveries()).toHaveLength(1);
    expect(store.listOutboxDeliveries()[0]).toMatchObject({
      topic: "execution-command.requested",
      aggregateId: first.executionCommand?.id,
      status: "pending"
    });
  });

  it("rejects conflicting reuse of an idempotency key", async () => {
    const { core, task } = setup();
    await core.startTask(task.id, { ...startInput(), idempotencyKey: "same-key" });

    await expect(core.startTask(task.id, {
      ...startInput(), idempotencyKey: "same-key", inputs: { feature: "different" }
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rolls back task, run, command, and outbox when durable intent cannot commit", async () => {
    const { core, store, task } = setup();
    const original = store.insertOutboxDelivery.bind(store);
    store.insertOutboxDelivery = () => { throw new Error("simulated commit boundary failure"); };

    await expect(core.startTask(task.id, {
      ...startInput(), idempotencyKey: "rollback-key"
    })).rejects.toThrow("simulated commit boundary failure");

    store.insertOutboxDelivery = original;
    expect(core.getTask(task.id)).toMatchObject({ status: "created", revision: 1 });
    expect(store.listFlowRunsForTask(task.id)).toEqual([]);
    expect(store.findExecutionCommandByIdempotencyKey(task.id, "rollback-key")).toBeUndefined();
    expect(store.listOutboxDeliveries()).toEqual([]);
  });

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

    const completedEvent = {
      eventId: "event-completed",
      type: "run.completed" as const,
      occurredAt: "2026-07-20T01:00:00.000Z",
      externalRunId: "zf-paused",
      payload: {}
    };
    const completed = core.recordFlowEvent(run.id, completedEvent);
    expect(completed.task.status).toBe("completed");

    const duplicate = core.recordFlowEvent(run.id, completedEvent);
    expect(duplicate.task.status).toBe("completed");
  });

  it("deduplicates correlated callbacks and projects job workspace evidence without owning job state", async () => {
    const { core, flow, store, task, clock, ids } = setup();
    flow.result = {
      externalRunId: "zf-run-1",
      status: "running",
      exitCode: 0,
      metadata: {}
    };
    const started = await core.startTask(task.id, { ...startInput(), idempotencyKey: "callback-projection" });
    const run = started.activeFlowRun!;
    const command = started.executionCommand!;
    const event = {
      contractVersion: 1 as const,
      callbackVersion: 1 as const,
      producer: "zigma-flow" as const,
      eventId: "workspace-event-1",
      flowRunId: run.id,
      operationId: command.operationId,
      callbackCorrelationId: command.callbackCorrelationId,
      externalRunId: "zf-run-1",
      sequence: 1,
      type: "run.progress" as const,
      occurredAt: "2026-07-20T02:00:00.000Z",
      workspace: {
        provider: "zigma-workspace", externalId: "ws-job-build-2", scope: "job-attempt" as const,
        jobId: "build", attempt: 2, status: "snapshotted", path: "/tmp/job-build-2",
        repositoryUrl: "https://github.com/LummiGhost/zigma-core.git", baseRef: "main",
        baseCommit: "abc123", branch: "zigma/job-build-2", metadata: { workspaceCapability: "managed-v1" }
      },
      evidence: [{ kind: "workspace-snapshot" as const, name: "job-build-2-snapshot", uri: "artifact://sha256/123", digest: "sha256:123", metadata: { jobId: "build", attempt: 2 } }],
      payload: { sequence: 7 }
    };

    const projected = core.recordFlowEvent(run.id, event);
    const duplicate = core.recordFlowEvent(run.id, event);
    expect(duplicate.workspaceHandles).toEqual(projected.workspaceHandles);
    expect(projected.activeFlowRun?.lastCallbackSequence).toBe(1);
    expect(projected.workspaceHandles).toEqual([expect.objectContaining({
      externalId: "ws-job-build-2", scope: "job-attempt", jobId: "build", attempt: 2,
      status: "snapshotted", lastEventId: "workspace-event-1"
    })]);
    expect(projected.evidence?.items.filter((item) => item.name === "job-build-2-snapshot")).toHaveLength(1);

    expect(() => core.recordFlowEvent(run.id, { ...event, payload: { sequence: 8 } })).toThrow(ConflictError);
    expect(() => core.recordFlowEvent(run.id, { ...event, eventId: "bad-correlation", callbackCorrelationId: "wrong" })).toThrow(ConflictError);
    expect(() => core.recordFlowEvent(run.id, { ...event, eventId: "wrong-run", flowRunId: "another-run", sequence: 2 })).toThrow(ConflictError);
    expect(() => core.recordFlowEvent(run.id, { ...event, eventId: "forward-gap", sequence: 3 })).toThrow(
      expect.objectContaining({ code: "CONFLICT", details: expect.objectContaining({ expectedSequence: 2 }) }),
    );
    expect(store.getFlowRun(run.id).lastCallbackSequence).toBe(1);
    expect(() => core.recordFlowEvent(run.id, { ...event, eventId: "duplicate-sequence", sequence: 1 })).toThrow(ConflictError);

    const restartedCore = new CoreService({
      store,
      flowExecutor: flow,
      workspaceProvider: new FakeWorkspace(),
      clock,
      ids,
    });
    expect(restartedCore.recordFlowEvent(run.id, event).workspaceHandles).toEqual(projected.workspaceHandles);

    const completed = restartedCore.recordFlowEvent(run.id, {
      contractVersion: 1, callbackVersion: 1, producer: "zigma-flow", eventId: "completed", flowRunId: run.id, operationId: command.operationId,
      callbackCorrelationId: command.callbackCorrelationId, type: "run.completed",
      status: "completed", externalRunId: "zf-run-1", sequence: 2, occurredAt: "2026-07-20T03:00:00.000Z", payload: {}
    });
    expect(completed.task.status).toBe("completed");
    expect(completed.activeFlowRun).toMatchObject({ status: "completed", lastCallbackSequence: 2 });
  });

  it("classifies a persisted callback sequence collision without dereferencing a missing event id", async () => {
    const { core, flow, store, task } = setup();
    flow.result = { externalRunId: "zf-run-1", status: "running", exitCode: 0, metadata: {} };
    const run = (await core.startTask(task.id, startInput())).activeFlowRun!;
    const first = {
      id: "event-a", flowRunId: run.id, type: "run.progress",
      occurredAt: "2026-07-20T02:00:00.000Z", payload: {}, inputHash: "hash-a",
      callbackSequence: 1, createdAt: "2026-07-20T02:00:00.000Z"
    };
    expect(store.insertFlowEvent(first)).toBe(true);

    expect(() => store.insertFlowEvent({ ...first, id: "event-b", inputHash: "hash-b" })).toThrow(
      expect.objectContaining({
        code: "CONFLICT",
        details: expect.objectContaining({ sequence: 1, eventId: "event-b", existingEventId: "event-a" })
      }),
    );
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

  it("enforces branch constraints using whole-string globs", async () => {
    const { core, task } = setup();
    const input = { ...startInput(), branch: "zigma/release/2026" };
    input.callerContext.constraints.branchPatterns = ["zigma/*"];
    await expect(core.startTask(task.id, input)).resolves.toMatchObject({ task: { status: "completed" } });

    const second = setup();
    const denied = { ...startInput(), branch: "feature/release" };
    denied.callerContext.constraints.branchPatterns = ["zigma/*"];
    await expect(second.core.startTask(second.task.id, denied)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects writable workspace admission for a read-only repository", async () => {
    const { core, task } = setup({ repositoryWritable: false });
    await expect(core.startTask(task.id, startInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { repositoryId: "main" }
    });
    expect(core.getTask(task.id).status).toBe("created");
  });

  it("fails closed for unsupported workspace policy combinations", async () => {
    const { core, project } = setup();
    expect(() => core.createProject({
      key: "unsupported-policy",
      displayName: "Unsupported policy",
      repositories: project.repositories,
      defaultRepositoryId: project.defaultRepositoryId,
      defaultWorkflowRef: project.defaultWorkflowRef,
      executionProfileId: project.executionProfileId,
      workspacePolicy: {
        provider: "zigma-workspace-cli",
        mode: "writable",
        branchTemplate: "zigma/{taskId}",
        cleanup: "on-success",
        snapshotOnTerminal: false
      },
      metadata: {}
    })).toThrowError(/snapshotOnTerminal=false/);
  });

  it("rejects execution profiles whose mode has no wired host", async () => {
    const { core } = setup();
    expect(() => core.createExecutionProfile({
      name: "remote-unwired", mode: "remote-host", flowCommand: "zigma-flow",
      workspaceCommand: "zigma-workspace", timeoutMs: 60_000, environment: {}, metadata: {}
    })).toThrowError(/not wired/);
  });

  it("keeps HumanDecision immutable while appending delivery attempts", async () => {
    const { core, flow, store, task } = setup();
    flow.result = { externalRunId: "zf-paused-append-only", status: "awaiting_human", exitCode: 0, metadata: {} };
    const run = (await core.startTask(task.id, startInput())).activeFlowRun!;
    const gate = core.createHumanGate({
      externalGateId: "gate-append-only", taskId: task.id, flowRunId: run.id,
      jobId: "review", stepId: "approval", prompt: "Approve?", inputSchema: {},
      allowedApprovers: [{ type: "user", id: "owner" }], metadata: {}
    });
    flow.decisionError = new Error("flow unavailable");
    const decisionInput: DecideHumanGateInput = {
      actor: { type: "user", id: "owner" }, decision: "approve", input: {},
      callerCapabilities: ["gate:approve"]
    };
    await expect(core.decideHumanGate(gate.id, decisionInput)).rejects.toMatchObject({ code: "INTEGRATION_ERROR" });
    const immutable = store.db.prepare(
      "SELECT decision, delivery_status, last_error, created_at, updated_at FROM human_decisions WHERE gate_id = ?"
    ).get(gate.id) as Record<string, unknown>;
    flow.decisionError = undefined;
    await core.decideHumanGate(gate.id, decisionInput);
    expect(store.db.prepare(
      "SELECT decision, delivery_status, last_error, created_at, updated_at FROM human_decisions WHERE gate_id = ?"
    ).get(gate.id)).toEqual(immutable);
    expect(store.db.prepare(
      "SELECT attempt, delivery_status FROM human_decision_delivery_attempts WHERE decision_id = ? ORDER BY attempt"
    ).all(store.getHumanDecision(gate.id)!.id)).toEqual([
      { attempt: 1, delivery_status: "pending" },
      { attempt: 2, delivery_status: "failed" },
      { attempt: 3, delivery_status: "pending" },
      { attempt: 4, delivery_status: "delivered" }
    ]);
    expect(store.getHumanDecision(gate.id)).toMatchObject({ deliveryStatus: "delivered", deliveryAttempt: 4 });
  });

  it("completes task when evidence collection fails without affecting task status", async () => {
    class FailingEvidenceWorkspace extends FakeWorkspace {
      async collectEvidence(): Promise<WorkspaceEvidence> {
        throw new Error("workspace already cleaned up");
      }
    }

    const { core, task } = setup({ workspaceProvider: new FailingEvidenceWorkspace() });

    const view = await core.startTask(task.id, startInput());

    expect(view.task.status).toBe("completed");
    expect(view.activeFlowRun?.status).toBe("completed");
    expect(view.evidence?.bundle.status).toBe("incomplete");
    expect(() => core.addEvidenceItem(view.activeFlowRun!.id, {
      kind: "workspace-diff",
      name: "late evidence",
      uri: "file:///tmp/late.patch",
      metadata: {}
    })).toThrow(ConflictError);
    expect(core.finalizeEvidence(view.activeFlowRun!.id, {
      summary: "must not finalize",
      risks: [],
      conclusions: []
    }).status).toBe("incomplete");

    const auditActions = core.listTaskAudit(task.id).map((e) => e.action);
    expect(auditActions).toContain("evidence.collection_failed");
    expect(auditActions).toContain("task.completed");
    expect(auditActions).not.toContain("task.failed");
  });

  describe("execution metrics", () => {
    it("persists terminal counters and durations on the flow run after a synchronous start", async () => {
      const { core, store, task } = setup();
      const view = await core.startTask(task.id, startInput());
      const run = view.activeFlowRun!;

      const metrics = store.getFlowRun(run.id).metrics!;
      expect(metrics.counters).toMatchObject({ dispatched: 1, started: 1, completed: 1, failed: 0 });
      expect(metrics.durations["queue_to_dispatch"].count).toBe(1);
      expect(metrics.durations["start_to_terminal"].count).toBe(1);
      expect(metrics.durations["dispatch_to_start"].count).toBe(0);
      const live = core.getFlowRunMetrics(run.id)!;
      expect(live.counters).toEqual(metrics.counters);
      expect(live.durations).toEqual(metrics.durations);
    });

    it("counts async dispatch phases through the runtime and persists them at the terminal transition", async () => {
      const { core, flow, store, project, task, clock, ids } = setup({ executionMode: "asynchronous" });
      const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "metrics-async" });
      const run = accepted.activeFlowRun!;
      const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: "worker-metrics-async",
        metrics: core.metricsRegistry,
        policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
      });

      expect(await runtime.runOnce()).toBe(1);
      expect(flow.starts).toBe(1);

      const metrics = store.getFlowRun(run.id).metrics!;
      expect(metrics.counters).toMatchObject({ dispatched: 1, started: 1, completed: 1 });
      expect(metrics.durations["queue_to_dispatch"].count).toBe(1);
      expect(metrics.durations["dispatch_to_start"].count).toBe(1);
      expect(metrics.durations["start_to_terminal"].count).toBe(1);
    });

    it("records workspace conflicts and human waits from flow events before the terminal snapshot", async () => {
      const { core, flow, store, task } = setup();
      flow.result = { externalRunId: "zf-run-1", status: "running", exitCode: 0, metadata: {} };
      const started = await core.startTask(task.id, startInput());
      const run = started.activeFlowRun!;
      const command = started.executionCommand!;

      core.recordFlowEvent(run.id, {
        contractVersion: 1, callbackVersion: 1, producer: "zigma-flow",
        eventId: "conflict-event", flowRunId: run.id, operationId: command.operationId,
        callbackCorrelationId: command.callbackCorrelationId, externalRunId: "zf-run-1",
        sequence: 1, type: "run.progress", occurredAt: "2026-07-20T02:00:00.000Z",
        payload: { job_id: "impl", failure_kind: "workspace_merge_conflict", reason: "conflict in src/a.ts" }
      });
      core.recordFlowEvent(run.id, {
        contractVersion: 1, callbackVersion: 1, producer: "zigma-flow",
        eventId: "human-event", flowRunId: run.id, operationId: command.operationId,
        callbackCorrelationId: command.callbackCorrelationId, externalRunId: "zf-run-1",
        sequence: 2, type: "run.awaiting-human", occurredAt: "2026-07-20T02:01:00.000Z",
        payload: {}
      });
      expect(core.getFlowRunMetrics(run.id)?.counters).toMatchObject({
        workspace_conflicts: 1,
        awaiting_human: 1
      });

      core.recordFlowEvent(run.id, {
        contractVersion: 1, callbackVersion: 1, producer: "zigma-flow",
        eventId: "resume-event", flowRunId: run.id, operationId: command.operationId,
        callbackCorrelationId: command.callbackCorrelationId, externalRunId: "zf-run-1",
        sequence: 3, type: "run.progress", occurredAt: "2026-07-20T02:02:00.000Z",
        status: "running",
        payload: {}
      });
      core.recordFlowEvent(run.id, {
        contractVersion: 1, callbackVersion: 1, producer: "zigma-flow",
        eventId: "terminal-event", flowRunId: run.id, operationId: command.operationId,
        callbackCorrelationId: command.callbackCorrelationId, externalRunId: "zf-run-1",
        sequence: 4, type: "run.completed", occurredAt: "2026-07-20T02:03:00.000Z",
        payload: {}
      });
      const metrics = store.getFlowRun(run.id).metrics!;
      expect(metrics.counters).toMatchObject({
        dispatched: 1, started: 1, completed: 1, workspace_conflicts: 1, awaiting_human: 1
      });
    });

    it("does not double-count replayed terminal transitions", async () => {
      const { core, store, task } = setup();
      const view = await core.startTask(task.id, startInput());
      const run = view.activeFlowRun!;
      const command = view.executionCommand!;

      core.recordFlowEvent(run.id, {
        contractVersion: 1, callbackVersion: 1, producer: "zigma-flow",
        eventId: "late-terminal", flowRunId: run.id, operationId: command.operationId,
        callbackCorrelationId: command.callbackCorrelationId, externalRunId: "zf-run-1",
        sequence: 1, type: "run.completed", occurredAt: "2026-07-20T02:00:00.000Z",
        payload: {}
      });

      expect(store.getFlowRun(run.id).metrics?.counters["completed"]).toBe(1);
      expect(store.getFlowRun(run.id).metrics?.durations["start_to_terminal"].count).toBe(1);
    });

    it("counts cancel-before-dispatch runs and records quiescence", async () => {
      const { core, flow, store, task } = setup({ executionMode: "asynchronous" });
      const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "metrics-cancel" });
      const run = accepted.activeFlowRun!;

      await core.cancelTask(task.id, "no longer needed");
      expect(flow.starts).toBe(0);

      const metrics = store.getFlowRun(run.id).metrics!;
      expect(metrics.counters).toMatchObject({ dispatched: 0, cancelled: 1 });
      expect(metrics.durations["quiescence"].count).toBe(1);
    });

    it("attributes admission denial to the run and persists it with the terminal snapshot", async () => {
      const { core, flow, store, project, task, clock, ids } = setup({
        executionMode: "asynchronous",
        executionPolicy: {
          contractVersion: 1,
          capacity: { global: 1, perProject: 1, perRepository: 1, perBackend: 1 },
          admission: { writablePerRepository: 1, queueDiscipline: "fifo", requireDistinctWorkspace: true }
        }
      });
      await core.startTask(task.id, { ...startInput(), idempotencyKey: "metrics-capacity-1" });
      const secondTask = core.createTask({
        projectId: project.id, title: "Second", description: "Second", priority: "normal",
        source: { kind: "api", metadata: {} }, createdBy: { type: "user", id: "owner" },
        labels: [], metadata: {}
      });
      const acceptedSecond = await core.startTask(secondTask.id, { ...startInput(), idempotencyKey: "metrics-capacity-2" });
      const secondRun = acceptedSecond.activeFlowRun!;

      const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: "worker-metrics-capacity",
        metrics: core.metricsRegistry,
        policyFor: () => store.getExecutionProfile(project.executionProfileId).executionPolicy
      });
      await runtime.runOnce();

      expect(core.getFlowRunMetrics(secondRun.id)?.counters["admission_denied"]).toBe(1);
      await core.cancelTask(secondTask.id, "capacity full");
      expect(store.getFlowRun(secondRun.id).metrics?.counters).toMatchObject({
        admission_denied: 1,
        cancelled: 1
      });
    });

    it("counts a terminal reconstruction through reconciliation as a restart", async () => {
      const clock = new ManualClock();
      const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
      const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "metrics-reconcile" });
      const command = accepted.executionCommand!;
      const run = accepted.activeFlowRun!;
      const admission = new ExecutionAdmissionService(store, clock, ids);
      const policy = store.getExecutionProfile(project.executionProfileId).executionPolicy;
      const acquired = admission.admit(command.id, "worker-a", policy, 30_000);
      expect(acquired.outcome).toBe("acquired");
      if (acquired.outcome !== "acquired") throw new Error("expected lease");

      flow.startError = new DispatchCrashpointError("provider-dispatch-started");
      await expect(core.dispatchExecutionCommand(command.id, {
        fence: executionFence(acquired.lease)
      })).rejects.toBeInstanceOf(DispatchCrashpointError);
      expect(store.getExecutionCommand(command.id).status).toBe("dispatching");

      clock.advance(31_000);
      const takeover = admission.takeoverForReconciliation(command.id, "worker-b", 60_000);
      expect(takeover).toBeDefined();
      flow.reconcile = async () => ({
        outcome: "found", externalRunId: "zf-run-1", status: "completed", quiescent: true, metadata: {}
      });
      await core.reconcileExecutionCommand(command.id, executionFence(takeover!));

      expect(store.getFlowRun(run.id).status).toBe("completed");
      expect(store.getFlowRun(run.id).metrics?.counters).toMatchObject({
        dispatched: 1, started: 1, completed: 1, reconcile_restarts: 1
      });
    });

    it("attributes worker kills and lease fences across a restarted worker sweep", async () => {
      const clock = new ManualClock();
      const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
      const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "metrics-worker-kill" });
      const run = accepted.activeFlowRun!;
      let releaseFlow!: () => void;
      flow.startBarrier = new Promise<void>((resolve) => { releaseFlow = resolve; });
      const policyFor = () => store.getExecutionProfile(project.executionProfileId).executionPolicy;

      const workerA = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: "worker-a",
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        pollIntervalMs: 3_600_000,
        metrics: core.metricsRegistry,
        policyFor
      });
      const sweepA = workerA.runOnce();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(flow.starts).toBe(1);

      clock.advance(31_000);
      flow.reconcile = async () => ({
        outcome: "found", externalRunId: "zf-run-1", status: "completed", quiescent: true, metadata: {}
      });
      const workerB = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: "worker-b",
        leaseDurationMs: 60_000,
        heartbeatIntervalMs: 20_000,
        pollIntervalMs: 3_600_000,
        metrics: core.metricsRegistry,
        policyFor
      });
      await workerB.runOnce();

      releaseFlow();
      await sweepA;

      const metrics = store.getFlowRun(run.id).metrics!;
      expect(metrics.counters).toMatchObject({
        worker_kills: 1,
        reconcile_restarts: 1,
        completed: 1
      });
      expect(core.getFlowRunMetrics(run.id)?.counters["lease_fences"]).toBe(1);
    });

    it("continues accumulation from the persisted snapshot in a restarted Core process", async () => {
      const clock = new ManualClock();
      const first = setup({ executionMode: "asynchronous", clock });
      const accepted = await first.core.startTask(first.task.id, { ...startInput(), idempotencyKey: "metrics-restart" });
      const command = accepted.executionCommand!;
      const run = accepted.activeFlowRun!;
      const admission = new ExecutionAdmissionService(first.store, clock, first.ids);
      const policy = first.store.getExecutionProfile(first.project.executionProfileId).executionPolicy;
      const acquired = admission.admit(command.id, "worker-a", policy, 30_000);
      expect(acquired.outcome).toBe("acquired");
      if (acquired.outcome !== "acquired") throw new Error("expected lease");

      first.flow.startError = new DispatchCrashpointError("provider-dispatch-started");
      await expect(first.core.dispatchExecutionCommand(command.id, {
        fence: executionFence(acquired.lease)
      })).rejects.toBeInstanceOf(DispatchCrashpointError);

      clock.advance(31_000);
      const restarted = new CoreService({
        store: first.store,
        flowExecutor: first.flow,
        workspaceProvider: new FakeWorkspace(),
        clock,
        ids: first.ids,
        executionMode: "asynchronous"
      });
      first.flow.reconcile = async () => ({
        outcome: "found", externalRunId: "zf-run-1", status: "failed", quiescent: true,
        exitCode: 1, summary: "crashed", metadata: {}
      });
      const takeover = admission.takeoverForReconciliation(command.id, "worker-b", 60_000);
      expect(takeover).toBeDefined();
      await restarted.reconcileExecutionCommand(command.id, executionFence(takeover!));

      expect(first.store.getFlowRun(run.id).metrics?.counters).toMatchObject({
        failed: 1,
        reconcile_restarts: 1
      });
      expect(restarted.getFlowRunMetrics(run.id)).not.toBeNull();
    });

    it("accepts provider terminal evidence for a task blocked pending reconciliation", async () => {
      const clock = new ManualClock();
      const { core, flow, store, project, task, ids } = setup({ executionMode: "asynchronous", clock });
      const accepted = await core.startTask(task.id, { ...startInput(), idempotencyKey: "reconcile-blocked-terminal" });
      const command = accepted.executionCommand!;
      const run = accepted.activeFlowRun!;
      const admission = new ExecutionAdmissionService(store, clock, ids);
      const policy = store.getExecutionProfile(project.executionProfileId).executionPolicy;
      const acquired = admission.admit(command.id, "worker-a", policy, 30_000);
      expect(acquired.outcome).toBe("acquired");
      if (acquired.outcome !== "acquired") throw new Error("expected lease");

      flow.startError = new DispatchCrashpointError("provider-dispatch-started");
      await expect(core.dispatchExecutionCommand(command.id, {
        fence: executionFence(acquired.lease)
      })).rejects.toBeInstanceOf(DispatchCrashpointError);

      clock.advance(31_000);
      const takeover = admission.takeoverForReconciliation(command.id, "worker-b", 60_000);
      expect(takeover).toBeDefined();
      flow.reconcile = async () => ({
        outcome: "found", externalRunId: "zf-run-1", status: "completed", quiescent: false, metadata: {}
      });
      await core.reconcileExecutionCommand(command.id, executionFence(takeover!));
      expect(store.getTask(task.id).status).toBe("blocked");
      expect(store.getExecutionCommand(command.id).status).toBe("reconciling");

      const terminalEvent = {
        contractVersion: 1 as const, callbackVersion: 1 as const, producer: "zigma-flow" as const,
        eventId: "terminal-after-block", flowRunId: run.id, operationId: command.operationId,
        callbackCorrelationId: command.callbackCorrelationId, type: "run.completed" as const,
        status: "completed" as const, externalRunId: "zf-run-1", sequence: 1,
        occurredAt: "2026-07-20T04:00:00.000Z", payload: {}
      };
      const projected = core.recordFlowEvent(run.id, terminalEvent);
      expect(projected.task.status).toBe("completed");
      expect(projected.activeFlowRun?.status).toBe("completed");

      clock.advance(61_000);
      const secondTakeover = admission.takeoverForReconciliation(command.id, "worker-c", 60_000);
      expect(secondTakeover).toBeDefined();
      flow.reconcile = async () => ({
        outcome: "found", externalRunId: "zf-run-1", status: "completed", quiescent: true, metadata: {}
      });
      await core.reconcileExecutionCommand(command.id, executionFence(secondTakeover!));
      expect(store.getExecutionCommand(command.id).status).toBe("completed");
      expect(store.getFlowRun(run.id).metrics?.counters).toMatchObject({
        completed: 1,
        reconcile_restarts: 1
      });
    });
  });
});


describe("reconciliation diagnostics", () => {
  it("preserves the dispatch cause and does not duplicate unchanged audit records", async () => {
    const clock = new ManualClock();
    const {core,flow,store,project,task,ids} = setup({executionMode:"asynchronous",clock});
    const accepted = await core.startTask(task.id,{...startInput(),idempotencyKey:"reconcile-cause"});
    flow.startError = new Error("original launch failure");
    let inspections=0;
    flow.reconcile = async () => { inspections++; return {outcome:"unknown",reason:"Core has no external Flow run id to inspect",metadata:{}}; };
    const runtime = new AsyncExecutionRuntime(store,core,new ExecutionAdmissionService(store,clock,ids),{
      ownerId:"cause-worker",policyFor:()=>store.getExecutionProfile(project.executionProfileId).executionPolicy
    });
    await runtime.runOnce();
    expect(store.getExecutionCommand(accepted.executionCommand!.id).lastError).toContain("original launch failure");
    const admission = new ExecutionAdmissionService(store,clock,ids);
    const lease=admission.takeoverForReconciliation(accepted.executionCommand!.id,"cause-worker",30000)!;
    const fence=executionFence(lease);
    await core.reconcileExecutionCommand(accepted.executionCommand!.id,fence);
    const count=core.listTaskAudit(task.id).length;
    await core.reconcileExecutionCommand(accepted.executionCommand!.id,fence);
    expect(core.listTaskAudit(task.id)).toHaveLength(count);
    expect(store.getExecutionCommand(accepted.executionCommand!.id).lastError).toContain("original launch failure");
    await runtime.runOnce();
    const inspectionsBeforePoll=inspections;
    await runtime.runOnce();
    expect(inspections).toBe(inspectionsBeforePoll);
  });
});
