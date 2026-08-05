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
import type { Clock, FlowExecutor, IdGenerator, WorkspaceProvider } from "../contracts/ports.js";
import type {
  AuditEvent,
  EvidenceBundle,
  EvidenceItem,
  ExecutionProfile,
  FlowRun,
  HumanDecision,
  HumanGate,
  PermissionSnapshot,
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

export interface CoreServiceDependencies {
  store: SqliteStore;
  flowExecutor: FlowExecutor;
  workspaceProvider?: WorkspaceProvider;
  clock: Clock;
  ids: IdGenerator;
}

export interface TaskView {
  task: Task;
  project: Project;
  flowRuns: FlowRun[];
  activeFlowRun?: FlowRun;
  workspace?: WorkspaceRef;
  evidence?: {
    bundle: EvidenceBundle;
    items: EvidenceItem[];
  };
}

export class CoreService {
  private readonly store: SqliteStore;
  private readonly flowExecutor: FlowExecutor;
  private readonly workspaceProvider?: WorkspaceProvider;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(dependencies: CoreServiceDependencies) {
    this.store = dependencies.store;
    this.flowExecutor = dependencies.flowExecutor;
    this.workspaceProvider = dependencies.workspaceProvider;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
  }

  createExecutionProfile(raw: CreateExecutionProfileInput): ExecutionProfile {
    const input = CreateExecutionProfileInputSchema.parse(raw);
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
        mode: profile.mode
      });
    });
    return profile;
  }

  getExecutionProfile(id: string): ExecutionProfile {
    return this.store.getExecutionProfile(id);
  }

  createProject(raw: CreateProjectInput): Project {
    const input = CreateProjectInputSchema.parse(raw);
    this.store.getExecutionProfile(input.executionProfileId);
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
      ...(evidence ? { evidence } : {})
    };
  }

  async startTask(taskId: string, raw: StartTaskInput): Promise<TaskView> {
    const input = StartTaskInputSchema.parse(raw);
    let task = this.store.getTask(taskId);
    const project = this.store.getProject(task.projectId);
    const profile = this.store.getExecutionProfile(project.executionProfileId);

    this.requireCapability(input.callerContext.capabilities, "task:start");
    this.requireCapability(input.callerContext.capabilities, "workflow:invoke");

    const workflowRef = input.workflowRef ?? project.defaultWorkflowRef;
    const repositoryId = input.repositoryId ?? project.defaultRepositoryId;
    const repository = project.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) {
      throw new ConflictError("Repository is not bound to the project", { projectId: project.id, repositoryId });
    }
    this.assertConstraints(input, workflowRef, repositoryId);

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

    this.store.transaction(() => {
      task = this.transitionTask(task, "queued", input.callerContext.actor);
      task = { ...task, activeFlowRunId: flowRun.id, revision: task.revision + 1, updatedAt: now };
      this.store.updateTask(task, task.revision - 1);
      this.store.insertPermissionSnapshot(permissionSnapshot);
      this.store.insertFlowRun(flowRun);
      this.store.insertEvidenceBundle(bundle);
      this.audit("flow-run", flowRun.id, "flow-run.created", input.callerContext.actor, {
        taskId: task.id,
        workflowRef,
        attempt: flowRun.attempt,
        permissionSnapshotId: permissionSnapshot.id
      }, task.id);
    });

    let workspace: WorkspaceRef | undefined;
    try {
      task = this.transitionTask(this.store.getTask(task.id), "provisioning", input.callerContext.actor);
      const branch = input.branch ?? project.workspacePolicy.branchTemplate.replaceAll("{taskId}", task.id).replaceAll("{projectKey}", project.key);
      const baseRef = input.baseRef ?? repository.defaultRef;

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
        command: profile.flowCommand,
        taskId: task.id,
        flowRunId: flowRun.id,
        workflowRef,
        taskText: task.description,
        projectRoot,
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
      throw error instanceof IntegrationError
        ? error
        : new IntegrationError("Failed to start task execution", { taskId: task.id, cause: message });
    }
  }

  recordFlowEvent(flowRunId: string, raw: RecordFlowEventInput): TaskView {
    const input = RecordFlowEventInputSchema.parse(raw);
    const now = this.clock.now();
    const inserted = this.store.insertFlowEvent({
      id: input.eventId,
      flowRunId,
      type: input.type,
      occurredAt: input.occurredAt,
      payload: input.payload,
      createdAt: now
    });
    if (!inserted) {
      return this.getTaskView(this.store.getFlowRun(flowRunId).taskId);
    }

    const run = this.store.getFlowRun(flowRunId);
    const actor = SYSTEM_ACTOR;
    const targetStatus = this.statusForEvent(input.type, input.status);
    const updatedAt = input.occurredAt;
    if (targetStatus) {
      assertFlowTransition(run.status, targetStatus);
      const terminal = ["completed", "failed", "cancelled"].includes(targetStatus);
      this.store.updateFlowRun({
        ...run,
        status: targetStatus,
        ...(input.externalRunId !== undefined ? { externalRunId: input.externalRunId } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        updatedAt,
        ...(terminal ? { completedAt: updatedAt } : {})
      });
      this.syncTaskToFlowStatus(run.taskId, targetStatus, actor, input.error);
    }
    this.audit("flow-run", flowRunId, input.type, actor, {
      eventId: input.eventId,
      status: targetStatus,
      summary: input.summary,
      payload: input.payload
    }, run.taskId, input.eventId);
    return this.getTaskView(run.taskId);
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
      if (run.externalRunId && this.flowExecutor.cancel) {
        const workspace = run.workspaceId ? this.store.getWorkspace(run.workspaceId) : undefined;
        const profile = this.store.getExecutionProfile(run.executionProfileId);
        await this.flowExecutor.cancel({
          command: profile.flowCommand,
          externalRunId: run.externalRunId,
          projectRoot: workspace?.path ?? process.cwd(),
          reason,
          timeoutMs: profile.timeoutMs,
          environment: profile.environment
        });
      }
      if (!["completed", "failed", "cancelled"].includes(run.status)) {
        const now = this.clock.now();
        assertFlowTransition(run.status, "cancelled");
        this.store.updateFlowRun({ ...run, status: "cancelled", updatedAt: now, completedAt: now });
      }
    }
    return this.transitionTask(task, "cancelled", actor, undefined, { reason });
  }

  listTaskAudit(taskId: string): AuditEvent[] {
    return this.store.listAuditEvents("task", taskId);
  }

  private applyFlowResult(flowRunId: string, result: Awaited<ReturnType<FlowExecutor["start"]>>, actor: { type: "user" | "agent" | "service" | "system"; id: string; displayName?: string; provider?: string; externalId?: string }): void {
    const run = this.store.getFlowRun(flowRunId);
    assertFlowTransition(run.status, result.status);
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
    this.store.transaction(() => {
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
    });
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

  private async collectWorkspaceEvidence(flowRunId: string, profile?: ExecutionProfile): Promise<void> {
    const run = this.store.getFlowRun(flowRunId);
    if (!run.workspaceId || !this.workspaceProvider?.collectEvidence) return;
    const workspace = this.store.getWorkspace(run.workspaceId);
    const resolvedProfile = profile ?? this.store.getExecutionProfile(run.executionProfileId);
    const evidence = await this.workspaceProvider.collectEvidence(workspace.externalId, {
      command: resolvedProfile.workspaceCommand,
      timeoutMs: resolvedProfile.timeoutMs,
      environment: resolvedProfile.environment
    });
    for (const item of evidence.items) {
      this.addEvidenceItem(flowRunId, item);
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
