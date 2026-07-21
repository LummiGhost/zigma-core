/**
 * FlowInvoker: the narrow contract Core requires from a zigma-flow execution
 * backend. It intentionally mirrors a subset of zigma-flow's Host API
 * (src/host-api.ts in zigma-flow) so that:
 *
 *   - MVP:   LocalCliFlowInvoker shells out to the `zigma-flow` CLI.
 *   - Later: a library/service adapter can implement the same interface by
 *            calling the typed Host API directly (createRun / getRunStatus /
 *            approveHumanGate / cancelRun / collectRunEvidence).
 *
 * Core never reads or mutates flow internal state through any other path.
 */

import type { FlowCallerContext } from "../../types/index.js";

export interface FlowInvokeRequest {
  /** Directory containing .zigma-flow/ where the run should execute. */
  cwd: string;
  /** Workflow name as declared in the workflow YAML. */
  workflow: string;
  /** Task description passed via --task. */
  taskText: string;
  /** Named workflow inputs (--input key=value). */
  inputs: Record<string, string>;
  /** Caller context to snapshot into the run (host-api shape). */
  callerContext: FlowCallerContext;
  /** Wait for the process to exit instead of detaching. */
  wait?: boolean;
  timeoutSeconds?: number;
}

export interface FlowInvokeHandle {
  /** zigma-flow run id, if it could be discovered at start time. */
  zigmaFlowRunId?: string;
  /** Detached process pid, if spawned asynchronously. */
  pid?: number;
  /** Set when wait=true and the process exited. */
  exitCode?: number;
}

/** Mirror of the data Core needs from `zigma-flow inspect --json`. */
export interface FlowRunStatusMirror {
  runId: string;
  workflow?: string;
  status: "running" | "blocked" | "failed" | "completed" | "cancelled";
  task?: string;
  createdAt?: string;
  updatedAt?: string;
  jobs: Array<{
    jobId: string;
    status?: string;
    currentStep?: string;
    stepStatus?: string;
  }>;
  pendingHumanGates: Array<{
    jobId: string;
    stepId: string;
    prompt?: string;
    approvers?: string[];
    instructions?: string;
    enteredAt?: string;
  }>;
  artifacts: Array<{
    jobId?: string;
    stepId?: string;
    name: string;
    path?: string;
    kind?: string;
    createdAt?: string;
  }>;
  events: Array<Record<string, unknown>>;
  /** Raw parsed JSON, preserved for evidence bundles. */
  raw: unknown;
}

export interface FlowGateDecision {
  cwd: string;
  zigmaFlowRunId: string;
  jobId: string;
  stepId: string;
  decision: "approve" | "reject";
  comment?: string;
}

export interface FlowInvoker {
  /** Start a new run. Corresponds to Host API createRun. */
  invoke(req: FlowInvokeRequest): Promise<FlowInvokeHandle>;
  /** Resume a blocked run (after gate decision). Corresponds to resumeRun. */
  resume(cwd: string, zigmaFlowRunId: string, wait?: boolean): Promise<FlowInvokeHandle>;
  /** Read status mirror. Corresponds to getRunStatus. */
  getStatus(cwd: string, zigmaFlowRunId: string): Promise<FlowRunStatusMirror>;
  /** Resolve a human gate. Corresponds to approveHumanGate. */
  decideGate(input: FlowGateDecision): Promise<void>;
  /** Cancel a run. Corresponds to cancelRun. */
  cancel(cwd: string, zigmaFlowRunId: string, reason: string): Promise<void>;
  /** List known run ids in a project directory (used for run-id discovery). */
  listRunIds(cwd: string): Promise<string[]>;
}
