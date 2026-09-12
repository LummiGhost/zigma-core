/**
 * Per-flow-run execution metrics accumulated in-process and persisted as a
 * JSON snapshot on the flow_runs row at terminal and reconciliation
 * boundaries. Snapshots describe a single Core process window: after a
 * restart, the persisted snapshot is restored as the seed and accumulation
 * continues. No exporters, histograms, or dashboards are provided.
 */

export type ExecutionMetricsCounter =
  | "dispatched"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_human"
  | "workspace_conflicts"
  | "lease_fences"
  | "reconcile_restarts"
  | "worker_kills"
  | "admission_denied";

export type ExecutionMetricsDuration =
  | "queue_to_dispatch"
  | "dispatch_to_start"
  | "start_to_terminal"
  | "quiescence";

export const EXECUTION_METRICS_COUNTERS: readonly ExecutionMetricsCounter[] = [
  "dispatched",
  "started",
  "completed",
  "failed",
  "cancelled",
  "awaiting_human",
  "workspace_conflicts",
  "lease_fences",
  "reconcile_restarts",
  "worker_kills",
  "admission_denied",
];

export const EXECUTION_METRICS_DURATIONS: readonly ExecutionMetricsDuration[] = [
  "queue_to_dispatch",
  "dispatch_to_start",
  "start_to_terminal",
  "quiescence",
];

export interface ExecutionMetricsDurationStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
}

export interface ExecutionMetricsSnapshot {
  counters: Record<ExecutionMetricsCounter, number>;
  durations: Record<ExecutionMetricsDuration, ExecutionMetricsDurationStats>;
  updatedAt: string;
}

const EMPTY_DURATION_STATS: ExecutionMetricsDurationStats = {
  count: 0,
  totalMs: 0,
  minMs: 0,
  maxMs: 0,
};

function copyDurationStats(stats: ExecutionMetricsDurationStats): ExecutionMetricsDurationStats {
  return { ...stats };
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Counters and duration statistics for one flow run. Durations record wall
 * time between ISO timestamps in milliseconds, clamped to zero.
 */
export class ExecutionMetrics {
  private readonly counters: Record<ExecutionMetricsCounter, number>;
  private readonly durations: Record<ExecutionMetricsDuration, ExecutionMetricsDurationStats>;

  constructor(seed?: ExecutionMetricsSnapshot) {
    this.counters = Object.fromEntries(
      EXECUTION_METRICS_COUNTERS.map((name) => [name, 0]),
    ) as Record<ExecutionMetricsCounter, number>;
    this.durations = Object.fromEntries(
      EXECUTION_METRICS_DURATIONS.map((name) => [name, copyDurationStats(EMPTY_DURATION_STATS)]),
    ) as Record<ExecutionMetricsDuration, ExecutionMetricsDurationStats>;
    if (seed) {
      for (const name of EXECUTION_METRICS_COUNTERS) {
        const value = seed.counters[name];
        if (validNonNegativeNumber(value)) this.counters[name] = value;
      }
      for (const name of EXECUTION_METRICS_DURATIONS) {
        const stats = seed.durations[name];
        if (stats && validNonNegativeNumber(stats.count)) {
          this.durations[name] = {
            count: stats.count,
            totalMs: validNonNegativeNumber(stats.totalMs) ? stats.totalMs : 0,
            minMs: validNonNegativeNumber(stats.minMs) ? stats.minMs : 0,
            maxMs: validNonNegativeNumber(stats.maxMs) ? stats.maxMs : 0,
          };
        }
      }
    }
  }

  increment(counter: ExecutionMetricsCounter, by = 1): void {
    if (!validNonNegativeNumber(by) || !Number.isSafeInteger(by)) {
      throw new Error(`Metric increment must be a non-negative integer, got: ${String(by)}`);
    }
    this.counters[counter] += by;
  }

  recordDuration(name: ExecutionMetricsDuration, ms: number): void {
    if (!validNonNegativeNumber(ms)) {
      throw new Error(`Metric duration must be a non-negative number of milliseconds, got: ${String(ms)}`);
    }
    const stats = this.durations[name];
    stats.count += 1;
    stats.totalMs += ms;
    stats.minMs = stats.count === 1 ? ms : Math.min(stats.minMs, ms);
    stats.maxMs = Math.max(stats.maxMs, ms);
  }

  snapshot(updatedAt: string): ExecutionMetricsSnapshot {
    return {
      counters: { ...this.counters },
      durations: Object.fromEntries(
        EXECUTION_METRICS_DURATIONS.map((name) => [name, copyDurationStats(this.durations[name])]),
      ) as Record<ExecutionMetricsDuration, ExecutionMetricsDurationStats>,
      updatedAt,
    };
  }
}

/**
 * Process-wide registry keyed by flow run id. The optional loader seeds an
 * accumulator from the persisted snapshot on first touch, which is how
 * reconciliation restores the partial snapshot of an interrupted run instead
 * of starting from zero. All components that attribute metrics to a run must
 * share one registry instance for their counters to land in the persisted
 * snapshot.
 */
export class ExecutionMetricsRegistry {
  private readonly entries = new Map<string, ExecutionMetrics>();

  constructor(
    private readonly loader?: (flowRunId: string) => ExecutionMetricsSnapshot | undefined,
  ) {}

  /** Seeds the accumulator for a run unless one already exists in this process window. */
  restore(flowRunId: string, snapshot: ExecutionMetricsSnapshot): void {
    if (this.entries.has(flowRunId)) return;
    this.entries.set(flowRunId, new ExecutionMetrics(snapshot));
  }

  /**
   * Applies a mutation to the run's accumulator. Pass `now` to also receive
   * the snapshot reflecting the mutation; terminal transitions use this to
   * persist the snapshot in the same transaction timestamp.
   */
  record(
    flowRunId: string,
    apply: (metrics: ExecutionMetrics) => void,
    now?: string,
  ): ExecutionMetricsSnapshot | undefined {
    const metrics = this.ensure(flowRunId);
    apply(metrics);
    return now !== undefined ? metrics.snapshot(now) : undefined;
  }

  snapshot(flowRunId: string, now: string): ExecutionMetricsSnapshot | undefined {
    return this.entries.get(flowRunId)?.snapshot(now);
  }

  private ensure(flowRunId: string): ExecutionMetrics {
    const existing = this.entries.get(flowRunId);
    if (existing) return existing;
    const created = new ExecutionMetrics(this.loader?.(flowRunId));
    this.entries.set(flowRunId, created);
    return created;
  }
}
