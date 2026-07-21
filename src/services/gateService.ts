/**
 * Human gate service (FR-008).
 *
 * Flow:
 *   1. ExecutionService.syncRun mirrors flow `human_gate_waiting` into
 *      HumanGateRequest rows.
 *   2. External channels (CLI/API/Web/Mail) call approve()/reject() here.
 *   3. Core validates the approver against the gate's allowedApprovers and
 *      the run's PermissionSnapshot.
 *   4. The decision is relayed to zigma-flow (`approve`/`reject` CLI).
 *   5. A HumanDecision + audit record is written and, if configured, the
 *      blocked run is resumed via `invoke --resume`.
 */

import type { Repos } from "../db/repos.js";
import { invalidState, notFound, permissionDenied } from "../errors.js";
import type {
  HumanDecision,
  HumanGateDecisionInput,
  HumanGateRequest,
} from "../types/index.js";
import { HumanGateDecisionInputSchema } from "../types/index.js";
import type { FlowInvoker } from "../adapters/flow/types.js";
import type { PermissionService } from "./permissionService.js";

export interface GateServiceOptions {
  /** Automatically `invoke --resume` the run after an approval. Default true. */
  autoResumeAfterApprove?: boolean;
}

export class GateService {
  private readonly autoResume: boolean;

  constructor(
    private repos: Repos,
    private permissions: PermissionService,
    private invoker: FlowInvoker,
    options: GateServiceOptions = {}
  ) {
    this.autoResume = options.autoResumeAfterApprove ?? true;
  }

  list(filter?: { status?: HumanGateRequest["status"]; taskId?: string }): HumanGateRequest[] {
    return this.repos.gates.list(filter);
  }

  async approve(input: HumanGateDecisionInput): Promise<HumanGateRequest> {
    return this.decide(input, "approve");
  }

  async reject(input: HumanGateDecisionInput): Promise<HumanGateRequest> {
    return this.decide(input, "reject");
  }

  private async decide(
    rawInput: HumanGateDecisionInput,
    decision: "approve" | "reject"
  ): Promise<HumanGateRequest> {
    const input = HumanGateDecisionInputSchema.parse(rawInput);
    const gate = this.repos.gates.get(input.gateRequestId);
    if (!gate) throw notFound("HumanGateRequest", input.gateRequestId);
    if (gate.status !== "awaiting") {
      throw invalidState(`Gate ${gate.id} is not awaiting (status=${gate.status})`);
    }

    const run = this.repos.flowRuns.get(gate.flowRunId);
    if (!run) throw notFound("FlowRunRef", gate.flowRunId);
    const snapshot = this.repos.snapshots.get(run.permissionSnapshotId);
    if (!snapshot) throw notFound("PermissionSnapshot", run.permissionSnapshotId);

    if (!this.permissions.canApprove(snapshot, input.actor, gate.allowedApprovers)) {
      throw permissionDenied(
        `Actor ${input.actor.id} is not allowed to decide gate ${gate.id}`,
        { gateId: gate.id, actorId: input.actor.id }
      );
    }

    // Relay the decision to zigma-flow (idempotent on the flow side).
    await this.invoker.decideGate({
      cwd: run.invocationCwd,
      zigmaFlowRunId: gate.zigmaFlowRunId,
      jobId: gate.jobId,
      stepId: gate.stepId,
      decision,
      comment: input.comment,
    });

    this.repos.gates.resolve(gate.id, decision === "approve" ? "approved" : "rejected");
    const record: HumanDecision = this.repos.decisions.insert({
      gateRequestId: gate.id,
      taskId: gate.taskId,
      flowRunId: gate.flowRunId,
      decision,
      comment: input.comment,
      actor: input.actor,
    });

    this.repos.audit.append({
      type: "human_gate.decided",
      actor: input.actor,
      taskId: gate.taskId,
      flowRunId: gate.flowRunId,
      detail: {
        gateId: gate.id,
        decisionId: record.id,
        decision,
        jobId: gate.jobId,
        stepId: gate.stepId,
        comment: input.comment,
      },
    });

    if (decision === "approve" && this.autoResume) {
      try {
        await this.invoker.resume(run.invocationCwd, gate.zigmaFlowRunId, false);
      } catch {
        // Resume is best-effort; the run can also be resumed manually.
      }
    }

    return this.repos.gates.get(gate.id)!;
  }
}
