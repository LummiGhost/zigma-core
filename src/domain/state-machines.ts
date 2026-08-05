import { ConflictError } from "./errors.js";
import type { EvidenceBundleStatus, GateStatus, TaskStatus } from "./models.js";
import type { FlowRunStatus } from "../contracts/schemas.js";

const taskTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  created: new Set(["queued", "cancelled"]),
  queued: new Set(["provisioning", "cancelled", "failed"]),
  provisioning: new Set(["running", "blocked", "failed", "cancelled"]),
  running: new Set(["awaiting_human", "blocked", "completed", "failed", "cancelled"]),
  awaiting_human: new Set(["running", "blocked", "failed", "cancelled"]),
  blocked: new Set(["queued", "running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["queued"]),
  cancelled: new Set()
};

const flowTransitions: Record<FlowRunStatus, ReadonlySet<FlowRunStatus>> = {
  created: new Set(["starting", "cancelled"]),
  starting: new Set(["running", "awaiting_human", "completed", "failed", "cancelled"]),
  running: new Set(["awaiting_human", "completed", "failed", "cancelled"]),
  awaiting_human: new Set(["running", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

const gateTransitions: Record<GateStatus, ReadonlySet<GateStatus>> = {
  awaiting: new Set(["decision_pending", "expired", "cancelled"]),
  decision_pending: new Set(["decision_failed", "approved", "rejected"]),
  decision_failed: new Set(["decision_pending", "expired", "cancelled"]),
  approved: new Set(),
  rejected: new Set(),
  expired: new Set(),
  cancelled: new Set()
};

const evidenceBundleTransitions: Record<EvidenceBundleStatus, ReadonlySet<EvidenceBundleStatus>> = {
  open: new Set(["finalized", "incomplete"]),
  finalized: new Set(),
  incomplete: new Set()
};

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!taskTransitions[from].has(to)) {
    throw new ConflictError(`Invalid task transition: ${from} -> ${to}`, { from, to });
  }
}

export function assertFlowTransition(from: FlowRunStatus, to: FlowRunStatus): void {
  if (from === to) return;
  if (!flowTransitions[from].has(to)) {
    throw new ConflictError(`Invalid flow run transition: ${from} -> ${to}`, { from, to });
  }
}

export function assertGateTransition(from: GateStatus, to: GateStatus): void {
  if (from === to) return;
  if (!gateTransitions[from].has(to)) {
    throw new ConflictError(`Invalid human gate transition: ${from} -> ${to}`, { from, to });
  }
}

export function assertEvidenceBundleTransition(from: EvidenceBundleStatus, to: EvidenceBundleStatus): void {
  if (from === to) return;
  if (!evidenceBundleTransitions[from].has(to)) {
    throw new ConflictError(`Invalid evidence bundle transition: ${from} -> ${to}`, { from, to });
  }
}
