/**
 * Repository layer: row <-> domain model mapping for all Core entities.
 * Kept in one module for the MVP; split by aggregate when it grows.
 */

import type { CoreDb } from "./database.js";
import { newId, nowIso } from "../ids.js";
import type {
  ActorRef,
  AuditEvent,
  EvidenceBundle,
  ExternalLink,
  FlowExecutionProfile,
  FlowRunRef,
  FlowRunStatus,
  HumanDecision,
  HumanGateRequest,
  PermissionSnapshot,
  Project,
  Repository,
  TaskStatus,
  WorkspaceRef,
  ZigmaTask,
} from "../types/index.js";

const J = {
  parse<T>(text: string | null | undefined, fallback: T): T {
    if (text == null || text === "") return fallback;
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  },
  str(value: unknown): string {
    return JSON.stringify(value ?? null);
  },
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

function rowToProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    status: r.status,
    defaultRepositoryId: r.default_repository_id ?? undefined,
    defaultFlowWorkflowId: r.default_flow_workflow_id ?? undefined,
    projectRoot: r.project_root ?? undefined,
    workspacePolicyId: r.workspace_policy_id ?? undefined,
    skillProfileId: r.skill_profile_id ?? undefined,
    codePlatformProfileId: r.code_platform_profile_id ?? undefined,
    executionProfileId: r.execution_profile_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProjectRepo {
  constructor(private db: CoreDb) {}

  insert(p: Omit<Project, "id" | "createdAt" | "updatedAt" | "status"> & { status?: Project["status"] }): Project {
    const now = nowIso();
    const project: Project = {
      ...p,
      id: newId("project"),
      status: p.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, status, default_repository_id,
          default_flow_workflow_id, project_root, workspace_policy_id, skill_profile_id,
          code_platform_profile_id, execution_profile_id, created_at, updated_at)
         VALUES (@id, @name, @description, @status, @defaultRepositoryId,
          @defaultFlowWorkflowId, @projectRoot, @workspacePolicyId, @skillProfileId,
          @codePlatformProfileId, @executionProfileId, @createdAt, @updatedAt)`
      )
      .run({
        ...project,
        description: project.description ?? null,
        defaultRepositoryId: project.defaultRepositoryId ?? null,
        defaultFlowWorkflowId: project.defaultFlowWorkflowId ?? null,
        projectRoot: project.projectRoot ?? null,
        workspacePolicyId: project.workspacePolicyId ?? null,
        skillProfileId: project.skillProfileId ?? null,
        codePlatformProfileId: project.codePlatformProfileId ?? null,
        executionProfileId: project.executionProfileId ?? null,
      });
    return project;
  }

  get(id: string): Project | undefined {
    const r = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
    return r ? rowToProject(r) : undefined;
  }

  list(): Project[] {
    return (this.db.prepare(`SELECT * FROM projects ORDER BY created_at`).all() as any[]).map(rowToProject);
  }

  update(id: string, patch: Partial<Project>): Project | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: Project = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE projects SET name=@name, description=@description, status=@status,
          default_repository_id=@defaultRepositoryId, default_flow_workflow_id=@defaultFlowWorkflowId,
          project_root=@projectRoot, workspace_policy_id=@workspacePolicyId,
          skill_profile_id=@skillProfileId, code_platform_profile_id=@codePlatformProfileId,
          execution_profile_id=@executionProfileId, updated_at=@updatedAt
         WHERE id=@id`
      )
      .run({
        ...next,
        description: next.description ?? null,
        defaultRepositoryId: next.defaultRepositoryId ?? null,
        defaultFlowWorkflowId: next.defaultFlowWorkflowId ?? null,
        projectRoot: next.projectRoot ?? null,
        workspacePolicyId: next.workspacePolicyId ?? null,
        skillProfileId: next.skillProfileId ?? null,
        codePlatformProfileId: next.codePlatformProfileId ?? null,
        executionProfileId: next.executionProfileId ?? null,
      });
    return next;
  }
}

// ---------------------------------------------------------------------------
// Repositories (git repos)
// ---------------------------------------------------------------------------

export class RepositoryRepo {
  constructor(private db: CoreDb) {}

  insert(input: { projectId: string; name: string; url: string; defaultBranch?: string }): Repository {
    const repo: Repository = {
      id: newId("repository"),
      projectId: input.projectId,
      name: input.name,
      url: input.url,
      defaultBranch: input.defaultBranch ?? "main",
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO repositories (id, project_id, name, url, default_branch, created_at)
         VALUES (@id, @projectId, @name, @url, @defaultBranch, @createdAt)`
      )
      .run(repo);
    return repo;
  }

  listByProject(projectId: string): Repository[] {
    return (
      this.db.prepare(`SELECT * FROM repositories WHERE project_id = ?`).all(projectId) as any[]
    ).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      url: r.url,
      defaultBranch: r.default_branch,
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Execution profiles
// ---------------------------------------------------------------------------

function rowToProfile(r: any): FlowExecutionProfile {
  return {
    id: r.id,
    name: r.name,
    mode: r.mode,
    zigmaFlowCommand: r.zigma_flow_command,
    workingDirectoryPolicy: r.working_directory_policy,
    allowedTools: J.parse<string[]>(r.allowed_tools, []),
    timeoutSeconds: r.timeout_seconds ?? undefined,
    createdAt: r.created_at,
  };
}

export class ExecutionProfileRepo {
  constructor(private db: CoreDb) {}

  insert(input: Omit<FlowExecutionProfile, "id" | "createdAt">): FlowExecutionProfile {
    const profile: FlowExecutionProfile = { ...input, id: newId("profile"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO execution_profiles (id, name, mode, zigma_flow_command,
          working_directory_policy, allowed_tools, timeout_seconds, created_at)
         VALUES (@id, @name, @mode, @zigmaFlowCommand, @workingDirectoryPolicy,
          @allowedTools, @timeoutSeconds, @createdAt)`
      )
      .run({
        ...profile,
        allowedTools: J.str(profile.allowedTools),
        timeoutSeconds: profile.timeoutSeconds ?? null,
      });
    return profile;
  }

  get(id: string): FlowExecutionProfile | undefined {
    const r = this.db.prepare(`SELECT * FROM execution_profiles WHERE id = ?`).get(id);
    return r ? rowToProfile(r) : undefined;
  }

  list(): FlowExecutionProfile[] {
    return (this.db.prepare(`SELECT * FROM execution_profiles`).all() as any[]).map(rowToProfile);
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

function rowToTask(r: any): ZigmaTask {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    source: J.parse(r.source, { channel: "api" as const }),
    status: r.status as TaskStatus,
    priority: r.priority,
    createdBy: J.parse<ActorRef>(r.created_by, { type: "system", id: "unknown" }),
    currentFlowRunId: r.current_flow_run_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class TaskRepo {
  constructor(private db: CoreDb) {}

  insert(t: Omit<ZigmaTask, "id" | "createdAt" | "updatedAt">): ZigmaTask {
    const now = nowIso();
    const task: ZigmaTask = { ...t, id: newId("task"), createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, description, source, status, priority,
          created_by, current_flow_run_id, created_at, updated_at)
         VALUES (@id, @projectId, @title, @description, @source, @status, @priority,
          @createdBy, @currentFlowRunId, @createdAt, @updatedAt)`
      )
      .run({
        ...task,
        source: J.str(task.source),
        createdBy: J.str(task.createdBy),
        currentFlowRunId: task.currentFlowRunId ?? null,
      });
    return task;
  }

  get(id: string): ZigmaTask | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return r ? rowToTask(r) : undefined;
  }

  list(filter?: { projectId?: string; status?: TaskStatus }): ZigmaTask[] {
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params: any[] = [];
    if (filter?.projectId) {
      sql += ` AND project_id = ?`;
      params.push(filter.projectId);
    }
    if (filter?.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }
    sql += ` ORDER BY created_at`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToTask);
  }

  updateStatus(id: string, status: TaskStatus, currentFlowRunId?: string | null): void {
    if (currentFlowRunId === undefined) {
      this.db
        .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
        .run(status, nowIso(), id);
    } else {
      this.db
        .prepare(`UPDATE tasks SET status = ?, current_flow_run_id = ?, updated_at = ? WHERE id = ?`)
        .run(status, currentFlowRunId, nowIso(), id);
    }
  }
}

// ---------------------------------------------------------------------------
// Permission snapshots
// ---------------------------------------------------------------------------

export class PermissionSnapshotRepo {
  constructor(private db: CoreDb) {}

  insert(s: Omit<PermissionSnapshot, "id" | "createdAt">): PermissionSnapshot {
    const snap: PermissionSnapshot = { ...s, id: newId("snapshot"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO permission_snapshots (id, task_id, flow_run_id, revision, actor, source,
          project_scope, grants, expires_at, created_at)
         VALUES (@id, @taskId, @flowRunId, @revision, @actor, @source, @projectScope,
          @grants, @expiresAt, @createdAt)`
      )
      .run({
        ...snap,
        flowRunId: snap.flowRunId ?? null,
        actor: J.str(snap.actor),
        source: J.str(snap.source),
        projectScope: J.str(snap.projectScope),
        grants: J.str(snap.grants),
        expiresAt: snap.expiresAt ?? null,
      });
    return snap;
  }

  get(id: string): PermissionSnapshot | undefined {
    const r = this.db.prepare(`SELECT * FROM permission_snapshots WHERE id = ?`).get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      taskId: r.task_id,
      flowRunId: r.flow_run_id ?? undefined,
      revision: r.revision,
      actor: J.parse(r.actor, { type: "system" as const, id: "unknown" }),
      source: J.parse(r.source, { channel: "api" as const }),
      projectScope: J.parse(r.project_scope, { projectId: "", repositoryIds: [] }),
      grants: J.parse(r.grants, {} as any),
      expiresAt: r.expires_at ?? undefined,
      createdAt: r.created_at,
    };
  }

  listByTask(taskId: string): PermissionSnapshot[] {
    const rows = this.db
      .prepare(`SELECT id FROM permission_snapshots WHERE task_id = ? ORDER BY revision ASC`)
      .all(taskId) as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!).filter(Boolean);
  }

  latestRevision(taskId: string): number {
    const r = this.db
      .prepare(`SELECT MAX(revision) as rev FROM permission_snapshots WHERE task_id = ?`)
      .get(taskId) as any;
    return r?.rev ?? 0;
  }

  bindFlowRun(id: string, flowRunId: string): void {
    this.db
      .prepare(`UPDATE permission_snapshots SET flow_run_id = ? WHERE id = ? AND flow_run_id IS NULL`)
      .run(flowRunId, id);
  }
}

// ---------------------------------------------------------------------------
// Flow run refs
// ---------------------------------------------------------------------------

function rowToFlowRun(r: any): FlowRunRef {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    workspaceId: r.workspace_id ?? undefined,
    workflowId: r.workflow_id,
    zigmaFlowRunId: r.zigma_flow_run_id ?? undefined,
    executionProfileId: r.execution_profile_id,
    permissionSnapshotId: r.permission_snapshot_id,
    status: r.status as FlowRunStatus,
    invocationCwd: r.invocation_cwd,
    pid: r.pid ?? undefined,
    evidenceBundleId: r.evidence_bundle_id ?? undefined,
    lastSyncAt: r.last_sync_at ?? undefined,
    startedAt: r.started_at ?? undefined,
    completedAt: r.completed_at ?? undefined,
    errorMessage: r.error_message ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class FlowRunRepo {
  constructor(private db: CoreDb) {}

  insert(f: Omit<FlowRunRef, "id" | "createdAt" | "updatedAt">): FlowRunRef {
    const now = nowIso();
    const run: FlowRunRef = { ...f, id: newId("flowRun"), createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO flow_run_refs (id, task_id, project_id, workspace_id, workflow_id,
          zigma_flow_run_id, execution_profile_id, permission_snapshot_id, status,
          invocation_cwd, pid, evidence_bundle_id, last_sync_at, started_at, completed_at,
          error_message, created_at, updated_at)
         VALUES (@id, @taskId, @projectId, @workspaceId, @workflowId, @zigmaFlowRunId,
          @executionProfileId, @permissionSnapshotId, @status, @invocationCwd, @pid,
          @evidenceBundleId, @lastSyncAt, @startedAt, @completedAt, @errorMessage,
          @createdAt, @updatedAt)`
      )
      .run({
        ...run,
        workspaceId: run.workspaceId ?? null,
        zigmaFlowRunId: run.zigmaFlowRunId ?? null,
        pid: run.pid ?? null,
        evidenceBundleId: run.evidenceBundleId ?? null,
        lastSyncAt: run.lastSyncAt ?? null,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        errorMessage: run.errorMessage ?? null,
      });
    return run;
  }

  get(id: string): FlowRunRef | undefined {
    const r = this.db.prepare(`SELECT * FROM flow_run_refs WHERE id = ?`).get(id);
    return r ? rowToFlowRun(r) : undefined;
  }

  listByTask(taskId: string): FlowRunRef[] {
    return (
      this.db.prepare(`SELECT * FROM flow_run_refs WHERE task_id = ? ORDER BY created_at`).all(taskId) as any[]
    ).map(rowToFlowRun);
  }

  listActive(): FlowRunRef[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM flow_run_refs WHERE status IN ('queued','running','awaiting_human')`
        )
        .all() as any[]
    ).map(rowToFlowRun);
  }

  update(id: string, patch: Partial<FlowRunRef>): FlowRunRef | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: FlowRunRef = { ...current, ...patch, id, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE flow_run_refs SET workspace_id=@workspaceId, zigma_flow_run_id=@zigmaFlowRunId,
          status=@status, pid=@pid, evidence_bundle_id=@evidenceBundleId, last_sync_at=@lastSyncAt,
          started_at=@startedAt, completed_at=@completedAt, error_message=@errorMessage,
          updated_at=@updatedAt
         WHERE id=@id`
      )
      .run({
        ...next,
        workspaceId: next.workspaceId ?? null,
        zigmaFlowRunId: next.zigmaFlowRunId ?? null,
        pid: next.pid ?? null,
        evidenceBundleId: next.evidenceBundleId ?? null,
        lastSyncAt: next.lastSyncAt ?? null,
        startedAt: next.startedAt ?? null,
        completedAt: next.completedAt ?? null,
        errorMessage: next.errorMessage ?? null,
      });
    return next;
  }
}

// ---------------------------------------------------------------------------
// Workspace refs
// ---------------------------------------------------------------------------

export class WorkspaceRefRepo {
  constructor(private db: CoreDb) {}

  insert(w: Omit<WorkspaceRef, "id" | "createdAt">): WorkspaceRef {
    const ref: WorkspaceRef = { ...w, id: newId("workspaceRef"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO workspace_refs (id, task_id, project_id, flow_run_id, zigma_workspace_id,
          path, repository_url, base_ref, base_commit, branch, mode, created_at)
         VALUES (@id, @taskId, @projectId, @flowRunId, @zigmaWorkspaceId, @path,
          @repositoryUrl, @baseRef, @baseCommit, @branch, @mode, @createdAt)`
      )
      .run({
        ...ref,
        taskId: ref.taskId ?? null,
        projectId: ref.projectId ?? null,
        flowRunId: ref.flowRunId ?? null,
        repositoryUrl: ref.repositoryUrl ?? null,
        baseRef: ref.baseRef ?? null,
        baseCommit: ref.baseCommit ?? null,
        branch: ref.branch ?? null,
      });
    return ref;
  }

  listByTask(taskId: string): WorkspaceRef[] {
    return (
      this.db.prepare(`SELECT * FROM workspace_refs WHERE task_id = ?`).all(taskId) as any[]
    ).map((r) => ({
      id: r.id,
      taskId: r.task_id ?? undefined,
      projectId: r.project_id ?? undefined,
      flowRunId: r.flow_run_id ?? undefined,
      zigmaWorkspaceId: r.zigma_workspace_id,
      path: r.path,
      repositoryUrl: r.repository_url ?? undefined,
      baseRef: r.base_ref ?? undefined,
      baseCommit: r.base_commit ?? undefined,
      branch: r.branch ?? undefined,
      mode: r.mode,
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Human gates & decisions
// ---------------------------------------------------------------------------

function rowToGate(r: any): HumanGateRequest {
  return {
    id: r.id,
    taskId: r.task_id,
    flowRunId: r.flow_run_id,
    zigmaFlowRunId: r.zigma_flow_run_id,
    jobId: r.job_id,
    stepId: r.step_id,
    prompt: r.prompt,
    instructions: r.instructions ?? undefined,
    allowedApprovers: J.parse<ActorRef[]>(r.allowed_approvers, []),
    status: r.status,
    enteredAt: r.entered_at ?? undefined,
    resolvedAt: r.resolved_at ?? undefined,
    createdAt: r.created_at,
  };
}

export class GateRepo {
  constructor(private db: CoreDb) {}

  /** Idempotent insert keyed on (flowRunId, jobId, stepId). */
  upsertAwaiting(g: Omit<HumanGateRequest, "id" | "createdAt" | "status" | "resolvedAt">): HumanGateRequest {
    const existing = this.findByStep(g.flowRunId, g.jobId, g.stepId);
    if (existing) return existing;
    const gate: HumanGateRequest = {
      ...g,
      id: newId("gate"),
      status: "awaiting",
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO human_gate_requests (id, task_id, flow_run_id, zigma_flow_run_id, job_id,
          step_id, prompt, instructions, allowed_approvers, status, entered_at, resolved_at, created_at)
         VALUES (@id, @taskId, @flowRunId, @zigmaFlowRunId, @jobId, @stepId, @prompt,
          @instructions, @allowedApprovers, @status, @enteredAt, NULL, @createdAt)`
      )
      .run({
        ...gate,
        instructions: gate.instructions ?? null,
        allowedApprovers: J.str(gate.allowedApprovers),
        enteredAt: gate.enteredAt ?? null,
      });
    return gate;
  }

  findByStep(flowRunId: string, jobId: string, stepId: string): HumanGateRequest | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM human_gate_requests WHERE flow_run_id = ? AND job_id = ? AND step_id = ?`
      )
      .get(flowRunId, jobId, stepId);
    return r ? rowToGate(r) : undefined;
  }

  get(id: string): HumanGateRequest | undefined {
    const r = this.db.prepare(`SELECT * FROM human_gate_requests WHERE id = ?`).get(id);
    return r ? rowToGate(r) : undefined;
  }

  list(filter?: { status?: HumanGateRequest["status"]; taskId?: string }): HumanGateRequest[] {
    let sql = `SELECT * FROM human_gate_requests WHERE 1=1`;
    const params: any[] = [];
    if (filter?.status) {
      sql += ` AND status = ?`;
      params.push(filter.status);
    }
    if (filter?.taskId) {
      sql += ` AND task_id = ?`;
      params.push(filter.taskId);
    }
    sql += ` ORDER BY created_at`;
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToGate);
  }

  resolve(id: string, status: "approved" | "rejected" | "expired"): void {
    this.db
      .prepare(`UPDATE human_gate_requests SET status = ?, resolved_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
  }
}

export class DecisionRepo {
  constructor(private db: CoreDb) {}

  insert(d: Omit<HumanDecision, "id" | "decidedAt">): HumanDecision {
    const decision: HumanDecision = { ...d, id: newId("decision"), decidedAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO human_decisions (id, gate_request_id, task_id, flow_run_id, decision,
          comment, actor, decided_at)
         VALUES (@id, @gateRequestId, @taskId, @flowRunId, @decision, @comment, @actor, @decidedAt)`
      )
      .run({ ...decision, comment: decision.comment ?? null, actor: J.str(decision.actor) });
    return decision;
  }

  listByTask(taskId: string): HumanDecision[] {
    return (
      this.db.prepare(`SELECT * FROM human_decisions WHERE task_id = ? ORDER BY decided_at`).all(taskId) as any[]
    ).map((r) => ({
      id: r.id,
      gateRequestId: r.gate_request_id,
      taskId: r.task_id,
      flowRunId: r.flow_run_id,
      decision: r.decision,
      comment: r.comment ?? undefined,
      actor: J.parse(r.actor, { type: "user" as const, id: "unknown" }),
      decidedAt: r.decided_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Evidence bundles & external links
// ---------------------------------------------------------------------------

export class EvidenceRepo {
  constructor(private db: CoreDb) {}

  insert(bundle: Omit<EvidenceBundle, "id" | "createdAt">): EvidenceBundle {
    const full: EvidenceBundle = { ...bundle, id: newId("evidence"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO evidence_bundles (id, task_id, flow_run_id, summary, payload, created_at)
         VALUES (@id, @taskId, @flowRunId, @summary, @payload, @createdAt)`
      )
      .run({
        id: full.id,
        taskId: full.taskId,
        flowRunId: full.flowRunId,
        summary: full.summary,
        payload: J.str(full),
        createdAt: full.createdAt,
      });
    return full;
  }

  get(id: string): EvidenceBundle | undefined {
    const r = this.db.prepare(`SELECT payload FROM evidence_bundles WHERE id = ?`).get(id) as any;
    return r ? (JSON.parse(r.payload) as EvidenceBundle) : undefined;
  }

  latestForTask(taskId: string): EvidenceBundle | undefined {
    const r = this.db
      .prepare(`SELECT payload FROM evidence_bundles WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(taskId) as any;
    return r ? (JSON.parse(r.payload) as EvidenceBundle) : undefined;
  }
}

export class LinkRepo {
  constructor(private db: CoreDb) {}

  insert(l: Omit<ExternalLink, "id" | "createdAt">): ExternalLink {
    const link: ExternalLink = { ...l, id: newId("link"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO external_links (id, task_id, flow_run_id, kind, url, title, created_by, created_at)
         VALUES (@id, @taskId, @flowRunId, @kind, @url, @title, @createdBy, @createdAt)`
      )
      .run({
        ...link,
        flowRunId: link.flowRunId ?? null,
        title: link.title ?? null,
        createdBy: link.createdBy ? J.str(link.createdBy) : null,
      });
    return link;
  }

  listByTask(taskId: string): ExternalLink[] {
    return (
      this.db.prepare(`SELECT * FROM external_links WHERE task_id = ? ORDER BY created_at`).all(taskId) as any[]
    ).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      flowRunId: r.flow_run_id ?? undefined,
      kind: r.kind,
      url: r.url,
      title: r.title ?? undefined,
      createdBy: r.created_by ? J.parse(r.created_by, undefined as any) : undefined,
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export class AuditRepo {
  constructor(private db: CoreDb) {}

  append(e: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const event: AuditEvent = { ...e, id: newId("audit"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, type, actor, project_id, task_id, flow_run_id, detail, created_at)
         VALUES (@id, @type, @actor, @projectId, @taskId, @flowRunId, @detail, @createdAt)`
      )
      .run({
        ...event,
        actor: event.actor ? J.str(event.actor) : null,
        projectId: event.projectId ?? null,
        taskId: event.taskId ?? null,
        flowRunId: event.flowRunId ?? null,
        detail: J.str(event.detail),
      });
    return event;
  }

  list(filter?: { taskId?: string; limit?: number }): AuditEvent[] {
    let sql = `SELECT * FROM audit_events WHERE 1=1`;
    const params: any[] = [];
    if (filter?.taskId) {
      sql += ` AND task_id = ?`;
      params.push(filter.taskId);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(filter?.limit ?? 100);
    return (this.db.prepare(sql).all(...params) as any[]).map((r) => ({
      id: r.id,
      type: r.type,
      actor: r.actor ? J.parse(r.actor, undefined as any) : undefined,
      projectId: r.project_id ?? undefined,
      taskId: r.task_id ?? undefined,
      flowRunId: r.flow_run_id ?? undefined,
      detail: J.parse(r.detail, {}),
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------
// Aggregate accessor
// ---------------------------------------------------------------------------

export interface Repos {
  projects: ProjectRepo;
  repositories: RepositoryRepo;
  profiles: ExecutionProfileRepo;
  tasks: TaskRepo;
  snapshots: PermissionSnapshotRepo;
  flowRuns: FlowRunRepo;
  workspaces: WorkspaceRefRepo;
  gates: GateRepo;
  decisions: DecisionRepo;
  evidence: EvidenceRepo;
  links: LinkRepo;
  audit: AuditRepo;
}

export function createRepos(db: CoreDb): Repos {
  return {
    projects: new ProjectRepo(db),
    repositories: new RepositoryRepo(db),
    profiles: new ExecutionProfileRepo(db),
    tasks: new TaskRepo(db),
    snapshots: new PermissionSnapshotRepo(db),
    flowRuns: new FlowRunRepo(db),
    workspaces: new WorkspaceRefRepo(db),
    gates: new GateRepo(db),
    decisions: new DecisionRepo(db),
    evidence: new EvidenceRepo(db),
    links: new LinkRepo(db),
    audit: new AuditRepo(db),
  };
}
