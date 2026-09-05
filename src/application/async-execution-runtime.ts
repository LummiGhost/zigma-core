import type { ExecutionLeaseFence } from "../contracts/ports.js";
import type { ExecutionPolicy } from "../contracts/schemas.js";
import type { ExecutionLease, OutboxDelivery } from "../domain/models.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import {
  CoreService,
  DispatchCrashpointError,
  type DispatchExecutionPhase
} from "./core-service.js";
import { ExecutionAdmissionService, executionFence } from "./execution-admission.js";

export interface AsyncExecutionRuntimeOptions {
  ownerId: string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  policyFor(commandId: string): ExecutionPolicy;
  /** Fault-injection/telemetry seam. Throw DispatchCrashpointError to emulate process loss. */
  onPhase?(phase: DispatchExecutionPhase, commandId: string): void | Promise<void>;
}

export class AsyncExecutionRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly store: SqliteStore,
    private readonly core: CoreService,
    private readonly admission: ExecutionAdmissionService,
    private readonly options: AsyncExecutionRuntimeOptions
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(10, Math.floor(this.leaseDurationMs / 3));
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let dispatched = 0;
    try {
      await this.reconcileRecoverableCommands();

      // The outbox is the only source for new provider deliveries. Command
      // status is a projection and is never enumerated as a dispatch queue.
      const now = this.admission.now();
      for (const due of this.store.listDueOutboxDeliveries(now)) {
        const command = this.store.getExecutionCommand(due.aggregateId);
        if (command.status !== "pending") continue;
        const admitted = this.admission.admit(
          command.id,
          this.options.ownerId,
          this.options.policyFor(command.id),
          this.leaseDurationMs
        );
        if (admitted.outcome !== "acquired") continue;

        const fence = executionFence(admitted.lease);
        await this.phase("lease-acquired", command.id);
        const claimed = this.store.claimOutboxDelivery(
          due.id,
          fence,
          admitted.lease.renewedAt,
          admitted.lease.expiresAt
        );
        if (!claimed) {
          this.admission.release(fence);
          continue;
        }
        await this.phase("outbox-claimed", command.id);

        try {
          await this.withHeartbeat(fence, () => this.core.dispatchExecutionCommand(command.id, {
            fence,
            onPhase: (phase) => this.phase(phase, command.id)
          }));
          dispatched += 1;
          await this.finalizeDelivery(command.id, claimed, fence);
        } catch (error) {
          if (error instanceof DispatchCrashpointError) throw error;
          this.handleDispatchFailure(command.id, claimed, fence, error);
        }
      }
      return dispatched;
    } finally {
      this.running = false;
    }
  }

  private async reconcileRecoverableCommands(): Promise<void> {
    for (const command of this.store.listInFlightExecutionCommands()) {
      let lease = this.store.getExecutionLease(command.id);
      if (!lease || lease.status === "released") continue;

      if (!(lease.status === "active" && lease.ownerId === this.options.ownerId)) {
        const takeover = this.admission.takeoverForReconciliation(
          command.id,
          this.options.ownerId,
          this.leaseDurationMs
        );
        if (!takeover) continue;
        lease = takeover;
      }

      const fence = executionFence(lease);
      const delivery = this.store.getOutboxDeliveryForCommand(command.id);
      if (["completed", "failed", "cancelled"].includes(command.status)) {
        if (delivery) await this.finalizeDelivery(command.id, delivery, fence);
        else this.admission.release(fence);
        continue;
      }

      try {
        await this.withHeartbeat(fence, () => this.core.reconcileExecutionCommand(command.id, fence));
        const current = this.store.getExecutionCommand(command.id);
        const currentDelivery = this.store.getOutboxDeliveryForCommand(command.id);
        if (["completed", "failed", "cancelled"].includes(current.status)) {
          if (currentDelivery) await this.finalizeDelivery(command.id, currentDelivery, fence);
          else this.admission.release(fence);
        } else if (current.status !== "pending") {
          this.admission.pauseForReconciliation(fence, current.lastError ?? "Provider truth is not terminal");
        }
      } catch (error) {
        if (error instanceof DispatchCrashpointError) throw error;
        const currentLease = this.store.getExecutionLease(command.id);
        if (this.isCurrentFence(currentLease, fence) && currentLease?.status === "active") {
          try {
            this.admission.pauseForReconciliation(
              fence,
              error instanceof Error ? error.message : String(error)
            );
          } catch {
            // The lease may expire between the read above and the fenced
            // transition. The successor owns reconciliation in that case.
          }
        }
      }
    }
  }

  private async finalizeDelivery(commandId: string, delivery: OutboxDelivery, fence: ExecutionLeaseFence): Promise<void> {
    const command = this.store.getExecutionCommand(commandId);
    const currentDelivery = this.store.getOutboxDeliveryForCommand(commandId) ?? delivery;
    if (currentDelivery.status === "claimed") {
      if (command.providerResponse) {
        // An outbox acknowledgement says the provider answered durably; it does
        // not say the provider-owned run succeeded. A failed Flow run is still
        // a successfully delivered execution command.
        this.store.acknowledgeOutboxDelivery(currentDelivery.id, fence, this.admission.now());
        await this.phase("outbox-acknowledged", commandId);
      } else if (command.status === "failed") {
        this.store.failOutboxDelivery(
          currentDelivery.id,
          fence,
          this.admission.now(),
          command.lastError ?? "Execution command failed"
        );
      }
    }

    const after = this.store.getExecutionCommand(commandId);
    if (["completed", "failed", "cancelled"].includes(after.status)) {
      this.admission.release(fence);
      return;
    }
    this.admission.pauseForReconciliation(fence, after.lastError ?? "Provider run remains in flight");
  }

  private handleDispatchFailure(
    commandId: string,
    delivery: OutboxDelivery,
    fence: ExecutionLeaseFence,
    error: unknown
  ): void {
    const lease = this.store.getExecutionLease(commandId);
    if (!this.isCurrentFence(lease, fence) || lease?.status !== "active") return;
    const command = this.store.getExecutionCommand(commandId);
    const message = error instanceof Error ? error.message : String(error);
    if (command.status === "pending") {
      this.store.releaseOutboxClaim(delivery.id, fence, this.admission.now(), message);
      this.admission.release(fence);
      return;
    }
    if (command.status === "failed") {
      this.store.failOutboxDelivery(delivery.id, fence, this.admission.now(), message);
      this.admission.release(fence);
      return;
    }
    try {
      this.admission.pauseForReconciliation(fence, message);
    } catch {
      // Losing a lease while recording a delivery failure is expected under
      // fencing. Never let a stale worker overwrite the successor's state.
    }
  }

  private async withHeartbeat<T>(fence: ExecutionLeaseFence, operation: () => Promise<T>): Promise<T> {
    let heartbeatError: unknown;
    const timer = setInterval(() => {
      try {
        this.admission.renew(fence, this.leaseDurationMs);
      } catch (error) {
        heartbeatError = error;
      }
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    try {
      const result = await operation();
      if (heartbeatError) throw heartbeatError;
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async phase(phase: DispatchExecutionPhase, commandId: string): Promise<void> {
    await this.options.onPhase?.(phase, commandId);
  }

  private isCurrentFence(lease: ExecutionLease | undefined, fence: ExecutionLeaseFence): boolean {
    return lease?.id === fence.leaseId
      && lease.ownerId === fence.ownerId
      && lease.fencingToken === fence.fencingToken;
  }
}
