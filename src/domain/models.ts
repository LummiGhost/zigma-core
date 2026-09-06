import type {
  ActorRef,
  EvidenceKind,
  ExecutionPolicy,
  FlowRunStatus,
  PermissionConstraints,
  RepositoryBinding,
  TaskSource,
  WorkspacePolicy
} from "../contracts/schemas.js";

export type ProjectStatus = "active" | "archived";
export type TaskStatus =
  | "created"
  | "queued"
  | "provisioning"
  | "running"
  | "awaiting_human"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
export type GateStatus =
  | "awaiting"
  | "decision_pending"
  | "decision_failed"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";
export type WorkspaceStatus = "preparing" | "ready" | "active" | "released" | "failed";
export type EvidenceBundleStatus = "open" | "finalized" | "incomplete";
export type ExecutionCommandStatus =
  | "pending"
  | "leased"
  | "dispatching"
  | "dispatched"
  | "cancel_requested"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled";
export type OutboxDeliveryStatus = "pending" | "claimed" | "delivered" | "failed" | "cancelled";
export type ExecutionLeaseStatus = "active" | "reconciling" | "released";

export interface ExecutionProfile {
  id: string;
  name: string;
  mode: "local-cli" | "local-service" | "remote-host";
  flowCommand: string;
  workspaceCommand: string;
  timeoutMs: number;
  executionPolicy: ExecutionPolicy;
  environment: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  key: string;
  displayName: string;
  description?: string;
  status: ProjectStatus;
  repositories: RepositoryBinding[];
  defaultRepositoryId: string;
  defaultWorkflowRef: string;
  executionProfileId: string;
  workspacePolicy: WorkspacePolicy;
  skillProfileRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface TaskFailure {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  source: TaskSource;
  createdBy: ActorRef;
  status: TaskStatus;
  labels: string[];
  metadata: Record<string, unknown>;
  activeFlowRunId?: string;
  revision: number;
  failure?: TaskFailure;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PermissionSnapshot {
  id: string;
  taskId: string;
  actor: ActorRef;
  capabilities: string[];
  constraints: PermissionConstraints;
  source: TaskSource;
  hash: string;
  createdAt: string;
  expiresAt?: string;
}

export interface WorkspaceRef {
  id: string;
  taskId: string;
  flowRunId: string;
  provider: string;
  externalId: string;
  path: string;
  repositoryUrl: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  mode: "writable" | "read-only";
  status: WorkspaceStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
}

export interface ProviderWorkspaceHandle {
  id: string;
  flowRunId: string;
  provider: string;
  externalId: string;
  scope: "run" | "job-attempt";
  jobId?: string;
  attempt?: number;
  status: string;
  path?: string;
  repositoryUrl?: string;
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  metadata: Record<string, unknown>;
  lastEventId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowRun {
  id: string;
  taskId: string;
  workflowRef: string;
  executionProfileId: string;
  permissionSnapshotId: string;
  workspaceId?: string;
  externalRunId?: string;
  status: FlowRunStatus;
  attempt: number;
  /** Last accepted V1 Core callback sequence; zero before the first callback. */
  lastCallbackSequence: number;
  inputs: Record<string, string>;
  context: Record<string, unknown>;
  exitCode?: number;
  error?: TaskFailure;
  startedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ExecutionCommand {
  id: string;
  operationId: string;
  idempotencyKey?: string;
  inputHash: string;
  taskId: string;
  flowRunId: string;
  projectId: string;
  repositoryId: string;
  repositoryUrl: string;
  baseRef: string;
  backend: string;
  workspacePolicy: WorkspacePolicy;
  permissionSnapshotId: string;
  callbackCorrelationId: string;
  status: ExecutionCommandStatus;
  attempt: number;
  payload: Record<string, unknown>;
  providerResponse?: Record<string, unknown>;
  lastError?: string;
  dispatchStartedAt?: string;
  cancelRequestedAt?: string;
  cancelAcknowledgedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface OutboxDelivery {
  id: string;
  topic: "execution-command.requested";
  aggregateId: string;
  payload: Record<string, unknown>;
  status: OutboxDeliveryStatus;
  attempt: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  claimOwnerId?: string;
  claimFencingToken?: number;
  claimedAt?: string;
  claimExpiresAt?: string;
  deliveredAt?: string;
  lastError?: string;
}

export interface ExecutionLease {
  id: string;
  commandId: string;
  ownerId: string;
  fencingToken: number;
  status: ExecutionLeaseStatus;
  projectId: string;
  repositoryUrl: string;
  backend: string;
  writable: boolean;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface HumanGate {
  id: string;
  externalGateId: string;
  taskId: string;
  flowRunId: string;
  jobId: string;
  stepId: string;
  prompt: string;
  inputSchema: Record<string, unknown>;
  allowedApprovers: ActorRef[];
  status: GateStatus;
  dueAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface HumanDecision {
  id: string;
  gateId: string;
  actor: ActorRef;
  decision: "approve" | "reject";
  comment?: string;
  input: Record<string, unknown>;
  deliveryStatus: "pending" | "failed" | "delivered";
  lastError?: string;
  /** Latest append-only delivery attempt number. */
  deliveryAttempt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceBundle {
  id: string;
  taskId: string;
  flowRunId: string;
  status: EvidenceBundleStatus;
  summary?: string;
  risks: string[];
  conclusions: string[];
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
}

export interface EvidenceItem {
  id: string;
  bundleId: string;
  kind: EvidenceKind;
  name: string;
  uri: string;
  mediaType?: string;
  digest?: string;
  sizeBytes?: number;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  aggregateType: "project" | "task" | "flow-run" | "workspace" | "human-gate" | "evidence-bundle" | "execution-profile";
  aggregateId: string;
  action: string;
  actor: ActorRef;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  createdAt: string;
}
