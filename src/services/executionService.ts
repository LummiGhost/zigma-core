/**
 * Execution service (FR-004, FR-005, FR-007).
 *
 * Starts zigma-flow runs through a FlowInvoker, records FlowRunRefs, and
 * synchronizes Core's status mirror (task status, flow run status, human
 * gate requests) from `inspect --json`-shaped status mirrors.
 *
 * Status mapping (flow -> core FlowRunRef -> Task):
 *
 *   flow "running"                       -> run "running"        -> task "running"
 *   flow "blocked" with pending gates    -> run "awaiting_human" -> task "awaiting_human"
 *   flow "blocked" without pending gates -> run "running"        -> task "blocked"
 *   flow "completed"                     -> run "completed"      -> task "completed"
 *   flow "failed"                        -> run "failed"         -> task "failed"
 *   flow "cancelled"                     -> run "cancelled"      -> task "cancelled"
 */

import type { Repos } from "../db/repos.js";
import { invalidState, notFound } from "../errors.js";
import type {
  ActorRef,
  FlowExecutionProfile,
  FlowRunRef,
  FlowRunStatus,
  Project,
  StartTaskOptions,
  TaskStatus,
} from "../types/index.js";
import type { FlowInvoker, FlowRunStatusMirror } from "../adapters/flow/types.js";
import type { PermissionService } from "./permissionService.js";
import type { TaskService } from "./taskService.js";
import { nowIso } from "../ids.js";

const SYSTEM_ACTOR: ActorRef = { type: "system", id: "zigma-core" };

export class ExecutionService {
  constructor(
    private repos: Repos,
    private tasks: TaskService,
    private permissions: PermissionService,
    private invoker: FlowInvoker,
    private defaults: { executionProfile: FlowExecutionProfile }
  ) {}

  private resolveProfile(project: Project, options: StartTaskOptions): FlowExecutionProfile {
    const profileId = options.executionProfileId ?? project.executionProfileId;
    if (profileId) {
      const profile = this.repos.profiles.get(profileId);
      if (!profile) throw notFound("ExecutionProfile", profileId);
      return profile;
    }
    return this.defaults.executionProfile;
  }

  private resolveCwd(project: Project, profile: FlowExecutionProfile, workspacePath?: string): string {
    if (profile.workingDirectoryPolicy === "workspace-root") {
      if (!workspacePath) {
        throw invalidState("workingDirectoryPolicy=workspace-root requires a workspace");
      }
      return workspacePath;
    }
    if (!project.projectRoot) {
      throw invalidState(
        `Project ${project.id} has no projectRoot; set it or use workspace-root policy`
      );
    }
    return project.projectRoot;
  }

  async startTask(taskId: string, options: StartTaskOptions = {}): Promise<FlowRunRef> {
    const task = this.tasks.get(taskId);
    if (!["created", "queued", "failed", "blocked"].includes(task.status)) {
      throw invalidState(`Task ${taskId} cannot be started from status ${task.status}`);
    }
    const project = this.repos.projects.get(task.projectId);
    if (!project) throw notFound("Project", task.projectId);

    const workflowId = options.workflowId ?? project.defaultFlowWorkflowId;
    if (!workflowId) {
      throw invalidState(`No workflow specified and project ${project.id} has no default workflow`);
    }
    const profile = this.resolveProfile(project, options);

    // Workspace association (Core-first mode of FR-005). The workspace itself
    // is created via WorkspaceClient by the caller; here we only resolve refs.
    let workspacePath: string | undefined;
    if (options.workspaceId) {
      const ws = this.repos.workspaces
        .listByTask(taskId)
        .find((w) => w.id === options.workspaceId || w.zigmaWorkspaceId === options.workspaceId);
      if (!ws) throw notFound("WorkspaceRef", options.workspaceId);
      workspacePath = ws.path;
    }
    const cwd = this.resolveCwd(project, profile, workspacePath);

    // Immutable permission snapshot for this run (FR-011).
    const actor = options.actor ?? task.createdBy;
    const repositoryIds = this.repos.repositories.listByProject(project.id).map((r) => r.id);
    const snapshot = this.permissions.createSnapshot({
      taskId,
      actor,
      source: task.source,
      projectId: project.id,
      repositoryIds,
      grants: {
        allowedTools: profile.allowedTools,
        allowedWorkflows: [workflowId],
        ...options.grants,
      },
    });

    this.tasks.transition(taskId, "queued", { actor });

    const runRef = this.repos.flowRuns.insert({
      taskId,
      projectId: project.id,
      workspaceId: options.workspaceId,
      workflowId,
      executionProfileId: profile.id,
      permissionSnapshotId: snapshot.id,
      status: "queued",
      invocationCwd: cwd,
    });
    this.repos.snapshots.bindFlowRun(snapshot.id, runRef.id);

    // Inputs passed into the flow: caller inputs + workspace context (FR-005).
    const inputs: Record<string, string> = { ...(options.inputs ?? {}) };
    if (options.workspaceId && workspacePath) {
      inputs["workspace_id"] = options.workspaceId;
      inputs["workspace_path"] = workspacePath;
    }

    const callerContext = this.permissions.toFlowCallerContext(snapshot);

    let handle;
    try {
      handle = await this.invoker.invoke({
        cwd,
        workflow: workflowId,
        taskText: `${task.title}\n\n${task.description}`.trim(),
        inputs,
        callerContext,
        wait: options.wait,
        timeoutSeconds: profile.timeoutSeconds,
      });
    } catch (err) {
      this.repos.flowRuns.update(runRef.id, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: nowIso(),
      });
      this.tasks.transition(taskId, "running", { actor: SYSTEM_ACTOR });
      this.tasks.transition(taskId, "failed", {
        actor: SYSTEM_ACTOR,
        reason: "flow invocation failed",
      });
      throw err;
    }

    const started = this.repos.flowRuns.update(runRef.id, {
      zigmaFlowRunId: handle.zigmaFlowRunId,
      pid: handle.pid,
      status: "running",
      startedAt: nowIso(),
    })!;

    this.tasks.transition(taskId, "running", {
      actor,
      currentFlowRunId: started.id,
    });

    this.repos.audit.append({
      type: "flow_run.started",
      actor,
      projectId: project.id,
      taskId,
      flowRunId: started.id,
      detail: {
        workflowId,
        zigmaFlowRunId: handle.zigmaFlowRunId,
        executionProfileId: profile.id,
        permissionSnapshotId: snapshot.id,
        cwd,
      },
    });

    // If we already know the flow run id, sync once immediately.
    if (started.zigmaFlowRunId) {
      try {
        return await this.syncRun(started.id);
      } catch {
        return started;
      }
    }
    return started;
  }

  /**
   * Pull the latest status mirror from zigma-flow and update the
   * FlowRunRef, Task status, and human gate mirror (FR-007, FR-008 step 1-2).
   */
  async syncRun(flowRunRefId: string): Promise<FlowRunRef> {
    const run = this.repos.flowRuns.get(flowRunRefId);
    if (!run) throw notFound("FlowRunRef", flowRunRefId);
    if (!run.zigmaFlowRunId) {
      // Try late run-id discovery for detached invokes.
      const ids = await this.invoker.listRunIds(run.invocationCwd);
      if (ids.length === 0) return run;
      const latest = ids.sort().at(-1)!;
      this.repos.flowRuns.update(run.id, { zigmaFlowRunId: latest });
      run.zigmaFlowRunId = latest;
    }

    const mirror = await this.invoker.getStatus(run.invocationCwd, run.zigmaFlowRunId!);
    return this.applyMirror(run.id, mirror);
  }

  applyMirror(flowRunRefId: string, mirror: FlowRunStatusMirror): FlowRunRef {
    const run = this.repos.flowRuns.get(flowRunRefId);
    if (!run) throw notFound("FlowRunRef", flowRunRefId);
    const task = this.repos.tasks.get(run.taskId);
    if (!task) throw notFound("Task", run.taskId);

    const hasGates = mirror.pendingHumanGates.length > 0;
    let runStatus: FlowRunStatus;
    let taskStatus: TaskStatus;
    switch (mirror.status) {
      case "completed":
        runStatus = "completed";
        taskStatus = "completed";
        break;
      case "failed":
        runStatus = "failed";
        taskStatus = "failed";
        break;
      case "cancelled":
        runStatus = "cancelled";
        taskStatus = "cancelled";
        break;
      case "blocked":
        runStatus = hasGates ? "awaiting_human" : "running";
        taskStatus = hasGates ? "awaiting_human" : "blocked";
        break;
      default:
        runStatus = "running";
        taskStatus = "running";
    }

    const terminal = ["completed", "failed", "cancelled"].includes(runStatus);
    const updated = this.repos.flowRuns.update(run.id, {
      status: runStatus,
      lastSyncAt: nowIso(),
      completedAt: terminal ? run.completedAt ?? nowIso() : run.completedAt,
    })!;

    // Mirror pending gates into HumanGateRequest rows (idempotent).
    for (const gate of mirror.pendingHumanGates) {
      const existing = this.repos.gates.findByStep(run.id, gate.jobId, gate.stepId);
      if (!existing) {
        const created = this.repos.gates.upsertAwaiting({
          taskId: run.taskId,
          flowRunId: run.id,
          zigmaFlowRunId: mirror.runId,
          jobId: gate.jobId,
          stepId: gate.stepId,
          prompt: gate.prompt ?? "",
          instructions: gate.instructions,
          allowedApprovers: (gate.approvers ?? []).map((a) => ({
            type: "user" as const,
            id: a,
          })),
          enteredAt: gate.enteredAt,
        });
        this.repos.audit.append({
          type: "human_gate.opened",
          projectId: run.projectId,
          taskId: run.taskId,
          flowRunId: run.id,
          detail: { gateId: created.id, jobId: gate.jobId, stepId: gate.stepId },
        });
      }
    }

    // Expire stale awaiting gates that are no longer pending in the flow.
    if (!hasGates) {
      for (const g of this.repos.gates.list({ taskId: run.taskId, status: "awaiting" })) {
        if (g.flowRunId === run.id) {
          // Do not overwrite decisions made through Core; only auto-expire on terminal runs.
          if (terminal) this.repos.gates.resolve(g.id, "expired");
        }
      }
    }

    // Advance the task state mirror.
    if (task.status !== taskStatus) {
      try {
        this.repos.tasks.updateStatus(run.taskId, taskStatus);
        this.repos.audit.append({
          type: "task.status_changed",
          taskId: run.taskId,
          projectId: run.projectId,
          flowRunId: run.id,
          detail: { from: task.status, to: taskStatus, via: "flow_run.synced" },
        });
      } catch {
        // Mirror sync must not crash on unexpected transitions.
      }
    }

    this.repos.audit.append({
      type: "flow_run.synced",
      taskId: run.taskId,
      projectId: run.projectId,
      flowRunId: run.id,
      detail: { flowStatus: mirror.status, runStatus, pendingGates: mirror.pendingHumanGates.length },
    });

    return updated;
  }

  async cancelTask(taskId: string, reason: string, actor: ActorRef = SYSTEM_ACTOR): Promise<void> {
    const task = this.tasks.get(taskId);
    const runs = this.repos.flowRuns.listByTask(taskId);
    for (const run of runs) {
      if (["queued", "running", "awaiting_human"].includes(run.status) && run.zigmaFlowRunId) {
        try {
          await this.invoker.cancel(run.invocationCwd, run.zigmaFlowRunId, reason);
        } catch {
          // best-effort: record failure but continue cancelling Core state
        }
        this.repos.flowRuns.update(run.id, {
          status: "cancelled",
          completedAt: nowIso(),
          errorMessage: `cancelled: ${reason}`,
        });
      }
    }
    if (!["completed", "failed", "cancelled"].includes(task.status)) {
      this.tasks.transition(taskId, "cancelled", { actor, reason });
    }
    this.repos.audit.append({
      type: "task.cancelled",
      actor,
      taskId,
      projectId: task.projectId,
      detail: { reason },
    });
  }
}
