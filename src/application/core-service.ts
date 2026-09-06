import type {
  AddEvidenceItemInput,
  CreateExecutionProfileInput,
  CreateHumanGateInput,
  CreateProjectInput,
  CreateTaskInput,
  DecideHumanGateInput,
  FinalizeEvidenceInput,
  RecordFlowEventInput,
  StartTaskInput
} from "../contracts/schemas.js";
import {
  AddEvidenceItemInputSchema,
  CreateExecutionProfileInputSchema,
  CreateHumanGateInputSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  DecideHumanGateInputSchema,
  FinalizeEvidenceInputSchema,
  RecordFlowEventInputSchema,
  StartTaskInputSchema
} from "../contracts/schemas.js";
import type {
  Clock,
  ExecutionLeaseFence,
  FlowExecutor,
  IdGenerator,
  WorkspaceProvider
} from "../contracts/ports.js";
import type {
  AuditEvent,
  EvidenceBundle,
  EvidenceItem,
  ExecutionCommand,
  ExecutionProfile,
  FlowRun,
  HumanDecision,
  HumanGate,
  OutboxDelivery,
  PermissionSnapshot,
  ProviderWorkspaceHandle,
  Project,
  Task,
  TaskStatus,
  WorkspaceRef
} from "../domain/models.js";
import { ConflictError, ForbiddenError, IntegrationError, NotFoundError } from "../domain/errors.js";
import {
  assertEvidenceBundleTransition,
  assertFlowTransition,
  assertGateTransition,
  assertTaskTransition
} from "../domain/state-machines.js";
import { SqliteStore } from "../persistence/sqlite-store.js";
import { stableHash } from "./runtime.js";

const SYSTEM_ACTOR = { type: "system", id: "zigma-core" } as const;

function matchesBranchPattern(branch: string, pattern: string): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") {
      expression += ".*";
    } else if (character === "?") {
      expression += ".";
    } else {
      expression += character.replace(/[\\^$.*+()[\]{}|]/g, "\\$&");
    }
  }
  expression += "$";
  return new RegExp(expression, "u").test(branch);
}

export interface CoreServiceDependencies {
  store: SqliteStore;
  flowExecutor: FlowExecutor;
  workspaceProvider?: WorkspaceProvider;
  clock: Clock;
  ids: IdGenerator;
  executionMode?: "synchronous" | "asynchronous";
}

export interface TaskView {
  task: Task;
  project: Project;
  flowRuns: FlowRun[];
  activeFlowRun?: FlowRun;
  workspace?: WorkspaceRef;
  executionCommand?: ExecutionCommand;
  workspaceHandles: ProviderWorkspaceHandle[];
  evidence?: {
    bundle: EvidenceBundle;
    items: EvidenceItem[];
  };
}

export type DispatchExecutionPhase =
  | "lease-acquired"
  | "outbox-claimed"
  | "before-dispatch-marker"
  | "provider-dispatch-started"
  | "provider-response-received"
  | "provider-result-persisted"
  | "outbox-acknowledged";

/** Test-only process-loss signal that intentionally bypasses failure projection. */
export class DispatchCrashpointError extends Error {
  constructor(readonly phase: DispatchExecutionPhase) {
    super(`Simulated process crash after ${phase}`);
    this.name = "DispatchCrashpointError";
  }
}

export interface DispatchExecutionOptions {
  fence: ExecutionLeaseFence;
  onPhase?(phase: DispatchExecutionPhase): void | Promise<void>;
}

type FlowResultProjection = {
  externalRunId: string;
  status: FlowRun["status"];
  exitCode?: number;
  summary?: string;
  metadata: Record<string, unknown>;
};

export class CoreService {
  private readonly store: SqliteStore;
  private readonly flowExecutor: FlowExecutor;
  private readonly workspaceProvider?: WorkspaceProvider;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly executionMode: "synchronous" | "asynchronous";

  constructor(dependencies: CoreServiceDependencies) {
    this.store = dependencies.store;
    this.flowExecutor = dependencies.flowExecutor;
    this.workspaceProvider = dependencies.workspaceProvider;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
    this.executionMode = dependencies.executionMode ?? "synchronous";
  }

  createExecutionProfile(raw: CreateExecutionProfileInput): ExecutionProfile {
    const input = CreateExecutionProfileInputSchema.parse(raw);
    this.assertSupportedExecutionProfile(input.mode);
    const now = this.clock.now();
    const profile: ExecutionProfile = {
      id: this.ids.next("profile"),
      ...input,
      createdAt: now,
      updatedAt: now
    };
    this.store.transaction(() => {
      this.store.insertExecutionProfile(profile);
      this.audit("execution-profile", profile.id, "execution-profile.created", SYSTEM_ACTOR, {
        name: profile.name,
        mode: profile.mode,
        executionPolicy: profile.executionPolicy
      });
    });
    return profile;
  }

  getExecutionProfile(id: string): ExecutionProfile {
    return this.store.getExecutionProfile(id);
  }

  createProject(raw: CreateProjectInput): Project {
    const input = CreateProjectInputSchema.parse(raw);
    const profile = this.store.getExecutionProfile(input.executionProfileId);
    this.assertSupportedExecutionProfile(profile.mode);
    this.assertSupportedWorkspacePolicy(input.workspacePolicy);
    const now = this.clock.now();
    const project: Project = {
      id: this.ids.next("project"),
      key: input.key,
      displayName: input.displayName,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: "active",
      repositories: input.repositories,
      defaultRepositoryId: input.defaultRepositoryId,
      defaultWorkflowRef: input.defaultWorkflowRef,
      executionProfileId: input.executionProfileId,
      workspacePolicy: input.workspacePolicy,
      ...(input.skillProfileRef !== undefined ? { skillProfileRef: input.skillProfileRef } : {}),
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now
    };
    this.store.transaction(() => {
      this.store.insertProject(project);
      this.audit("project", project.id, "project.created", SYSTEM_ACTOR, {
        key: project.key,
        defaultWorkflowRef: project.defaultWorkflowRef,
        repositories: project.repositories.map((repository) => repository.id)
      });
    });
    return project;
  }

  getProject(id: string): Project {
    return this.store.getProject(id);
  }

  createTask(raw: CreateTaskInput): Task {
    const input = CreateTaskInputSchema.parse(raw);
    const project = this.store.getProject(input.projectId);
    if (project.status !== "active") {
      throw new ConflictError("Cannot create a task in an archived project", { projectId: project.id });
    }
    const now = this.clock.now();
    const task: Task = {
      id: this.ids.next("task"),
      projectId: project.id,
      title: input.title,
      description: input.description,
      priority: input.priority,
      source: input.source,
      createdBy: input.createdBy,
      status: "created",
      labels: input.labels,
      metadata: input.metadata,
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    this.store.transaction(() => {
      this.store.insertTask(task);
      this.audit("task", task.id, "task.created", task.createdBy, {
        projectId: task.projectId,
        source: task.source,
        priority: task.priority
      });
    });
    return task;
  }

  getTask(id: string): Task {
    return this.store.getTask(id);
  }

  getTaskView(id: string): TaskView {
    const task = this.store.getTask(id);
    const project = this.store.getProject(task.projectId);
    const flowRuns = this.store.listFlowRunsForTask(task.id);
    const activeFlowRun = task.activeFlowRunId
      ? flowRuns.find((run) => run.id === task.activeFlowRunId)
      : undefined;
    const workspace = activeFlowRun?.workspaceId
      ? this.store.getWorkspace(activeFlowRun.workspaceId)
      : undefined;
    const executionCommand = activeFlowRun
      ? this.store.getExecutionCommandForRun(activeFlowRun.id)
      : undefined;
    const workspaceHandles = activeFlowRun ? this.store.listProviderWorkspaceHandles(activeFlowRun.id) : [];
    let evidence: TaskView["evidence"];
    if (activeFlowRun) {
      try {
        const bundle = this.store.getEvidenceBundleByRun(activeFlowRun.id);
        evidence = { bundle, items: this.store.listEvidenceItems(bundle.id) };
      } catch {
        evidence = undefined;
      }
    }
    return {
      task,
      project,
      flowRuns,
      ...(activeFlowRun ? { activeFlowRun } : {}),
      ...(workspace ? { workspace } : {}),
      ...(executionCommand ? { executionCommand } : {}),
      workspaceHandles,
      ...(evidence ? { evidence } : {})
    };
  }

  async startTask(taskId: string, raw: StartTaskInput): Promise<TaskView> {
    const input = StartTaskInputSchema.parse(raw);
    let task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const profile = this.store.getExecutionProfile(project.executionProfileId);
    this.assertSupportedExecutionProfile(profile.mode);

    this.requireCapability(input.callerContext.capabilities, "task:start");
    this.requireCapability(input.callerContext.capabilities, "workflow:invoke");

    const workflowRef = input.workflowRef ?? project.defaultWorkflowRef;
    const repositoryId = input.repositoryId ?? project.defaultRepositoryId;
    const repository = project.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) {
      throw new ConflictError("Repository is not bound to the project", { projectId: project.id, repositoryId });
    }
    this.assertConstraints(input, workflowRef, repositoryId);
    this.assertSupportedWorkspacePolicy(project.workspacePolicy);

    const baseRef = input.baseRef ?? repository.defaultRef;
    const branch = input.branch ?? project.workspacePolicy.branchTemplate.replaceAll("{taskId}", task.id).replaceAll("{projectKey}", project.key);
    this.assertBranchAllowed(input.callerContext.constraints.branchPatterns, branch);
    this.assertWorkspaceModeAllowed(repository, project.workspacePolicy.mode);
    const commandInput = {
      taskId: task.id, projectId: project.id, workflowRef, repositoryId,
      repositoryUrl: repository.url, baseRef, branch, inputs: input.inputs,
      backend: input.backend ?? "default", parallelism: input.parallelism,
      dryRun: input.dryRun, callerContext: input.callerContext,
      workspacePolicy: project.workspacePolicy
    };
    const inputHash = stableHash(commandInput);
    if (input.idempotencyKey) {
      const existing = this.store.findExecutionCommandByIdempotencyKey(task.id, input.idempotencyKey);
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw new ConflictError("Idempotency key was already used with different execution input", {
            taskId: task.id, idempotencyKey: input.idempotencyKey, executionCommandId: existing.id
          });
        }
        return this.getTaskView(task.id);
      }
    }

    if (!["created", "failed", "blocked"].includes(task.status)) {
      throw new ConflictError("Task cannot be started from its current status", {
        taskId,
        status: task.status
      });
    }

    const now = this.clock.now();
    const permissionSnapshot: PermissionSnapshot = {
      id: this.ids.next("permission"),
      taskId: task.id,
      actor: input.callerContext.actor,
      capabilities: [...new Set(input.callerContext.capabilities)].sort(),
      constraints: input.callerContext.constraints,
      source: input.callerContext.source,
      hash: stableHash(input.callerContext),
      createdAt: now,
      ...(input.callerContext.constraints.expiresAt !== undefined
        ? { expiresAt: input.callerContext.constraints.expiresAt }
        : {})
    };

    const existingRuns = this.store.listFlowRunsForTask(task.id);
    const flowRun: FlowRun = {
      id: this.ids.next("flowrun"),
      taskId: task.id,
      workflowRef,
      executionProfileId: profile.id,
      permissionSnapshotId: permissionSnapshot.id,
      status: "created",
      attempt: existingRuns.length + 1,
      lastCallbackSequence: 0,
      inputs: input.inputs,
      context: {
        zigmaCoreTaskId: task.id,
        zigmaCoreProjectId: project.id,
        permissionSnapshotId: permissionSnapshot.id,
        permissionSnapshotHash: permissionSnapshot.hash,
        repositoryId,
        source: task.source
      },
      createdAt: now,
      updatedAt: now
    };

    const bundle: EvidenceBundle = {
      id: this.ids.next("evidence"),
      taskId: task.id,
      flowRunId: flowRun.id,
      status: "open",
      risks: [],
      conclusions: [],
      createdAt: now,
      updatedAt: now
    };
    const commandId = this.ids.next("command");
    const executionCommand: ExecutionCommand = {
      id: commandId,
      operationId: commandId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      inputHash, taskId: task.id, flowRunId: flowRun.id, projectId: project.id,
      repositoryId, repositoryUrl: repository.url, baseRef,
      backend: input.backend ?? "default", workspacePolicy: project.workspacePolicy,
      permissionSnapshotId: permissionSnapshot.id, callbackCorrelationId: commandId,
      status: "pending", attempt: 0, payload: commandInput, createdAt: now, updatedAt: now
    };
    const outbox: OutboxDelivery = {
      id: this.ids.next("outbox"), topic: "execution-command.requested",
      aggregateId: commandId,
      payload: { commandId, operationId: commandId, flowRunId: flowRun.id, taskId: task.id },
      status: "pending", attempt: 0, availableAt: now, createdAt: now, updatedAt: now
    };

    await this.preflightProviders(profile, project.workspacePolicy.provider !== "none");

    this.store.transaction(() => {
      task = this.transitionTask(task, "queued", input.callerContext.actor);
      task = { ...task, activeFlowRunId: flowRun.id, revision: task.revision + 1, updatedAt: now };
      this.store.updateTask(task, task.revision - 1);
      this.store.insertPermissionSnapshot(permissionSnapshot);
      this.store.insertFlowRun(flowRun);
      this.store.insertEvidenceBundle(bundle);
      this.store.insertExecutionCommand(executionCommand);
      this.store.insertOutboxDelivery(outbox);
      this.audit("flow-run", flowRun.id, "flow-run.created", input.callerContext.actor, {
        taskId: task.id,
        workflowRef,
        attempt: flowRun.attempt,
        permissionSnapshotId: permissionSnapshot.id
      }, task.id);
    });

    if (this.executionMode === "asynchronous") {
      return this.getTaskView(task.id);
    }

    let workspace: WorkspaceRef | undefined;
    try {
      task = this.transitionTask(this.store.getTask(task.id), "provisioning", input.callerContext.actor);
      if (project.workspacePolicy.provider !== "none") {
        if (!this.workspaceProvider) {
          throw new IntegrationError("Project requires a workspace provider, but none is configured", {
            provider: project.workspacePolicy.provider
          });
        }
        this.requireCapability(input.callerContext.capabilities, "workspace:create");
        if (project.workspacePolicy.mode === "writable") {
          this.requireCapability(input.callerContext.capabilities, "workspace:write");
        }
        const prepared = await this.workspaceProvider.prepare({
          projectId: project.id,
          taskId: task.id,
          flowRunId: flowRun.id,
          repository,
          baseRef,
          branch,
          policy: project.workspacePolicy,
          command: profile.workspaceCommand,
          timeoutMs: profile.timeoutMs,
          environment: profile.environment
        });
        const workspaceNow = this.clock.now();
        this.assertPreparedWorkspaceMatchesPolicy(prepared.mode, project.workspacePolicy.mode);
        workspace = {
          id: this.ids.next("workspace"),
          taskId: task.id,
          flowRunId: flowRun.id,
          provider: prepared.provider,
          externalId: prepared.externalId,
          path: prepared.path,
          repositoryUrl: prepared.repositoryUrl,
          baseRef: prepared.baseRef,
          baseCommit: prepared.baseCommit,
          branch: prepared.branch,
          mode: prepared.mode,
          status: "active",
          metadata: prepared.metadata,
          createdAt: workspaceNow,
          updatedAt: workspaceNow
        };
        this.store.transaction(() => {
          this.store.insertWorkspace(workspace!);
          const currentRun = this.store.getFlowRun(flowRun.id);
          this.store.updateFlowRun({ ...currentRun, workspaceId: workspace!.id, updatedAt: workspaceNow });
          this.audit("workspace", workspace!.id, "workspace.prepared", input.callerContext.actor, {
            externalId: workspace!.externalId,
            path: workspace!.path,
            branch: workspace!.branch,
            baseCommit: workspace!.baseCommit
          }, task.id);
        });
        await this.workspaceProvider.bindRun?.(prepared.externalId, task.id, flowRun.id, {
          command: profile.workspaceCommand,
          timeoutMs: profile.timeoutMs,
          environment: profile.environment
        });
      }

      const startTime = this.clock.now();
      const runBeforeStart = this.store.getFlowRun(flowRun.id);
      assertFlowTransition(runBeforeStart.status, "starting");
      this.store.updateFlowRun({ ...runBeforeStart, status: "starting", startedAt: startTime, updatedAt: startTime });
      task = this.transitionTask(this.store.getTask(task.id), "running", input.callerContext.actor);

      const projectRoot = workspace?.path ?? String(project.metadata["projectRoot"] ?? process.cwd());
      const result = await this.flowExecutor.start({
        operationId: executionCommand.operationId,
        callbackCorrelationId: executionCommand.callbackCorrelationId,
        command: profile.flowCommand,
        projectId: project.id,
        taskId: task.id,
        flowRunId: flowRun.id,
        workflowRef,
        taskText: task.description,
        projectRoot,
        repository,
        baseRef,
        workspacePolicy: project.workspacePolicy,
        inputs: {
          ...input.inputs,
          zigma_core_task_id: task.id,
          zigma_core_flow_run_id: flowRun.id,
          zigma_core_permission_snapshot_id: permissionSnapshot.id,
          zigma_core_permission_snapshot_hash: permissionSnapshot.hash,
          ...(workspace ? { zigma_workspace_id: workspace.externalId } : {})
        },
        callerContext: input.callerContext,
        permissionSnapshotId: permissionSnapshot.id,
        integrityHash: permissionSnapshot.hash,
        coreCallbackUrl: process.env["ZIGMA_CORE_URL"] ?? "http://127.0.0.1:4736/v1",
        ...(input.backend !== undefined ? { backend: input.backend } : {}),
        ...(input.parallelism !== undefined ? { parallelism: input.parallelism } : {}),
        timeoutMs: input.callerContext.constraints.maxRunDurationMs ?? profile.timeoutMs,
        environment: profile.environment,
        dryRun: input.dryRun
      });

      this.applyFlowResult(flowRun.id, result, input.callerContext.actor);
      const completedAt = this.clock.now();
      this.store.updateExecutionCommand({ ...executionCommand, status: "completed", attempt: 1, updatedAt: completedAt, completedAt });
      try {
        await this.collectWorkspaceEvidence(flowRun.id, profile);
      } catch (evidenceError) {
        const message = evidenceError instanceof Error ? evidenceError.message : String(evidenceError);
        this.markEvidenceCollectionIncomplete(flowRun.id, task.id, message);
      }
      return this.getTaskView(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const currentRun = this.store.getFlowRun(flowRun.id);
      if (!["completed", "failed", "cancelled"].includes(currentRun.status)) {
        const failureAt = this.clock.now();
        const failedRun: FlowRun = {
          ...currentRun,
          status: "failed",
          error: { code: "START_FAILED", message, details: {} },
          updatedAt: failureAt,
          completedAt: failureAt
        };
        this.store.updateFlowRun(failedRun);
        const currentTask = this.store.getTask(task.id);
        if (!["completed", "failed", "cancelled"].includes(currentTask.status)) {
          this.transitionTask(currentTask, "failed", SYSTEM_ACTOR, {
            code: "START_FAILED",
            message,
            details: {}
          });
        }
      }
      const failedAt = this.clock.now();
      this.store.updateExecutionCommand({ ...executionCommand, status: "failed", attempt: 1, lastError: message, updatedAt: failedAt, completedAt: failedAt });
      throw error instanceof IntegrationError
        ? error
        : new IntegrationError("Failed to start task execution", { taskId: task.id, cause: message });
    }
  }

  async dispatchExecutionCommand(commandId: string, options: DispatchExecutionOptions): Promise<TaskView> {
    let command = this.store.getExecutionCommand(commandId);
    if (["completed", "failed", "cancelled"].includes(command.status)) return this.getTaskView(command.taskId);
    if (options.fence.commandId !== commandId) {
      throw new ConflictError("Execution fence does not belong to the dispatched command", {
        commandId,
        fenceCommandId: options.fence.commandId
      });
    }
    this.store.assertExecutionFence(options.fence, this.clock.now());

    const task = this.store.getTask(command.taskId);
    const project = this.store.getProject(command.projectId);
    const profile = this.store.getExecutionProfile(project.executionProfileId);
    this.assertSupportedExecutionProfile(profile.mode);
    const run = this.store.getFlowRun(command.flowRunId);
    const permissionSnapshot = this.store.getPermissionSnapshot(command.permissionSnapshotId);
    const payload = command.payload as {
      workflowRef: string; branch: string; inputs: Record<string, string>;
      parallelism?: number; dryRun: boolean; callerContext: StartTaskInput["callerContext"];
      cancellationReason?: string;
    };
    let workspace: WorkspaceRef | undefined;

    try {
      this.assertSupportedWorkspacePolicy(command.workspacePolicy);
      await this.preflightProviders(profile, command.workspacePolicy.provider !== "none");
      const repository = project.repositories.find((candidate) => candidate.id === command.repositoryId);
      if (!repository) throw new ConflictError("Repository is not bound to the project", { repositoryId: command.repositoryId });
      this.assertBranchAllowed(payload.callerContext.constraints.branchPatterns, payload.branch);
      this.assertWorkspaceModeAllowed(repository, command.workspacePolicy.mode);

      const admittedAt = this.clock.now();
      this.store.fencedTransaction(options.fence, admittedAt, () => {
        let currentTask = this.store.getTask(task.id);
        if (currentTask.status === "blocked") currentTask = this.transitionTask(currentTask, "queued", payload.callerContext.actor);
        if (currentTask.status === "queued") this.transitionTask(currentTask, "provisioning", payload.callerContext.actor);
        const latest = this.store.getExecutionCommand(command.id);
        this.store.updateExecutionCommand({ ...latest, attempt: latest.attempt + 1, updatedAt: admittedAt });
      });
      // This seam lets the regression test interleave a cancellation precisely
      // between admission and the durable provider-dispatch boundary.
      await options.onPhase?.("before-dispatch-marker");

      // Persist this boundary before *any* provider-owned mutation, including
      // Workspace preparation. Workspace's current CLI contract has stable
      // operation identities but not a fenced read-back API, so a process loss
      // after this point must reconcile rather than replay a possible side
      // effect.
      const dispatchStartedAt = this.clock.now();
      const dispatchState: {
        decision: "dispatch" | "terminal" | "cancel-before-dispatch" | "cancel-after-dispatch";
      } = { decision: "dispatch" };
      this.store.fencedTransaction(options.fence, dispatchStartedAt, () => {
        const latest = this.store.getExecutionCommand(command.id);
        if (["completed", "failed", "cancelled"].includes(latest.status)) {
          dispatchState.decision = "terminal";
          return;
        }
        if (latest.status === "cancel_requested") {
          dispatchState.decision = latest.dispatchStartedAt ? "cancel-after-dispatch" : "cancel-before-dispatch";
          return;
        }
        this.store.updateExecutionCommand({
          ...latest,
          status: "dispatching",
          dispatchStartedAt,
          updatedAt: dispatchStartedAt
        });
      });
      if (dispatchState.decision === "terminal") return this.getTaskView(task.id);
      if (dispatchState.decision === "cancel-before-dispatch") {
        this.completeCancellationBeforeFlow(command.id, options.fence, payload.callerContext.actor);
        return this.getTaskView(task.id);
      }
      if (dispatchState.decision === "cancel-after-dispatch") {
        this.markReconciliationRequired(
          command.id,
          options.fence,
          "Cancellation arrived after provider dispatch began but before Flow run identity was durable"
        );
        return this.getTaskView(task.id);
      }
      await options.onPhase?.("provider-dispatch-started");
      if (this.store.getExecutionCommand(command.id).status === "cancel_requested") {
        this.markReconciliationRequired(
          command.id,
          options.fence,
          "Cancellation arrived after provider dispatch began but before Flow run identity was durable"
        );
        return this.getTaskView(task.id);
      }

      const currentRun = this.store.getFlowRun(run.id);
      if (currentRun.workspaceId) workspace = this.store.getWorkspace(currentRun.workspaceId);
      if (!workspace && command.workspacePolicy.provider !== "none") {
        if (!this.workspaceProvider) throw new IntegrationError("Project requires a workspace provider, but none is configured");
        this.assertMutatingProviderFence(options.fence);
        const prepared = await this.workspaceProvider.prepare({
          operationId: `${command.operationId}:workspace:create`,
          executionFence: options.fence,
          projectId: project.id, taskId: task.id, flowRunId: run.id, repository,
          baseRef: command.baseRef, branch: payload.branch, policy: command.workspacePolicy,
          command: profile.workspaceCommand, timeoutMs: profile.timeoutMs, environment: profile.environment
        });
        const workspaceNow = this.clock.now();
        this.assertPreparedWorkspaceMatchesPolicy(prepared.mode, command.workspacePolicy.mode);
        workspace = {
          id: this.ids.next("workspace"), taskId: task.id, flowRunId: run.id,
          provider: prepared.provider, externalId: prepared.externalId, path: prepared.path,
          repositoryUrl: prepared.repositoryUrl, baseRef: prepared.baseRef, baseCommit: prepared.baseCommit,
          branch: prepared.branch, mode: prepared.mode, status: "active", metadata: prepared.metadata,
          createdAt: workspaceNow, updatedAt: workspaceNow
        };
        this.store.fencedTransaction(options.fence, workspaceNow, () => {
          this.store.insertWorkspace(workspace!);
          this.store.updateFlowRun({ ...this.store.getFlowRun(run.id), workspaceId: workspace!.id, updatedAt: workspaceNow });
        });

        if (this.store.getExecutionCommand(command.id).status === "cancel_requested") {
          this.markReconciliationRequired(
            command.id,
            options.fence,
            "Cancellation arrived after Workspace preparation; Flow run identity requires reconciliation"
          );
          return this.getTaskView(task.id);
        }
        this.assertMutatingProviderFence(options.fence);
        await this.workspaceProvider.bindRun?.(prepared.externalId, task.id, run.id, {
          command: profile.workspaceCommand,
          timeoutMs: profile.timeoutMs,
          environment: profile.environment,
          operationId: `${command.operationId}:workspace:bind`,
          executionFence: options.fence
        });
      }

      if (this.store.getExecutionCommand(command.id).status === "cancel_requested") {
        this.markReconciliationRequired(
          command.id,
          options.fence,
          "Cancellation arrived after provider dispatch began but before Flow invocation"
        );
        return this.getTaskView(task.id);
      }

      const startedAt = this.clock.now();
      this.store.fencedTransaction(options.fence, startedAt, () => {
        const runBeforeStart = this.store.getFlowRun(run.id);
        if (runBeforeStart.status === "created") {
          assertFlowTransition(runBeforeStart.status, "starting");
          this.store.updateFlowRun({ ...runBeforeStart, status: "starting", startedAt, updatedAt: startedAt });
        }
        const taskBeforeInvoke = this.store.getTask(task.id);
        if (taskBeforeInvoke.status === "provisioning") this.transitionTask(taskBeforeInvoke, "running", payload.callerContext.actor);
        // dispatchStartedAt was committed before any Workspace/Flow provider
        // mutation above. Do not move this marker behind a side effect.
      });
      this.assertMutatingProviderFence(options.fence);

      const result = await this.flowExecutor.start({
        operationId: command.operationId,
        executionFence: options.fence,
        callbackCorrelationId: command.callbackCorrelationId,
        command: profile.flowCommand, projectId: project.id, taskId: task.id, flowRunId: run.id,
        workflowRef: payload.workflowRef, taskText: task.description,
        projectRoot: workspace?.path ?? String(project.metadata["projectRoot"] ?? process.cwd()),
        repository, baseRef: command.baseRef, workspacePolicy: command.workspacePolicy,
        inputs: { ...payload.inputs, zigma_core_task_id: task.id, zigma_core_flow_run_id: run.id,
          zigma_core_permission_snapshot_id: permissionSnapshot.id,
          zigma_core_permission_snapshot_hash: permissionSnapshot.hash,
          ...(workspace ? { zigma_workspace_id: workspace.externalId } : {}) },
        callerContext: payload.callerContext, permissionSnapshotId: permissionSnapshot.id,
        integrityHash: permissionSnapshot.hash,
        coreCallbackUrl: process.env["ZIGMA_CORE_URL"] ?? "http://127.0.0.1:4736/v1",
        ...(command.backend !== "default" ? { backend: command.backend } : {}),
        ...(payload.parallelism !== undefined ? { parallelism: payload.parallelism } : {}),
        timeoutMs: payload.callerContext.constraints.maxRunDurationMs ?? profile.timeoutMs,
        environment: profile.environment, dryRun: payload.dryRun
      });
      await options.onPhase?.("provider-response-received");

      const responseAt = this.clock.now();
      this.store.fencedTransaction(options.fence, responseAt, () => {
        this.applyFlowResultState(run.id, result, payload.callerContext.actor);
        const latest = this.store.getExecutionCommand(command.id);
        const cancellationStillPending = latest.status === "cancel_requested"
          && !["completed", "failed", "cancelled"].includes(result.status);
        this.store.updateExecutionCommand({
          ...latest,
          status: cancellationStillPending
            ? "cancel_requested"
            : result.status === "cancelled"
              ? "cancelled"
              : result.status === "failed"
                ? "failed"
                : result.status === "completed"
                  ? "completed"
                  : "dispatched",
          providerResponse: this.flowResultRecord(result),
          updatedAt: responseAt,
          ...(!cancellationStillPending && ["completed", "failed", "cancelled"].includes(result.status)
            ? { completedAt: responseAt }
            : {})
        });
      });
      await options.onPhase?.("provider-result-persisted");

      const afterResult = this.store.getExecutionCommand(command.id);
      if (afterResult.status === "cancel_requested") {
        await this.propagateCancellation(
          afterResult,
          options.fence,
          payload.cancellationReason ?? "Cancellation requested while provider dispatch was active",
          payload.callerContext.actor
        );
      }

      try { await this.collectWorkspaceEvidence(run.id, profile, options.fence); }
      catch (error) { this.markEvidenceCollectionIncomplete(run.id, task.id, error instanceof Error ? error.message : String(error)); }
      return this.getTaskView(task.id);
    } catch (error) {
      if (error instanceof DispatchCrashpointError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = this.clock.now();
      try {
        this.store.fencedTransaction(options.fence, failedAt, () => {
          const latestCommand = this.store.getExecutionCommand(command.id);
          const currentRun = this.store.getFlowRun(run.id);
          const currentTask = this.store.getTask(task.id);
          if (latestCommand.status === "cancel_requested") {
            this.store.updateExecutionCommand({ ...latestCommand, lastError: message, updatedAt: failedAt });
            return;
          }
          if (latestCommand.status === "leased" && latestCommand.attempt < 3) {
            if (currentTask.status === "provisioning") this.transitionTask(currentTask, "blocked", SYSTEM_ACTOR, undefined, { retryable: true, attempt: latestCommand.attempt });
            this.store.updateExecutionCommand({ ...latestCommand, status: "pending", lastError: message, updatedAt: failedAt });
            return;
          }
          if (["dispatching", "dispatched", "reconciling"].includes(latestCommand.status)) {
            if (["running", "provisioning"].includes(currentTask.status)) this.transitionTask(currentTask, "blocked", SYSTEM_ACTOR, undefined, { reconciliationRequired: true });
            this.store.updateExecutionCommand({ ...latestCommand, status: "reconciling", lastError: message, updatedAt: failedAt });
            return;
          }
          if (!["completed", "failed", "cancelled"].includes(currentRun.status)) {
            this.store.updateFlowRun({ ...currentRun, status: "failed", error: { code: "DISPATCH_FAILED", message, details: {} }, updatedAt: failedAt, completedAt: failedAt });
            const refreshedTask = this.store.getTask(task.id);
            if (!["completed", "failed", "cancelled"].includes(refreshedTask.status)) this.transitionTask(refreshedTask, "failed", SYSTEM_ACTOR, { code: "DISPATCH_FAILED", message, details: {} });
          }
          this.store.updateExecutionCommand({ ...latestCommand, status: "failed", lastError: message, updatedAt: failedAt, completedAt: failedAt });
        });
      } catch (commitError) {
        if (commitError instanceof ConflictError) throw commitError;
        throw error;
      }
      throw error;
    }
  }

  /**
   * Reconstructs an interrupted delivery from provider-owned truth.  A provider
   * that cannot inspect an operation is deliberately not treated as a negative
   * result: the command remains reconciliation-required and retains capacity.
   */
  async reconcileExecutionCommand(commandId: string, fence: ExecutionLeaseFence): Promise<void> {
    if (fence.commandId !== commandId) {
      throw new ConflictError("Execution fence does not belong to the reconciled command", {
        commandId,
        fenceCommandId: fence.commandId
      });
    }
    const command = this.store.getExecutionCommand(commandId);
    if (["completed", "failed", "cancelled"].includes(command.status)) return;
    this.store.assertExecutionFence(fence, this.clock.now());

    // The dispatch-start marker is committed before the first provider call.
    // Its absence is durable proof that retrying is safe, even if an outbox
    // claim was interrupted before the call was made.
    if (!command.dispatchStartedAt) {
      this.store.resetExecutionForRedispatch(
        command.id,
        fence,
        this.clock.now(),
        "Recovered an interrupted claim before provider dispatch began"
      );
      return;
    }

    const run = this.store.getFlowRun(command.flowRunId);
    const profile = this.store.getExecutionProfile(run.executionProfileId);
    const workspace = run.workspaceId ? this.store.getWorkspace(run.workspaceId) : undefined;
    if (!this.flowExecutor.reconcile) {
      this.markReconciliationRequired(
        command.id,
        fence,
        "Flow provider does not advertise an operation inspection capability"
      );
      return;
    }

    this.assertMutatingProviderFence(fence);
    const result = await this.flowExecutor.reconcile({
      operationId: command.operationId,
      executionFence: fence,
      ...(run.externalRunId ? { externalRunId: run.externalRunId } : {}),
      command: profile.flowCommand,
      projectRoot: workspace?.path ?? process.cwd(),
      timeoutMs: profile.timeoutMs,
      environment: profile.environment
    });

    if (result.outcome === "not_found") {
      if (result.safeToRedispatch) {
        this.store.resetExecutionForRedispatch(
          command.id,
          fence,
          this.clock.now(),
          "Provider fenced the missing operation and explicitly permits redispatch"
        );
      } else {
        this.markReconciliationRequired(command.id, fence, "Provider could not prove that redispatch is safe");
      }
      return;
    }
    if (result.outcome === "unsupported" || result.outcome === "unknown") {
      this.markReconciliationRequired(command.id, fence, result.reason);
      return;
    }
    if (result.outcome !== "found") {
      this.markReconciliationRequired(command.id, fence, "Provider returned an unrecognized reconciliation outcome");
      return;
    }

    if (["completed", "failed", "cancelled"].includes(result.status) && !result.quiescent) {
      this.markReconciliationRequired(
        command.id,
        fence,
        "Provider reported a terminal result without quiescent proof"
      );
      return;
    }

    const reconciledAt = this.clock.now();
    this.store.fencedTransaction(fence, reconciledAt, () => {
      const currentCommand = this.store.getExecutionCommand(command.id);
      const currentRun = this.store.getFlowRun(command.flowRunId);
      const reconciledResult = {
        externalRunId: result.externalRunId,
        status: result.status,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        metadata: { ...result.metadata, reconciled: true }
      };
      this.applyFlowResultState(currentRun.id, reconciledResult, SYSTEM_ACTOR);
      const terminal = ["completed", "failed", "cancelled"].includes(result.status);
      this.store.updateExecutionCommand({
        ...currentCommand,
        status: terminal
          ? result.status === "cancelled"
            ? "cancelled"
            : result.status === "failed"
              ? "failed"
              : "completed"
          : currentCommand.status === "cancel_requested"
            ? "cancel_requested"
            : "reconciling",
        providerResponse: this.flowResultRecord(reconciledResult),
        ...(currentCommand.status === "cancel_requested" && result.status === "cancelled"
          ? { cancelAcknowledgedAt: reconciledAt }
          : {}),
        updatedAt: reconciledAt,
        ...(terminal ? { completedAt: reconciledAt } : {})
      });
    });

    const refreshed = this.store.getExecutionCommand(command.id);
    if (refreshed.status === "cancel_requested") {
      await this.propagateCancellation(
        refreshed,
        fence,
        String((refreshed.payload as Record<string, unknown>)["cancellationReason"] ?? "Cancellation requested during reconciliation"),
        SYSTEM_ACTOR
      );
    }
  }

  private requestAsynchronousCancellation(
    commandId: string,
    reason: string,
    actor: AuditEvent["actor"]
  ): void {
    const now = this.clock.now();
    this.store.transaction(() => {
      const command = this.store.getExecutionCommand(commandId);
      if (["completed", "failed", "cancelled"].includes(command.status)) return;
      if (!command.dispatchStartedAt) {
        this.completeCancellationBeforeFlowState(command, actor, reason, now);
        return;
      }

      const requested: ExecutionCommand = {
        ...command,
        status: "cancel_requested",
        payload: { ...command.payload, cancellationReason: reason },
        cancelRequestedAt: command.cancelRequestedAt ?? now,
        updatedAt: now
      };
      this.store.updateExecutionCommand(requested);
      const task = this.store.getTask(command.taskId);
      if (["provisioning", "running", "awaiting_human"].includes(task.status)) {
        this.transitionTask(task, "blocked", actor, undefined, { cancellationRequested: true, reason });
      }
      this.audit("flow-run", command.flowRunId, "execution-command.cancel-requested", actor, {
        reason,
        dispatchStartedAt: command.dispatchStartedAt
      }, command.taskId);
    });
  }

  private completeCancellationBeforeFlow(
    commandId: string,
    fence: ExecutionLeaseFence,
    actor: AuditEvent["actor"],
    reason = "Cancellation requested before provider dispatch"
  ): void {
    const now = this.clock.now();
    this.store.fencedTransaction(fence, now, () => {
      this.completeCancellationBeforeFlowState(this.store.getExecutionCommand(commandId), actor, reason, now);
    });
  }

  private completeCancellationBeforeFlowState(
    command: ExecutionCommand,
    actor: AuditEvent["actor"],
    reason: string,
    now: string
  ): void {
    if (["completed", "failed", "cancelled"].includes(command.status)) return;
    if (command.dispatchStartedAt) {
      throw new ConflictError("Cannot acknowledge cancellation before Flow after dispatch has started", {
        commandId: command.id,
        dispatchStartedAt: command.dispatchStartedAt
      });
    }
    const run = this.store.getFlowRun(command.flowRunId);
    const task = this.store.getTask(command.taskId);
    this.store.updateExecutionCommand({
      ...command,
      status: "cancelled",
      payload: { ...command.payload, cancellationReason: reason },
      providerResponse: { cancellation: "not-dispatched", quiescent: true },
      cancelRequestedAt: command.cancelRequestedAt ?? now,
      cancelAcknowledgedAt: now,
      updatedAt: now,
      completedAt: now
    });
    this.store.cancelOutboxDeliveryForCommand(command.id, now);
    if (!["completed", "failed", "cancelled"].includes(run.status)) {
      assertFlowTransition(run.status, "cancelled");
      this.store.updateFlowRun({ ...run, status: "cancelled", updatedAt: now, completedAt: now });
    }
    if (!["completed", "failed", "cancelled"].includes(task.status)) {
      this.transitionTask(task, "cancelled", actor, undefined, { reason, quiescent: true, providerDispatched: false });
    }
    this.audit("flow-run", command.flowRunId, "execution-command.cancel-acknowledged", actor, {
      reason,
      quiescent: true,
      providerDispatched: false
    }, command.taskId);
  }

  private async propagateCancellation(
    command: ExecutionCommand,
    fence: ExecutionLeaseFence,
    reason: string,
    actor: AuditEvent["actor"]
  ): Promise<void> {
    const run = this.store.getFlowRun(command.flowRunId);
    if (!run.externalRunId || !this.flowExecutor.cancel) {
      this.markReconciliationRequired(
        command.id,
        fence,
        !run.externalRunId
          ? "Cancellation cannot be delivered until provider operation identity is reconciled"
          : "Flow provider does not advertise cancellation quiescence"
      );
      return;
    }
    const profile = this.store.getExecutionProfile(run.executionProfileId);
    const workspace = run.workspaceId ? this.store.getWorkspace(run.workspaceId) : undefined;
    this.assertMutatingProviderFence(fence);
    let result: Awaited<ReturnType<NonNullable<FlowExecutor["cancel"]>>>;
    try {
      result = await this.flowExecutor.cancel({
        operationId: command.operationId,
        executionFence: fence,
        command: profile.flowCommand,
        externalRunId: run.externalRunId,
        projectRoot: workspace?.path ?? process.cwd(),
        reason,
        timeoutMs: profile.timeoutMs,
        environment: profile.environment
      });
    } catch (error) {
      this.markReconciliationRequired(
        command.id,
        fence,
        `Cancellation delivery failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    if (!result.quiescent) {
      this.markReconciliationRequired(command.id, fence, "Flow cancellation response lacked quiescent proof");
      return;
    }

    const acknowledgedAt = this.clock.now();
    this.store.fencedTransaction(fence, acknowledgedAt, () => {
      const current = this.store.getExecutionCommand(command.id);
      if (["completed", "failed", "cancelled"].includes(current.status)) return;
      this.applyFlowResultState(command.flowRunId, result, actor);
      this.store.updateExecutionCommand({
        ...current,
        status: result.status === "cancelled" ? "cancelled" : result.status === "failed" ? "failed" : "completed",
        providerResponse: this.flowResultRecord(result),
        cancelRequestedAt: current.cancelRequestedAt ?? acknowledgedAt,
        cancelAcknowledgedAt: acknowledgedAt,
        updatedAt: acknowledgedAt,
        completedAt: acknowledgedAt
      });
      this.audit("flow-run", command.flowRunId, "execution-command.cancel-acknowledged", actor, {
        reason,
        quiescent: true,
        providerStatus: result.status
      }, command.taskId);
    });
  }

  private markReconciliationRequired(commandId: string, fence: ExecutionLeaseFence, reason: string): void {
    const now = this.clock.now();
    this.store.fencedTransaction(fence, now, () => {
      const command = this.store.getExecutionCommand(commandId);
      if (["completed", "failed", "cancelled"].includes(command.status)) return;
      this.store.updateExecutionCommand({
        ...command,
        ...(command.status === "cancel_requested" ? {} : { status: "reconciling" }),
        lastError: reason,
        updatedAt: now
      });
      const task = this.store.getTask(command.taskId);
      if (["provisioning", "running", "awaiting_human"].includes(task.status)) {
        this.transitionTask(task, "blocked", SYSTEM_ACTOR, undefined, { reconciliationRequired: true, reason });
      }
      this.audit("flow-run", command.flowRunId, "execution-command.reconciliation-required", SYSTEM_ACTOR, {
        reason
      }, command.taskId);
    });
  }

  private assertMutatingProviderFence(fence: ExecutionLeaseFence): void {
    this.store.assertExecutionFence(fence, this.clock.now());
  }

  private flowResultRecord(result: FlowResultProjection): Record<string, unknown> {
    return {
      externalRunId: result.externalRunId,
      status: result.status,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      metadata: result.metadata
    };
  }

  private async preflightProviders(
    profile: ExecutionProfile,
    requiresWorkspace: boolean
  ): Promise<void> {
    const context = {
      timeoutMs: profile.timeoutMs,
      environment: profile.environment
    };
    await this.flowExecutor.preflight({ ...context, command: profile.flowCommand });
    if (!requiresWorkspace) return;
    if (!this.workspaceProvider) {
      throw new IntegrationError("Project requires a workspace provider, but none is configured");
    }
    await this.workspaceProvider.preflight({ ...context, command: profile.workspaceCommand });
  }

  recordFlowEvent(flowRunId: string, raw: RecordFlowEventInput): TaskView {
    const input = RecordFlowEventInputSchema.parse(raw);
    const now = this.clock.now();
    const run = this.store.getFlowRun(flowRunId);
    const command = this.store.getExecutionCommandForRun(flowRunId);
    if (input.flowRunId && input.flowRunId !== flowRunId) {
      throw new ConflictError("Flow callback flowRunId does not match the callback target", { flowRunId, callbackFlowRunId: input.flowRunId });
    }
    if (input.operationId && input.operationId !== command?.operationId) {
      throw new ConflictError("Flow event operationId does not match the execution command", { flowRunId, operationId: input.operationId });
    }
    if (input.callbackCorrelationId && input.callbackCorrelationId !== command?.callbackCorrelationId) {
      throw new ConflictError("Flow event callback correlation does not match the execution command", { flowRunId, callbackCorrelationId: input.callbackCorrelationId });
    }
    if (input.externalRunId && run.externalRunId && input.externalRunId !== run.externalRunId) {
      throw new ConflictError("Flow callback external run identity does not match the bound Flow run", {
        flowRunId, externalRunId: input.externalRunId, boundExternalRunId: run.externalRunId
      });
    }
    const callbackHash = stableHash({
      contractVersion: input.contractVersion,
      callbackVersion: input.callbackVersion,
      producer: input.producer,
      eventId: input.eventId,
      operationId: input.operationId,
      callbackCorrelationId: input.callbackCorrelationId,
      externalRunId: input.externalRunId,
      sequence: input.sequence,
      type: input.type,
      occurredAt: input.occurredAt,
      status: input.status,
      summary: input.summary,
      error: input.error,
      workspace: input.workspace,
      evidence: input.evidence,
      payload: input.payload
    });
    return this.store.transaction(() => {
    let currentRun = this.store.getFlowRun(flowRunId);
    if (input.callbackVersion === 1) {
      const sequence = input.sequence!;
      const existing = this.store.getFlowEvent(input.eventId);
      if (existing) {
        if (existing.flowRunId === flowRunId && existing.inputHash === callbackHash) return this.getTaskView(currentRun.taskId);
        throw new ConflictError("Flow event id was reused with different content", { eventId: input.eventId, flowRunId });
      }
      if (sequence <= currentRun.lastCallbackSequence) {
        throw new ConflictError("Flow callback sequence is stale", {
          flowRunId, sequence, lastCallbackSequence: currentRun.lastCallbackSequence
        });
      }
      if (currentRun.externalRunId && currentRun.externalRunId !== input.externalRunId) {
        throw new ConflictError("Flow callback external run identity does not match the bound Flow run", {
          flowRunId, externalRunId: input.externalRunId, boundExternalRunId: currentRun.externalRunId
        });
      }
    }
    const inserted = this.store.insertFlowEvent({
      id: input.eventId, flowRunId, type: input.type, occurredAt: input.occurredAt,
      payload: input.payload,
      inputHash: callbackHash,
      ...(input.sequence !== undefined ? { callbackSequence: input.sequence } : {}),
      createdAt: now
    });
    if (!inserted) return this.getTaskView(currentRun.taskId);

    if (input.callbackVersion === 1) {
      currentRun = {
        ...currentRun,
        lastCallbackSequence: input.sequence!,
        externalRunId: input.externalRunId!,
        updatedAt: now
      };
    }

    const actor = SYSTEM_ACTOR;
    const targetStatus = this.statusForEvent(input.type, input.status);
    const updatedAt = input.occurredAt;
    const runIsTerminal = ["completed", "failed", "cancelled"].includes(currentRun.status);
    const targetIsTerminal = targetStatus ? ["completed", "failed", "cancelled"].includes(targetStatus) : false;
    if (targetStatus && !(runIsTerminal && !targetIsTerminal)) {
      assertFlowTransition(currentRun.status, targetStatus);
      const terminal = ["completed", "failed", "cancelled"].includes(targetStatus);
      this.store.updateFlowRun({
        ...currentRun,
        status: targetStatus,
        ...(input.externalRunId !== undefined ? { externalRunId: input.externalRunId } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        updatedAt,
        ...(terminal ? { completedAt: updatedAt } : {})
      });
      this.syncTaskToFlowStatus(currentRun.taskId, targetStatus, actor, input.error);
    } else if (input.callbackVersion === 1) {
      this.store.updateFlowRun(currentRun);
    }
    if (input.workspace) {
      this.store.upsertProviderWorkspaceHandle({
        id: this.ids.next("workspace-handle"), flowRunId, provider: input.workspace.provider,
        externalId: input.workspace.externalId, scope: input.workspace.scope,
        ...(input.workspace.jobId ? { jobId: input.workspace.jobId } : {}),
        ...(input.workspace.attempt ? { attempt: input.workspace.attempt } : {}),
        status: input.workspace.status,
        ...(input.workspace.path ? { path: input.workspace.path } : {}),
        ...(input.workspace.repositoryUrl ? { repositoryUrl: input.workspace.repositoryUrl } : {}),
        ...(input.workspace.baseRef ? { baseRef: input.workspace.baseRef } : {}),
        ...(input.workspace.baseCommit ? { baseCommit: input.workspace.baseCommit } : {}),
        ...(input.workspace.branch ? { branch: input.workspace.branch } : {}),
        metadata: input.workspace.metadata, lastEventId: input.eventId, createdAt: now, updatedAt: now
      });
    }
    for (const evidence of input.evidence) this.addEvidenceItem(flowRunId, evidence);
    this.audit("flow-run", flowRunId, input.type, actor, {
      eventId: input.eventId,
      status: targetStatus,
      ignoredStaleTransition: runIsTerminal && !targetIsTerminal,
      summary: input.summary,
      payload: input.payload
    }, currentRun.taskId, input.eventId);
    return this.getTaskView(currentRun.taskId);
    });
  }

  createHumanGate(raw: CreateHumanGateInput): HumanGate {
    const input = CreateHumanGateInputSchema.parse(raw);
    const run = this.store.getFlowRun(input.flowRunId);
    if (run.taskId !== input.taskId) {
      throw new ConflictError("Human gate taskId does not match flow run", {
        taskId: input.taskId,
        flowRunTaskId: run.taskId
      });
    }
    const now = this.clock.now();
    const gate: HumanGate = {
      id: this.ids.next("gate"),
      externalGateId: input.externalGateId,
      taskId: input.taskId,
      flowRunId: input.flowRunId,
      jobId: input.jobId,
      stepId: input.stepId,
      prompt: input.prompt,
      inputSchema: input.inputSchema,
      allowedApprovers: input.allowedApprovers,
      status: "awaiting",
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now
    };
    this.store.transaction(() => {
      this.store.insertHumanGate(gate);
      if (run.status !== "awaiting_human") {
        assertFlowTransition(run.status, "awaiting_human");
        this.store.updateFlowRun({ ...run, status: "awaiting_human", updatedAt: now });
      }
      const task = this.store.getTask(input.taskId);
      if (task.status !== "awaiting_human") {
        this.transitionTask(task, "awaiting_human", SYSTEM_ACTOR);
      }
      this.audit("human-gate", gate.id, "human-gate.created", SYSTEM_ACTOR, {
        flowRunId: gate.flowRunId,
        externalGateId: gate.externalGateId,
        jobId: gate.jobId,
        stepId: gate.stepId
      }, gate.taskId);
    });
    return gate;
  }

  async decideHumanGate(gateId: string, raw: DecideHumanGateInput): Promise<HumanGate> {
    const input = DecideHumanGateInputSchema.parse(raw);
    const required = input.decision === "approve" ? "gate:approve" : "gate:reject";
    this.requireCapability(input.callerCapabilities, required);
    let gate = this.store.getHumanGate(gateId);
    if (gate.allowedApprovers.length > 0 && !gate.allowedApprovers.some((actor) => actor.type === input.actor.type && actor.id === input.actor.id)) {
      throw new ForbiddenError("Actor is not an allowed approver for this gate", {
        gateId,
        actor: input.actor
      });
    }
    const target = input.decision === "approve" ? "approved" : "rejected";
    const now = this.clock.now();
    let decision = this.store.getHumanDecision(gateId);
    if (decision) {
      const sameRequest = decision.actor.type === input.actor.type
        && decision.actor.id === input.actor.id
        && decision.decision === input.decision
        && (decision.comment ?? undefined) === (input.comment ?? undefined)
        && stableHash(decision.input) === stableHash(input.input);
      if (!sameRequest || !["decision_pending", "decision_failed"].includes(gate.status)) {
        throw new ConflictError("Human gate already has a different or completed decision", { gateId, status: gate.status });
      }
      assertGateTransition(gate.status, "decision_pending");
      decision = { ...decision, deliveryStatus: "pending", lastError: undefined, updatedAt: now };
      gate = { ...gate, status: "decision_pending", updatedAt: now };
      this.store.transaction(() => {
        this.store.updateHumanDecisionDelivery(decision!);
        this.store.updateHumanGate(gate);
      });
    } else {
      assertGateTransition(gate.status, "decision_pending");
      decision = {
        id: this.ids.next("decision"),
        gateId,
        actor: input.actor,
        decision: input.decision,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        input: input.input,
        deliveryStatus: "pending",
        createdAt: now,
        updatedAt: now
      };
      gate = { ...gate, status: "decision_pending", updatedAt: now };
      this.store.transaction(() => {
        this.store.insertHumanDecision(decision!);
        this.store.updateHumanGate(gate);
        this.audit("human-gate", gate.id, "human-gate.decision-pending", input.actor, {
          decisionId: decision!.id,
          decision: input.decision
        }, gate.taskId);
      });
    }

    const run = this.store.getFlowRun(gate.flowRunId);
    if (!run.externalRunId) {
      return this.failHumanGateDelivery(gate, decision, "Flow run has no externalRunId");
    }
    const workspace = run.workspaceId ? this.store.getWorkspace(run.workspaceId) : undefined;
    try {
      if (!this.flowExecutor.decideGate) {
        throw new Error("Flow executor does not support human gate decisions");
      }
      const profile = this.store.getExecutionProfile(run.executionProfileId);
      await this.flowExecutor.decideGate({
        command: profile.flowCommand,
        externalRunId: run.externalRunId,
        jobId: gate.jobId,
        decision: input.decision,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        input: input.input,
        projectRoot: workspace?.path ?? process.cwd(),
        timeoutMs: profile.timeoutMs,
        environment: profile.environment
      });
    } catch (error) {
      return this.failHumanGateDelivery(gate, decision, error instanceof Error ? error.message : String(error));
    }

    const deliveredAt = this.clock.now();
    const deliveredDecision: HumanDecision = { ...decision, deliveryStatus: "delivered", lastError: undefined, updatedAt: deliveredAt };
    const completedGate: HumanGate = { ...gate, status: target, updatedAt: deliveredAt };
    this.store.transaction(() => {
      this.store.updateHumanDecisionDelivery(deliveredDecision);
      this.store.updateHumanGate(completedGate);
      const bundle = this.store.getEvidenceBundleByRun(gate.flowRunId);
      this.store.insertEvidenceItem({
        id: this.ids.next("item"),
        bundleId: bundle.id,
        kind: "human-decision",
        name: `${gate.jobId}.${gate.stepId}:${input.decision}`,
        uri: `zigma://human-gates/${gate.id}/decisions/${decision.id}`,
        summary: input.comment ?? `Human gate ${input.decision}`,
        metadata: { actor: input.actor, input: input.input },
        createdAt: deliveredAt
      });
      this.audit("human-gate", gate.id, `human-gate.${target}`, input.actor, {
        decisionId: decision.id,
        comment: input.comment,
        input: input.input
      }, gate.taskId);
      const refreshedRun = this.store.getFlowRun(gate.flowRunId);
      if (refreshedRun.status === "awaiting_human") {
        this.store.updateFlowRun({ ...refreshedRun, status: "running", updatedAt: deliveredAt });
      }
      const task = this.store.getTask(gate.taskId);
      if (task.status === "awaiting_human") {
        this.transitionTask(task, input.decision === "approve" ? "running" : "blocked", input.actor);
      }
    });
    return this.store.getHumanGate(gateId);
  }

  private failHumanGateDelivery(gate: HumanGate, decision: HumanDecision, message: string): never {
    const failedAt = this.clock.now();
    const failedDecision: HumanDecision = { ...decision, deliveryStatus: "failed", lastError: message, updatedAt: failedAt };
    const failedGate: HumanGate = { ...gate, status: "decision_failed", updatedAt: failedAt };
    this.store.transaction(() => {
      this.store.updateHumanDecisionDelivery(failedDecision);
      this.store.updateHumanGate(failedGate);
      this.audit("human-gate", gate.id, "human-gate.decision-delivery-failed", decision.actor, {
        decisionId: decision.id,
        error: message
      }, gate.taskId);
    });
    throw new IntegrationError("Failed to deliver human gate decision", {
      gateId: gate.id,
      decisionId: decision.id,
      retryable: true,
      cause: message
    });
  }

  addEvidenceItem(flowRunId: string, raw: AddEvidenceItemInput): EvidenceItem {
    const input = AddEvidenceItemInputSchema.parse(raw);
    const bundle = this.store.getEvidenceBundleByRun(flowRunId);
    if (bundle.status !== "open") {
      throw new ConflictError("Cannot add evidence to a closed bundle", {
        bundleId: bundle.id,
        status: bundle.status
      });
    }
    const item: EvidenceItem = {
      id: this.ids.next("item"),
      bundleId: bundle.id,
      kind: input.kind,
      name: input.name,
      uri: input.uri,
      ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
      ...(input.digest !== undefined ? { digest: input.digest } : {}),
      ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      metadata: input.metadata,
      createdAt: this.clock.now()
    };
    this.store.insertEvidenceItem(item);
    this.audit("evidence-bundle", bundle.id, "evidence-item.added", SYSTEM_ACTOR, {
      itemId: item.id,
      kind: item.kind,
      uri: item.uri
    }, bundle.taskId);
    return item;
  }

  finalizeEvidence(flowRunId: string, raw: FinalizeEvidenceInput): EvidenceBundle {
    const input = FinalizeEvidenceInputSchema.parse(raw);
    const bundle = this.store.getEvidenceBundleByRun(flowRunId);
    if (bundle.status !== "open") return bundle;
    const now = this.clock.now();
    const finalized: EvidenceBundle = {
      ...bundle,
      status: "finalized",
      summary: input.summary,
      risks: input.risks,
      conclusions: input.conclusions,
      updatedAt: now,
      finalizedAt: now
    };
    this.store.updateEvidenceBundle(finalized);
    this.audit("evidence-bundle", bundle.id, "evidence-bundle.finalized", SYSTEM_ACTOR, {
      itemCount: this.store.listEvidenceItems(bundle.id).length,
      riskCount: finalized.risks.length
    }, bundle.taskId);
    return finalized;
  }

  private markEvidenceCollectionIncomplete(flowRunId: string, taskId: string, message: string): void {
    let bundle: EvidenceBundle;
    try {
      bundle = this.store.getEvidenceBundleByRun(flowRunId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      this.audit("task", taskId, "evidence.collection_failed", SYSTEM_ACTOR, {
        flowRunId,
        error: message,
        bundleMissing: true
      }, taskId);
      return;
    }

    assertEvidenceBundleTransition(bundle.status, "incomplete");
    const incomplete: EvidenceBundle = {
      ...bundle,
      status: "incomplete",
      updatedAt: this.clock.now()
    };
    this.store.transaction(() => {
      this.store.updateEvidenceBundle(incomplete);
      this.audit("task", taskId, "evidence.collection_failed", SYSTEM_ACTOR, {
        flowRunId,
        bundleId: bundle.id,
        error: message
      }, taskId);
    });
  }

  getEvidence(flowRunId: string): { bundle: EvidenceBundle; items: EvidenceItem[] } {
    const bundle = this.store.getEvidenceBundleByRun(flowRunId);
    return { bundle, items: this.store.listEvidenceItems(bundle.id) };
  }

  async cancelTask(taskId: string, reason: string, actor = SYSTEM_ACTOR): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      throw new ConflictError("Task is already terminal", { taskId, status: task.status });
    }
    if (task.activeFlowRunId) {
      const run = this.store.getFlowRun(task.activeFlowRunId);
      const command = this.store.getExecutionCommandForRun(run.id);
      if (this.executionMode === "asynchronous" && command) {
        this.requestAsynchronousCancellation(command.id, reason, actor);
        return this.store.getTask(task.id);
      }
      if (run.externalRunId && this.flowExecutor.cancel) {
        const workspace = run.workspaceId ? this.store.getWorkspace(run.workspaceId) : undefined;
        const profile = this.store.getExecutionProfile(run.executionProfileId);
        const result = await this.flowExecutor.cancel({
          ...(command ? { operationId: command.operationId } : {}),
          command: profile.flowCommand,
          externalRunId: run.externalRunId,
          projectRoot: workspace?.path ?? process.cwd(),
          reason,
          timeoutMs: profile.timeoutMs,
          environment: profile.environment
        });
        if (!result.quiescent) {
          throw new IntegrationError("Flow cancellation did not provide quiescent proof", {
            taskId,
            flowRunId: run.id,
            externalRunId: run.externalRunId
          });
        }
        const now = this.clock.now();
        this.store.transaction(() => {
          this.applyFlowResultState(run.id, result, actor);
          if (command && !["completed", "failed", "cancelled"].includes(command.status)) {
            this.store.updateExecutionCommand({
              ...this.store.getExecutionCommand(command.id),
              status: result.status === "cancelled" ? "cancelled" : result.status === "failed" ? "failed" : "completed",
              providerResponse: this.flowResultRecord(result),
              cancelRequestedAt: now,
              cancelAcknowledgedAt: now,
              updatedAt: now,
              completedAt: now
            });
          }
        });
        return this.store.getTask(task.id);
      }
      if (run.externalRunId && !this.flowExecutor.cancel) {
        throw new IntegrationError("Flow executor cannot prove cancellation quiescence", {
          taskId,
          flowRunId: run.id,
          externalRunId: run.externalRunId
        });
      }
      if (!["completed", "failed", "cancelled"].includes(run.status)) {
        const now = this.clock.now();
        assertFlowTransition(run.status, "cancelled");
        this.store.updateFlowRun({ ...run, status: "cancelled", updatedAt: now, completedAt: now });
        if (command && !["completed", "failed", "cancelled"].includes(command.status)) {
          this.store.updateExecutionCommand({ ...command, status: "cancelled", updatedAt: now, completedAt: now });
        }
      }
    }
    return this.transitionTask(task, "cancelled", actor, undefined, { reason });
  }

  listTaskAudit(taskId: string): AuditEvent[] {
    return this.store.listAuditEvents("task", taskId);
  }

  private applyFlowResult(
    flowRunId: string,
    result: FlowResultProjection,
    actor: AuditEvent["actor"]
  ): void {
    this.store.transaction(() => this.applyFlowResultState(flowRunId, result, actor));
  }

  /** Caller owns the surrounding transaction (normal or fenced). */
  private applyFlowResultState(
    flowRunId: string,
    result: FlowResultProjection,
    actor: AuditEvent["actor"]
  ): void {
    const run = this.store.getFlowRun(flowRunId);
    if (run.status !== result.status) assertFlowTransition(run.status, result.status);
    const now = this.clock.now();
    const terminal = ["completed", "failed", "cancelled"].includes(result.status);
    const updated: FlowRun = {
      ...run,
      externalRunId: result.externalRunId,
      status: result.status,
      exitCode: result.exitCode,
      context: { ...run.context, executor: result.metadata, summary: result.summary },
      updatedAt: now,
      ...(terminal ? { completedAt: now } : {})
    };
    this.store.updateFlowRun(updated);
    this.syncTaskToFlowStatus(run.taskId, result.status, actor);
    const bundle = this.store.getEvidenceBundleByRun(run.id);
    this.store.insertEvidenceItem({
      id: this.ids.next("item"),
      bundleId: bundle.id,
      kind: "summary",
      name: "flow-result",
      uri: `zigma://flow-runs/${run.id}`,
      summary: result.summary ?? `Flow run finished with status ${result.status}`,
      metadata: { externalRunId: result.externalRunId, exitCode: result.exitCode, ...result.metadata },
      createdAt: now
    });
    this.audit("flow-run", run.id, `flow-run.${result.status}`, actor, {
      externalRunId: result.externalRunId,
      exitCode: result.exitCode,
      summary: result.summary
    }, run.taskId);
  }

  private syncTaskToFlowStatus(taskId: string, status: FlowRun["status"], actor: { type: "user" | "agent" | "service" | "system"; id: string; displayName?: string; provider?: string; externalId?: string }, error?: { code: string; message: string; details: Record<string, unknown> }): void {
    const task = this.store.getTask(taskId);
    const target: TaskStatus | undefined = {
      created: undefined,
      starting: "running",
      running: "running",
      awaiting_human: "awaiting_human",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled"
    }[status] as TaskStatus | undefined;
    if (!target || task.status === target) return;
    this.transitionTask(task, target, actor, error);
  }

  private transitionTask(
    task: Task,
    status: TaskStatus,
    actor: { type: "user" | "agent" | "service" | "system"; id: string; displayName?: string; provider?: string; externalId?: string },
    failure?: { code: string; message: string; details: Record<string, unknown> },
    payload: Record<string, unknown> = {}
  ): Task {
    assertTaskTransition(task.status, status);
    const now = this.clock.now();
    const terminal = ["completed", "failed", "cancelled"].includes(status);
    const updated: Task = {
      ...task,
      status,
      revision: task.revision + 1,
      updatedAt: now,
      ...(failure !== undefined ? { failure } : {}),
      ...(terminal ? { completedAt: now } : {})
    };
    this.store.updateTask(updated, task.revision);
    this.audit("task", task.id, `task.${status}`, actor, {
      previousStatus: task.status,
      status,
      ...payload,
      ...(failure ? { failure } : {})
    }, task.id);
    return updated;
  }

  private async collectWorkspaceEvidence(
    flowRunId: string,
    profile?: ExecutionProfile,
    fence?: ExecutionLeaseFence
  ): Promise<void> {
    const run = this.store.getFlowRun(flowRunId);
    if (!run.workspaceId || !this.workspaceProvider?.collectEvidence) return;
    const workspace = this.store.getWorkspace(run.workspaceId);
    const resolvedProfile = profile ?? this.store.getExecutionProfile(run.executionProfileId);
    if (fence) this.assertMutatingProviderFence(fence);
    const evidence = await this.workspaceProvider.collectEvidence(workspace.externalId, {
      command: resolvedProfile.workspaceCommand,
      timeoutMs: resolvedProfile.timeoutMs,
      environment: resolvedProfile.environment,
      ...(fence ? { executionFence: fence } : {})
    });
    for (const item of evidence.items) {
      if (fence) {
        this.store.fencedTransaction(fence, this.clock.now(), () => this.addEvidenceItem(flowRunId, item));
      } else {
        this.addEvidenceItem(flowRunId, item);
      }
    }
  }

  private assertConstraints(input: StartTaskInput, workflowRef: string, repositoryId: string): void {
    const constraints = input.callerContext.constraints;
    if (constraints.expiresAt && Date.parse(constraints.expiresAt) <= Date.parse(this.clock.now())) {
      throw new ForbiddenError("Caller context has expired", { expiresAt: constraints.expiresAt });
    }
    if (constraints.workflowRefs.length > 0 && !constraints.workflowRefs.includes(workflowRef)) {
      throw new ForbiddenError("Workflow is outside the caller context", { workflowRef });
    }
    if (constraints.repositoryIds.length > 0 && !constraints.repositoryIds.includes(repositoryId)) {
      throw new ForbiddenError("Repository is outside the caller context", { repositoryId });
    }
  }

  private assertBranchAllowed(patterns: readonly string[], branch: string): void {
    if (patterns.length > 0 && !patterns.some((pattern) => matchesBranchPattern(branch, pattern))) {
      throw new ForbiddenError("Branch is outside the caller context", {
        branch,
        branchPatterns: [...patterns]
      });
    }
  }

  private assertSupportedExecutionProfile(mode: ExecutionProfile["mode"]): void {
    if (mode !== "local-cli") {
      throw new ConflictError("Execution profile mode is not wired in this Core runtime", {
        mode,
        supportedModes: ["local-cli"]
      });
    }
  }

  private assertSupportedWorkspacePolicy(policy: Project["workspacePolicy"]): void {
    if (policy.snapshotOnTerminal !== true) {
      throw new ConflictError("Workspace policy snapshotOnTerminal=false is not supported safely yet", {
        snapshotOnTerminal: policy.snapshotOnTerminal
      });
    }
    if (policy.cleanup !== "manual") {
      throw new ConflictError("Automatic workspace cleanup is not supported safely yet", {
        cleanup: policy.cleanup,
        supportedCleanup: "manual"
      });
    }
  }

  private assertWorkspaceModeAllowed(repository: Project["repositories"][number], mode: Project["workspacePolicy"]["mode"]): void {
    if (mode === "writable" && repository.writable === false) {
      throw new ForbiddenError("Repository does not permit writable workspaces", {
        repositoryId: repository.id
      });
    }
  }

  private assertPreparedWorkspaceMatchesPolicy(
    preparedMode: WorkspaceRef["mode"],
    requestedMode: WorkspaceRef["mode"]
  ): void {
    if (preparedMode !== requestedMode) {
      throw new IntegrationError("Workspace provider returned a mode different from the requested policy", {
        requestedMode,
        preparedMode
      });
    }
  }

  private requireCapability(capabilities: readonly string[], capability: string): void {
    if (!capabilities.includes(capability)) {
      throw new ForbiddenError(`Missing capability: ${capability}`, { capability });
    }
  }

  private statusForEvent(type: RecordFlowEventInput["type"], explicit?: FlowRun["status"]): FlowRun["status"] | undefined {
    if (explicit) return explicit;
    return {
      "run.started": "running",
      "run.progress": undefined,
      "run.awaiting-human": "awaiting_human",
      "run.completed": "completed",
      "run.failed": "failed",
      "run.cancelled": "cancelled"
    }[type] as FlowRun["status"] | undefined;
  }

  private audit(
    aggregateType: AuditEvent["aggregateType"],
    aggregateId: string,
    action: string,
    actor: AuditEvent["actor"],
    payload: Record<string, unknown>,
    correlationId?: string,
    causationId?: string
  ): void {
    this.store.insertAuditEvent({
      id: this.ids.next("audit"),
      aggregateType,
      aggregateId,
      action,
      actor,
      payload,
      ...(correlationId !== undefined ? { correlationId } : {}),
      ...(causationId !== undefined ? { causationId } : {}),
      createdAt: this.clock.now()
    });
  }
}
