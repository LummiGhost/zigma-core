import type {
  AddEvidenceItemInput,
  CallerContext,
  FlowRunStatus,
  RepositoryBinding,
  WorkspacePolicy
} from "./schemas.js";

export interface WorkspacePreparationRequest {
  projectId: string;
  taskId: string;
  flowRunId: string;
  repository: RepositoryBinding;
  baseRef: string;
  branch: string;
  policy: WorkspacePolicy;
  command: string;
  timeoutMs: number;
  environment: Record<string, string>;
}

export interface PreparedWorkspace {
  provider: string;
  externalId: string;
  path: string;
  repositoryUrl: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  mode: "writable" | "read-only";
  metadata: Record<string, unknown>;
}

export interface WorkspaceEvidence {
  items: AddEvidenceItemInput[];
}

export interface WorkspaceInvocationContext {
  command: string;
  timeoutMs: number;
  environment: Record<string, string>;
}

export interface WorkspaceProvider {
  preflight(context: WorkspaceInvocationContext): Promise<void>;
  prepare(request: WorkspacePreparationRequest): Promise<PreparedWorkspace>;
  bindRun?(externalWorkspaceId: string, taskId: string, flowRunId: string, context: WorkspaceInvocationContext): Promise<void>;
  collectEvidence?(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<WorkspaceEvidence>;
  cleanup?(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<void>;
}

export interface FlowStartRequest {
  /** Stable Core operation identity used by Flow/Workspace for idempotent provider calls. */
  operationId?: string;
  callbackCorrelationId?: string;
  command: string;
  projectId: string;
  taskId: string;
  flowRunId: string;
  workflowRef: string;
  taskText: string;
  projectRoot: string;
  repository?: RepositoryBinding;
  baseRef?: string;
  workspacePolicy?: WorkspacePolicy;
  inputs: Record<string, string>;
  callerContext: CallerContext;
  /** ID of the PermissionSnapshot stored in Core. Sent via --context-file so zigma-flow can cross-reference. */
  permissionSnapshotId: string;
  /** Stable hash of the caller context. Sent via --context-file for integrity verification. */
  integrityHash: string;
  /** Base URL of the Core API (e.g. http://127.0.0.1:4736/v1). Sent via --context-file so zigma-flow can call back. */
  coreCallbackUrl?: string;
  backend?: string;
  parallelism?: number;
  timeoutMs: number;
  environment: Record<string, string>;
  dryRun: boolean;
}

export interface FlowStartResult {
  externalRunId: string;
  status: FlowRunStatus;
  exitCode: number;
  summary?: string;
  /** When populated from zigma-flow --json: pausedGate, artifacts, eventLogUri */
  metadata: Record<string, unknown>;
}

export interface FlowGateDecisionRequest {
  command: string;
  externalRunId: string;
  jobId: string;
  decision: "approve" | "reject";
  comment?: string;
  input: Record<string, unknown>;
  projectRoot: string;
  timeoutMs: number;
  environment: Record<string, string>;
}

export interface FlowCancelRequest {
  command: string;
  externalRunId: string;
  projectRoot: string;
  reason: string;
  timeoutMs: number;
  environment: Record<string, string>;
}

export interface FlowExecutor {
  preflight(context: WorkspaceInvocationContext): Promise<void>;
  start(request: FlowStartRequest): Promise<FlowStartResult>;
  decideGate?(request: FlowGateDecisionRequest): Promise<void>;
  cancel?(request: FlowCancelRequest): Promise<void>;
}

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(prefix: string): string;
}
