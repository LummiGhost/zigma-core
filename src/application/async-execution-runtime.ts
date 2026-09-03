import type { ExecutionPolicy } from "../contracts/schemas.js";
import type { CoreService } from "./core-service.js";
import type { ExecutionAdmissionService } from "./execution-admission.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";

export interface AsyncExecutionRuntimeOptions {
  ownerId: string;
  leaseDurationMs?: number;
  pollIntervalMs?: number;
  policyFor(commandId: string): ExecutionPolicy;
}

export class AsyncExecutionRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly store: SqliteStore,
    private readonly core: CoreService,
    private readonly admission: ExecutionAdmissionService,
    private readonly options: AsyncExecutionRuntimeOptions
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
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
      for (const command of this.store.listInFlightExecutionCommands()) {
        if (command.status === "reconciling") continue;
        this.admission.admit(command.id, this.options.ownerId, this.options.policyFor(command.id), this.leaseDurationMs);
      }
      for (const command of this.store.listDispatchableExecutionCommands()) {
        const admitted = this.admission.admit(command.id, this.options.ownerId, this.options.policyFor(command.id), this.leaseDurationMs);
        if (admitted.outcome !== "acquired") continue;
        try {
          await this.core.dispatchExecutionCommand(command.id);
          dispatched += 1;
        } catch {
          // Core persists the terminal failure before returning. A later policy-aware
          // reconciler may explicitly requeue it; this worker never retries blindly.
        } finally {
          const current = this.store.getExecutionLease(command.id);
          if (current?.status === "active" && current.ownerId === this.options.ownerId) {
            this.admission.release(command.id, current.ownerId, current.fencingToken);
          }
        }
      }
      return dispatched;
    } finally {
      this.running = false;
    }
  }
}
