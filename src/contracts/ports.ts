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
  prepare(request: WorkspacePreparationRequest): Promise<PreparedWorkspace>;
  bindRun?(externalWorkspaceId: string, taskId: string, flowRunId: string, context: WorkspaceInvocationContext): Promise<void>;
  collectEvidence?(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<WorkspaceEvidence>;
  cleanup?(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<void>;
}

export interface FlowStartRequest {
  command: string;
  taskId: string;
  flowRunId: string;
  workflowRef: string;
  taskText: string;
  projectRoot: string;
  inputs: Record<string, string>;
  callerContext: CallerContext;
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
