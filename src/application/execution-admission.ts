import type { Clock, ExecutionLeaseFence, IdGenerator } from "../contracts/ports.js";
import type { ExecutionPolicy } from "../contracts/schemas.js";
import type { ExecutionLease } from "../domain/models.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";

export type AdmissionResult =
  | { outcome: "acquired"; lease: ExecutionLease }
  | { outcome: "queued"; limitedBy: string[] }
  | { outcome: "reconcile"; lease: ExecutionLease };

export function executionFence(lease: ExecutionLease): ExecutionLeaseFence {
  return {
    commandId: lease.commandId,
    leaseId: lease.id,
    ownerId: lease.ownerId,
    fencingToken: lease.fencingToken
  };
}

export class ExecutionAdmissionService {
  constructor(
    private readonly store: SqliteStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  now(): string {
    return this.clock.now();
  }

  admit(commandId: string, ownerId: string, policy: ExecutionPolicy, leaseDurationMs: number): AdmissionResult {
    const now = this.clock.now();
    return this.store.admitExecutionCommand({
      commandId,
      leaseId: this.ids.next("lease"),
      ownerId,
      now,
      expiresAt: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
      policy
    });
  }

  renew(fence: ExecutionLeaseFence, leaseDurationMs: number): ExecutionLease {
    const now = this.clock.now();
    return this.store.renewExecutionLease(
      fence,
      now,
      new Date(Date.parse(now) + leaseDurationMs).toISOString()
    );
  }

  takeoverForReconciliation(commandId: string, ownerId: string, leaseDurationMs: number): ExecutionLease | undefined {
    const now = this.clock.now();
    return this.store.takeoverExecutionLeaseForReconciliation({
      commandId,
      leaseId: this.ids.next("lease"),
      ownerId,
      now,
      expiresAt: new Date(Date.parse(now) + leaseDurationMs).toISOString()
    });
  }

  pauseForReconciliation(fence: ExecutionLeaseFence, reason: string): ExecutionLease {
    return this.store.pauseExecutionLeaseForReconciliation(fence, this.clock.now(), reason);
  }

  release(fence: ExecutionLeaseFence): ExecutionLease {
    return this.store.releaseExecutionLease(fence, this.clock.now());
  }
}
