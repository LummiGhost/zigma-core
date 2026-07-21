/**
 * Zigma Core domain models.
 *
 * These types define the platform control-plane data model:
 *   Project / Repository / Task / FlowRunRef / WorkspaceRef /
 *   FlowExecutionProfile / PermissionSnapshot / CallerContext /
 *   HumanGateRequest / HumanDecision / EvidenceBundle / ExternalLink /
 *   AuditEvent
 *
 * Design rules (see docs/design.md):
 *   - Core never interprets zigma-flow internal state; it only stores
 *     references and status mirrors (FlowRunRef).
 *   - Permission snapshots are immutable per flow run (FR-011).
 *   - Every mutation is mirrored into the audit log (FR-012).
 *
 * All schemas are declared with zod so API/CLI inputs are validated at the
 * boundary, and the inferred TypeScript types are used everywhere else.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const IsoDate = z.string().min(1);

/** Actor performing an action. Mirrors zigma-flow host-api `Actor`. */
export const ActorRefSchema = z.object({
  type: z.enum(["user", "system", "service"]),
  id: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

/** Where a task originated. */
export const TaskSourceSchema = z.object({
  channel: z.enum(["api", "cli", "web", "mail", "code-platform", "schedule"]),
  /** Free-form reference, e.g. issue URL, mail message id, cron id. */
  reference: z.string().optional(),
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

// ---------------------------------------------------------------------------
// Project & Repository
// ---------------------------------------------------------------------------

export const RepositorySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  url: z.string(),
  defaultBranch: z.string().default("main"),
  createdAt: IsoDate,
});
export type Repository = z.infer<typeof RepositorySchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["active", "archived"]).default("active"),
  defaultRepositoryId: z.string().optional(),
  defaultFlowWorkflowId: z.string().optional(),
  /** Root directory of the project checkout used for local-cli invocation. */
  projectRoot: z.string().optional(),
  workspacePolicyId: z.string().optional(),
  skillProfileId: z.string().optional(),
  codePlatformProfileId: z.string().optional(),
  executionProfileId: z.string().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectInputSchema = ProjectSchema.pick({
  name: true,
  description: true,
  defaultFlowWorkflowId: true,
  projectRoot: true,
  workspacePolicyId: true,
  skillProfileId: true,
  codePlatformProfileId: true,
  executionProfileId: true,
}).partial({ description: true });
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

// ---------------------------------------------------------------------------
// Execution profile
// ---------------------------------------------------------------------------

export const FlowExecutionProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** MVP supports local-cli only; the others are reserved. */
  mode: z.enum(["local-cli", "local-service", "remote-host"]).default("local-cli"),
  /** Command used to invoke zigma-flow (default "zigma-flow"). */
  zigmaFlowCommand: z.string().default("zigma-flow"),
  workingDirectoryPolicy: z
    .enum(["project-root", "workspace-root", "control-directory"])
    .default("project-root"),
  /** CLI tools the run is allowed to call from script/check steps (FR-006). */
  allowedTools: z.array(z.string()).default([]),
  timeoutSeconds: z.number().int().positive().optional(),
  createdAt: IsoDate,
});
export type FlowExecutionProfile = z.infer<typeof FlowExecutionProfileSchema>;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  "created",
  "queued",
  "running",
  "awaiting_human",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Task state machine (FR-003). Key: from-status; value: allowed to-statuses.
 * Terminal states: completed, failed, cancelled.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ["queued", "cancelled"],
  queued: ["running", "failed", "cancelled", "blocked"],
  running: ["awaiting_human", "completed", "failed", "cancelled", "blocked"],
  awaiting_human: ["running", "completed", "failed", "cancelled", "blocked"],
  blocked: ["queued", "running", "failed", "cancelled"],
  completed: [],
  failed: ["queued"], // allow manual re-queue / retry
  cancelled: [],
};

export const ZigmaTaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  source: TaskSourceSchema,
  status: TaskStatusSchema,
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  createdBy: ActorRefSchema,
  currentFlowRunId: z.string().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type ZigmaTask = z.infer<typeof ZigmaTaskSchema>;

export const CreateTaskInputSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  source: TaskSourceSchema.default({ channel: "api" }),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  createdBy: ActorRefSchema,
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

// ---------------------------------------------------------------------------
// Permission snapshot & caller context
// ---------------------------------------------------------------------------

/**
 * Structured permission grants at the Core layer. This is the richer,
 * platform-facing shape; it is projected onto zigma-flow's flat
 * `permissions: string[]` when a run is started (see permissionService).
 */
export const PermissionGrantsSchema = z.object({
  canReadCode: z.boolean().default(true),
  canWriteCode: z.boolean().default(false),
  canCreateBranch: z.boolean().default(false),
  canCreatePullRequest: z.boolean().default(false),
  canApproveHumanGate: z.boolean().default(false),
  canMergePullRequest: z.boolean().default(false),
  allowedWorkflows: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).default([]),
});
export type PermissionGrants = z.infer<typeof PermissionGrantsSchema>;

/**
 * Immutable permission snapshot recorded per task/run (FR-011).
 * A new revision is required to change permissions mid-task.
 */
export const PermissionSnapshotSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  flowRunId: z.string().optional(),
  revision: z.number().int().min(1),
  actor: ActorRefSchema,
  source: TaskSourceSchema,
  projectScope: z.object({
    projectId: z.string(),
    repositoryIds: z.array(z.string()),
  }),
  grants: PermissionGrantsSchema,
  expiresAt: IsoDate.optional(),
  createdAt: IsoDate,
});
export type PermissionSnapshot = z.infer<typeof PermissionSnapshotSchema>;

/**
 * Caller context in the exact shape zigma-flow's Host API expects
 * (see zigma-flow src/host-api.ts `CallerContext`). Core builds this from
 * a PermissionSnapshot and hands it to the flow adapter.
 */
export interface FlowCallerContext {
  user: { id: string; name: string; email: string };
  actor: { type: "user" | "system" | "service"; id: string; name?: string };
  source: { system: string; version: string };
  permissions: string[];
  project: { id: string; scope: string };
}

// ---------------------------------------------------------------------------
// Flow run ref
// ---------------------------------------------------------------------------

export const FLOW_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_human",
  "completed",
  "failed",
  "cancelled",
] as const;
export const FlowRunStatusSchema = z.enum(FLOW_RUN_STATUSES);
export type FlowRunStatus = z.infer<typeof FlowRunStatusSchema>;

export const FlowRunRefSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  projectId: z.string(),
  workspaceId: z.string().optional(),
  workflowId: z.string(),
  /** Run id assigned by zigma-flow (e.g. "20260714-0001"); unknown until discovered. */
  zigmaFlowRunId: z.string().optional(),
  executionProfileId: z.string(),
  permissionSnapshotId: z.string(),
  status: FlowRunStatusSchema,
  /** Directory in which zigma-flow was invoked (where .zigma-flow/ lives). */
  invocationCwd: z.string(),
  /** OS pid of the detached invoke process, if spawned. */
  pid: z.number().int().optional(),
  evidenceBundleId: z.string().optional(),
  lastSyncAt: IsoDate.optional(),
  startedAt: IsoDate.optional(),
  completedAt: IsoDate.optional(),
  errorMessage: z.string().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type FlowRunRef = z.infer<typeof FlowRunRefSchema>;

// ---------------------------------------------------------------------------
// Workspace ref
// ---------------------------------------------------------------------------

export const WorkspaceRefSchema = z.object({
  id: z.string(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
  flowRunId: z.string().optional(),
  /** Workspace id assigned by zigma-workspace ("ws_..."). */
  zigmaWorkspaceId: z.string(),
  path: z.string(),
  repositoryUrl: z.string().optional(),
  baseRef: z.string().optional(),
  baseCommit: z.string().optional(),
  branch: z.string().optional(),
  mode: z.enum(["read-only", "writable"]).default("writable"),
  createdAt: IsoDate,
});
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

// ---------------------------------------------------------------------------
// Human gates
// ---------------------------------------------------------------------------

export const HumanGateRequestSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  flowRunId: z.string(),
  zigmaFlowRunId: z.string(),
  jobId: z.string(),
  stepId: z.string(),
  prompt: z.string().default(""),
  instructions: z.string().optional(),
  allowedApprovers: z.array(ActorRefSchema).default([]),
  status: z.enum(["awaiting", "approved", "rejected", "expired"]),
  enteredAt: IsoDate.optional(),
  resolvedAt: IsoDate.optional(),
  createdAt: IsoDate,
});
export type HumanGateRequest = z.infer<typeof HumanGateRequestSchema>;

export const HumanDecisionSchema = z.object({
  id: z.string(),
  gateRequestId: z.string(),
  taskId: z.string(),
  flowRunId: z.string(),
  decision: z.enum(["approve", "reject", "request_changes"]),
  comment: z.string().optional(),
  actor: ActorRefSchema,
  decidedAt: IsoDate,
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

export const HumanGateDecisionInputSchema = z.object({
  gateRequestId: z.string(),
  actor: ActorRefSchema,
  comment: z.string().optional(),
});
export type HumanGateDecisionInput = z.infer<typeof HumanGateDecisionInputSchema>;

// ---------------------------------------------------------------------------
// Evidence bundle
// ---------------------------------------------------------------------------

export const ArtifactRefSchema = z.object({
  jobId: z.string().optional(),
  stepId: z.string().optional(),
  name: z.string(),
  path: z.string().optional(),
  kind: z.string().optional(),
  createdAt: IsoDate.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ValidationEvidenceSchema = z.object({
  jobId: z.string().optional(),
  stepId: z.string().optional(),
  name: z.string().optional(),
  passed: z.boolean().optional(),
  detail: z.string().optional(),
});
export type ValidationEvidence = z.infer<typeof ValidationEvidenceSchema>;

export const CodeChangeSummarySchema = z.object({
  workspaceId: z.string().optional(),
  baseCommit: z.string().optional(),
  headCommit: z.string().optional(),
  changedFiles: z.array(z.string()).default([]),
  untrackedFiles: z.array(z.string()).default([]),
  patchPath: z.string().optional(),
});
export type CodeChangeSummary = z.infer<typeof CodeChangeSummarySchema>;

export const ExternalLinkSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  flowRunId: z.string().optional(),
  kind: z.enum(["pull_request", "issue", "ci_run", "commit", "doc", "other"]),
  url: z.string(),
  title: z.string().optional(),
  createdBy: ActorRefSchema.optional(),
  createdAt: IsoDate,
});
export type ExternalLink = z.infer<typeof ExternalLinkSchema>;

export const EvidenceBundleSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  flowRunId: z.string(),
  summary: z.string(),
  /** Mirror of the flow run summary (jobs/status counters), stored as-is. */
  flowSummary: z.record(z.unknown()).optional(),
  flowArtifacts: z.array(ArtifactRefSchema).default([]),
  validationEvidence: z.array(ValidationEvidenceSchema).default([]),
  codeChanges: z.array(CodeChangeSummarySchema).default([]),
  externalLinks: z.array(ExternalLinkSchema).default([]),
  humanDecisions: z.array(HumanDecisionSchema).default([]),
  risks: z.array(z.string()).default([]),
  permissionSnapshotId: z.string().optional(),
  createdAt: IsoDate,
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AUDIT_EVENT_TYPES = [
  "project.created",
  "project.updated",
  "project.archived",
  "repository.registered",
  "execution_profile.created",
  "task.created",
  "task.status_changed",
  "task.cancelled",
  "permission_snapshot.created",
  "flow_run.started",
  "flow_run.synced",
  "flow_run.completed",
  "flow_run.failed",
  "workspace.linked",
  "human_gate.opened",
  "human_gate.decided",
  "evidence.collected",
  "external_link.added",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AuditEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: ActorRefSchema.optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  flowRunId: z.string().optional(),
  detail: z.record(z.unknown()).default({}),
  createdAt: IsoDate,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// API-facing views
// ---------------------------------------------------------------------------

export interface TaskStatusView {
  task: ZigmaTask;
  flowRuns: FlowRunRef[];
  pendingGates: HumanGateRequest[];
  workspaces: WorkspaceRef[];
  externalLinks: ExternalLink[];
  permissionSnapshots: PermissionSnapshot[];
  latestEvidenceBundleId?: string;
}

export interface StartTaskOptions {
  workflowId?: string;
  executionProfileId?: string;
  workspaceId?: string;
  inputs?: Record<string, string>;
  grants?: Partial<PermissionGrants>;
  actor?: ActorRef;
  /** Wait for the flow process to exit before returning (default false). */
  wait?: boolean;
}
