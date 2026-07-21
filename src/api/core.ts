/**
 * ZigmaCore — the composition root and FR-013 API facade.
 *
 * interface ZigmaCoreApi {
 *   createProject / createTask / startTask / getTask / getTaskStatus /
 *   approveGate / rejectGate / cancelTask / collectEvidence
 * }
 * plus platform helpers: repositories, execution profiles, workspaces,
 * external links, sync, audit.
 */

import { openDatabase, type CoreDb } from "../db/database.js";
import { createRepos, type Repos } from "../db/repos.js";
import { notFound } from "../errors.js";
import { nowIso } from "../ids.js";
import type { FlowInvoker } from "../adapters/flow/types.js";
import { LocalCliFlowInvoker } from "../adapters/flow/localCli.js";
import {
  LocalCliWorkspaceClient,
  type CreateWorkspaceRequest,
  type WorkspaceClient,
} from "../adapters/workspace/index.js";
import { PermissionService } from "../services/permissionService.js";
import { TaskService } from "../services/taskService.js";
import { ExecutionService } from "../services/executionService.js";
import { GateService } from "../services/gateService.js";
import { EvidenceService } from "../services/evidenceService.js";
import {
  CreateProjectInputSchema,
  type ActorRef,
  type AuditEvent,
  type CreateProjectInput,
  type CreateTaskInput,
  type EvidenceBundle,
  type ExternalLink,
  type FlowExecutionProfile,
  type FlowRunRef,
  type HumanGateDecisionInput,
  type HumanGateRequest,
  type Project,
  type Repository,
  type StartTaskOptions,
  type TaskStatusView,
  type WorkspaceRef,
  type ZigmaTask,
} from "../types/index.js";

export interface ZigmaCoreOptions {
  /** SQLite path or ":memory:". Default: .zigma-core/core.db under cwd. */
  dbPath?: string;
  flowInvoker?: FlowInvoker;
  workspaceClient?: WorkspaceClient;
  zigmaFlowCommand?: string;
  autoResumeAfterApprove?: boolean;
}

export class ZigmaCore {
  readonly db: CoreDb;
  readonly repos: Repos;
  readonly tasks: TaskService;
  readonly permissions: PermissionService;
  readonly execution: ExecutionService;
  readonly gates: GateService;
  readonly evidence: EvidenceService;
  readonly workspaceClient?: WorkspaceClient;

  private readonly defaultProfile: FlowExecutionProfile;

  constructor(options: ZigmaCoreOptions = {}) {
    this.db = openDatabase(options.dbPath ?? ".zigma-core/core.db");
    this.repos = createRepos(this.db);

    const invoker =
      options.flowInvoker ??
      new LocalCliFlowInvoker({ command: options.zigmaFlowCommand ?? "zigma-flow" });
    this.workspaceClient = options.workspaceClient ?? new LocalCliWorkspaceClient();

    // Ensure a built-in default execution profile exists.
    const existing = this.repos.profiles.list().find((p) => p.name === "default-local-cli");
    this.defaultProfile =
      existing ??
      this.repos.profiles.insert({
        name: "default-local-cli",
        mode: "local-cli",
        zigmaFlowCommand: options.zigmaFlowCommand ?? "zigma-flow",
        workingDirectoryPolicy: "project-root",
        allowedTools: ["git", "gh", "pnpm", "npm", "zigma-workspace"],
        timeoutSeconds: undefined,
      });

    this.permissions = new PermissionService(this.repos);
    this.tasks = new TaskService(this.repos);
    this.execution = new ExecutionService(this.repos, this.tasks, this.permissions, invoker, {
      executionProfile: this.defaultProfile,
    });
    this.gates = new GateService(this.repos, this.permissions, invoker, {
      autoResumeAfterApprove: options.autoResumeAfterApprove,
    });
    this.evidence = new EvidenceService(this.repos, invoker, this.workspaceClient);
  }

  // ── FR-001 projects ──────────────────────────────────────────────────

  createProject(input: CreateProjectInput): Project {
    const parsed = CreateProjectInputSchema.parse(input);
    const project = this.repos.projects.insert({ ...parsed });
    this.repos.audit.append({
      type: "project.created",
      projectId: project.id,
      detail: { name: project.name },
    });
    return project;
  }

  getProject(id: string): Project {
    const p = this.repos.projects.get(id);
    if (!p) throw notFound("Project", id);
    return p;
  }

  listProjects(): Project[] {
    return this.repos.projects.list();
  }

  updateProject(id: string, patch: Partial<Project>): Project {
    const updated = this.repos.projects.update(id, patch);
    if (!updated) throw notFound("Project", id);
    this.repos.audit.append({
      type: "project.updated",
      projectId: id,
      detail: { patch: Object.keys(patch) },
    });
    return updated;
  }

  archiveProject(id: string): Project {
    const updated = this.updateProject(id, { status: "archived" });
    this.repos.audit.append({ type: "project.archived", projectId: id, detail: {} });
    return updated;
  }

  registerRepository(input: {
    projectId: string;
    name: string;
    url: string;
    defaultBranch?: string;
    makeDefault?: boolean;
  }): Repository {
    this.getProject(input.projectId);
    const repo = this.repos.repositories.insert(input);
    if (input.makeDefault) {
      this.repos.projects.update(input.projectId, { defaultRepositoryId: repo.id });
    }
    this.repos.audit.append({
      type: "repository.registered",
      projectId: input.projectId,
      detail: { repositoryId: repo.id, url: repo.url },
    });
    return repo;
  }

  createExecutionProfile(
    input: Omit<FlowExecutionProfile, "id" | "createdAt">
  ): FlowExecutionProfile {
    const profile = this.repos.profiles.insert(input);
    this.repos.audit.append({
      type: "execution_profile.created",
      detail: { profileId: profile.id, name: profile.name, mode: profile.mode },
    });
    return profile;
  }

  // ── FR-002/003 tasks ─────────────────────────────────────────────────

  createTask(input: CreateTaskInput): ZigmaTask {
    return this.tasks.create(input);
  }

  getTask(taskId: string): ZigmaTask {
    return this.tasks.get(taskId);
  }

  listTasks(filter?: Parameters<Repos["tasks"]["list"]>[0]): ZigmaTask[] {
    return this.repos.tasks.list(filter);
  }

  getTaskStatus(taskId: string): TaskStatusView {
    const task = this.tasks.get(taskId);
    return {
      task,
      flowRuns: this.repos.flowRuns.listByTask(taskId),
      pendingGates: this.repos.gates.list({ taskId, status: "awaiting" }),
      workspaces: this.repos.workspaces.listByTask(taskId),
      externalLinks: this.repos.links.listByTask(taskId),
      permissionSnapshots: this.repos.snapshots.listByTask(taskId),
      latestEvidenceBundleId: this.repos.evidence.latestForTask(taskId)?.id,
    };
  }

  // ── FR-004/005 execution ─────────────────────────────────────────────

  startTask(taskId: string, options?: StartTaskOptions): Promise<FlowRunRef> {
    return this.execution.startTask(taskId, options);
  }

  syncRun(flowRunRefId: string): Promise<FlowRunRef> {
    return this.execution.syncRun(flowRunRefId);
  }

  async syncTask(taskId: string): Promise<FlowRunRef[]> {
    const runs = this.repos.flowRuns
      .listByTask(taskId)
      .filter((r) => ["queued", "running", "awaiting_human"].includes(r.status));
    const out: FlowRunRef[] = [];
    for (const run of runs) out.push(await this.execution.syncRun(run.id));
    return out;
  }

  cancelTask(taskId: string, reason: string, actor?: ActorRef): Promise<void> {
    return this.execution.cancelTask(taskId, reason, actor);
  }

  /** Core-first workspace creation (FR-005 mode 1). */
  async createWorkspaceForTask(
    taskId: string,
    req: Omit<CreateWorkspaceRequest, "taskId">
  ): Promise<WorkspaceRef> {
    const task = this.tasks.get(taskId);
    if (!this.workspaceClient) throw notFound("WorkspaceClient", "not configured");
    const info = await this.workspaceClient.create({ ...req, taskId });
    const ref = this.repos.workspaces.insert({
      taskId,
      projectId: task.projectId,
      zigmaWorkspaceId: info.workspaceId,
      path: info.path,
      repositoryUrl: req.repositoryUrl,
      baseRef: info.baseRef ?? req.baseRef,
      baseCommit: info.baseCommit,
      branch: info.branch ?? req.branch,
      mode: (info.mode as "writable" | "read-only") ?? req.mode ?? "writable",
    });
    this.repos.audit.append({
      type: "workspace.linked",
      taskId,
      projectId: task.projectId,
      detail: { workspaceRefId: ref.id, zigmaWorkspaceId: info.workspaceId, path: info.path },
    });
    return ref;
  }

  // ── FR-008 gates ─────────────────────────────────────────────────────

  approveGate(input: HumanGateDecisionInput): Promise<HumanGateRequest> {
    return this.gates.approve(input);
  }

  rejectGate(input: HumanGateDecisionInput): Promise<HumanGateRequest> {
    return this.gates.reject(input);
  }

  listGates(filter?: { status?: HumanGateRequest["status"]; taskId?: string }): HumanGateRequest[] {
    return this.gates.list(filter);
  }

  // ── FR-009/010 evidence & links ──────────────────────────────────────

  collectEvidence(taskId: string, flowRunRefId?: string): Promise<EvidenceBundle> {
    return this.evidence.collect(taskId, flowRunRefId);
  }

  getEvidence(id: string): EvidenceBundle {
    const bundle = this.repos.evidence.get(id);
    if (!bundle) throw notFound("EvidenceBundle", id);
    return bundle;
  }

  addExternalLink(input: Omit<ExternalLink, "id" | "createdAt">): ExternalLink {
    this.tasks.get(input.taskId);
    const link = this.repos.links.insert(input);
    this.repos.audit.append({
      type: "external_link.added",
      taskId: input.taskId,
      flowRunId: input.flowRunId,
      detail: { kind: link.kind, url: link.url },
    });
    return link;
  }

  // ── FR-012 audit ─────────────────────────────────────────────────────

  listAudit(filter?: { taskId?: string; limit?: number }): AuditEvent[] {
    return this.repos.audit.list(filter);
  }

  close(): void {
    this.db.close();
  }
}
