import type { Clock, IdGenerator } from "../contracts/ports.js";
import type { ExecutionPolicy } from "../contracts/schemas.js";
import type { ExecutionLease } from "../domain/models.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";

export type AdmissionResult =
  | { outcome: "acquired"; lease: ExecutionLease }
  | { outcome: "queued"; limitedBy: string[] }
  | { outcome: "reconcile"; lease: ExecutionLease };

export class ExecutionAdmissionService {
  constructor(
    private readonly store: SqliteStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

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

  release(commandId: string, ownerId: string, fencingToken: number): ExecutionLease {
    return this.store.releaseExecutionLease(commandId, ownerId, fencingToken, this.clock.now());
  }
}
