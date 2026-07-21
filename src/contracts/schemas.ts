import { z } from "zod";

export const IdSchema = z.string().min(1).max(128);
export const TimestampSchema = z.string().datetime({ offset: true });

export const ActorRefSchema = z.object({
  type: z.enum(["user", "agent", "service", "system"]),
  id: IdSchema,
  displayName: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(64).optional(),
  externalId: z.string().min(1).max(256).optional()
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const TaskSourceSchema = z.object({
  kind: z.enum(["api", "web", "mail", "code-platform", "schedule", "cli", "system"]),
  provider: z.string().min(1).max(64).optional(),
  externalId: z.string().min(1).max(256).optional(),
  url: z.string().url().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type TaskSource = z.infer<typeof TaskSourceSchema>;

export const CapabilitySchema = z.enum([
  "project:read",
  "project:configure",
  "task:create",
  "task:start",
  "task:cancel",
  "workflow:invoke",
  "workspace:create",
  "workspace:write",
  "workspace:snapshot",
  "code:read",
  "code:write",
  "code:branch:create",
  "code:pull-request:create",
  "code:pull-request:merge",
  "gate:approve",
  "gate:reject",
  "evidence:write",
  "evidence:read"
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const PermissionConstraintsSchema = z.object({
  repositoryIds: z.array(IdSchema).default([]),
  workflowRefs: z.array(z.string().min(1)).default([]),
  toolNames: z.array(z.string().min(1)).default([]),
  branchPatterns: z.array(z.string().min(1)).default([]),
  maxRunDurationMs: z.number().int().positive().optional(),
  expiresAt: TimestampSchema.optional()
});
export type PermissionConstraints = z.infer<typeof PermissionConstraintsSchema>;

export const CallerContextSchema = z.object({
  actor: ActorRefSchema,
  capabilities: z.array(CapabilitySchema).min(1),
  constraints: PermissionConstraintsSchema.default({
    repositoryIds: [],
    workflowRefs: [],
    toolNames: [],
    branchPatterns: []
  }),
  source: TaskSourceSchema
});
export type CallerContext = z.infer<typeof CallerContextSchema>;

export const RepositoryBindingSchema = z.object({
  id: IdSchema,
  provider: z.enum(["github", "gitlab", "gitea", "generic-git"]),
  url: z.string().min(1),
  defaultRef: z.string().min(1).default("main"),
  writable: z.boolean().default(true),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type RepositoryBinding = z.infer<typeof RepositoryBindingSchema>;

export const WorkspacePolicySchema = z.object({
  provider: z.enum(["zigma-workspace-cli", "existing-directory", "none"]).default("zigma-workspace-cli"),
  mode: z.enum(["writable", "read-only"]).default("writable"),
  branchTemplate: z.string().min(1).default("zigma/{taskId}"),
  cleanup: z.enum(["always", "on-success", "manual"]).default("manual"),
  snapshotOnTerminal: z.boolean().default(true)
});
export type WorkspacePolicy = z.infer<typeof WorkspacePolicySchema>;

export const CreateExecutionProfileInputSchema = z.object({
  name: z.string().min(1).max(128),
  mode: z.enum(["local-cli", "local-service", "remote-host"]).default("local-cli"),
  flowCommand: z.string().min(1).default("zigma-flow"),
  workspaceCommand: z.string().min(1).default("zigma-workspace"),
  timeoutMs: z.number().int().positive().default(3_600_000),
  environment: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type CreateExecutionProfileInput = z.infer<typeof CreateExecutionProfileInputSchema>;

export const CreateProjectInputSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  displayName: z.string().min(1).max(256),
  description: z.string().max(10_000).optional(),
  repositories: z.array(RepositoryBindingSchema).min(1),
  defaultRepositoryId: IdSchema,
  defaultWorkflowRef: z.string().min(1),
  executionProfileId: IdSchema,
  workspacePolicy: WorkspacePolicySchema.default({
    provider: "zigma-workspace-cli",
    mode: "writable",
    branchTemplate: "zigma/{taskId}",
    cleanup: "manual",
    snapshotOnTerminal: true
  }),
  skillProfileRef: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
}).superRefine((value, ctx) => {
  if (!value.repositories.some((repository) => repository.id === value.defaultRepositoryId)) {
    ctx.addIssue({
      code: "custom",
      path: ["defaultRepositoryId"],
      message: "defaultRepositoryId must reference one of repositories"
    });
  }
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const CreateTaskInputSchema = z.object({
  projectId: IdSchema,
  title: z.string().min(1).max(512),
  description: z.string().min(1).max(100_000),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  source: TaskSourceSchema,
  createdBy: ActorRefSchema,
  labels: z.array(z.string().min(1).max(64)).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const StartTaskInputSchema = z.object({
  callerContext: CallerContextSchema,
  workflowRef: z.string().min(1).optional(),
  repositoryId: IdSchema.optional(),
  baseRef: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.string()).default({}),
  backend: z.string().min(1).optional(),
  parallelism: z.number().int().positive().max(128).optional(),
  dryRun: z.boolean().default(false)
});
export type StartTaskInput = z.infer<typeof StartTaskInputSchema>;

export const FlowRunStatusSchema = z.enum([
  "created",
  "starting",
  "running",
  "awaiting_human",
  "completed",
  "failed",
  "cancelled"
]);
export type FlowRunStatus = z.infer<typeof FlowRunStatusSchema>;

export const RecordFlowEventInputSchema = z.object({
  eventId: IdSchema,
  externalRunId: z.string().min(1).optional(),
  type: z.enum([
    "run.started",
    "run.progress",
    "run.awaiting-human",
    "run.completed",
    "run.failed",
    "run.cancelled"
  ]),
  occurredAt: TimestampSchema,
  status: FlowRunStatusSchema.optional(),
  summary: z.string().max(50_000).optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).default({})
  }).optional(),
  payload: z.record(z.string(), z.unknown()).default({})
});
export type RecordFlowEventInput = z.infer<typeof RecordFlowEventInputSchema>;

export const CreateHumanGateInputSchema = z.object({
  externalGateId: z.string().min(1),
  taskId: IdSchema,
  flowRunId: IdSchema,
  jobId: z.string().min(1),
  stepId: z.string().min(1),
  prompt: z.string().min(1).max(100_000),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  allowedApprovers: z.array(ActorRefSchema).default([]),
  dueAt: TimestampSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type CreateHumanGateInput = z.infer<typeof CreateHumanGateInputSchema>;

export const DecideHumanGateInputSchema = z.object({
  actor: ActorRefSchema,
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(20_000).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  callerCapabilities: z.array(CapabilitySchema)
});
export type DecideHumanGateInput = z.infer<typeof DecideHumanGateInputSchema>;

export const EvidenceKindSchema = z.enum([
  "flow-artifact",
  "flow-event-log",
  "validation",
  "workspace-diff",
  "workspace-snapshot",
  "code-change",
  "pull-request",
  "ci-result",
  "human-decision",
  "summary",
  "external-link",
  "other"
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const AddEvidenceItemInputSchema = z.object({
  kind: EvidenceKindSchema,
  name: z.string().min(1).max(512),
  uri: z.string().min(1),
  mediaType: z.string().min(1).max(256).optional(),
  digest: z.string().min(1).max(256).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  summary: z.string().max(50_000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type AddEvidenceItemInput = z.infer<typeof AddEvidenceItemInputSchema>;

export const FinalizeEvidenceInputSchema = z.object({
  summary: z.string().min(1).max(100_000),
  risks: z.array(z.string().min(1).max(10_000)).default([]),
  conclusions: z.array(z.string().min(1).max(10_000)).default([])
});
export type FinalizeEvidenceInput = z.infer<typeof FinalizeEvidenceInputSchema>;
