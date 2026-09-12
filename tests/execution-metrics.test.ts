import { describe, expect, it } from "vitest";
import {
  EXECUTION_METRICS_COUNTERS,
  EXECUTION_METRICS_DURATIONS,
  ExecutionMetrics,
  ExecutionMetricsRegistry,
  type ExecutionMetricsSnapshot
} from "../src/domain/execution-metrics.js";

const NOW = "2026-07-20T00:00:00.000Z";

function emptySnapshot(): ExecutionMetricsSnapshot {
  return new ExecutionMetrics().snapshot(NOW);
}

describe("ExecutionMetrics", () => {
  it("starts with zeroed counters and empty duration stats", () => {
    const snapshot = emptySnapshot();
    for (const name of EXECUTION_METRICS_COUNTERS) expect(snapshot.counters[name]).toBe(0);
    for (const name of EXECUTION_METRICS_DURATIONS) {
      expect(snapshot.durations[name]).toEqual({ count: 0, totalMs: 0, minMs: 0, maxMs: 0 });
    }
    expect(snapshot.updatedAt).toBe(NOW);
  });

  it("accumulates counters and rejects invalid increments", () => {
    const metrics = new ExecutionMetrics();
    metrics.increment("dispatched");
    metrics.increment("dispatched", 2);
    expect(metrics.snapshot(NOW).counters["dispatched"]).toBe(3);
    expect(() => metrics.increment("dispatched", -1)).toThrow();
    expect(() => metrics.increment("dispatched", 0.5)).toThrow();
  });

  it("tracks duration count, total, min, and max", () => {
    const metrics = new ExecutionMetrics();
    metrics.recordDuration("queue_to_dispatch", 120);
    metrics.recordDuration("queue_to_dispatch", 80);
    metrics.recordDuration("queue_to_dispatch", 200);
    expect(metrics.snapshot(NOW).durations["queue_to_dispatch"]).toEqual({
      count: 3,
      totalMs: 400,
      minMs: 80,
      maxMs: 200
    });
  });

  it("rejects negative or non-finite durations", () => {
    const metrics = new ExecutionMetrics();
    expect(() => metrics.recordDuration("quiescence", -1)).toThrow();
    expect(() => metrics.recordDuration("quiescence", Number.NaN)).toThrow();
  });

  it("restores from a persisted snapshot and continues accumulating", () => {
    const seeded = new ExecutionMetrics({
      counters: { ...emptySnapshot().counters, completed: 4, workspace_conflicts: 1 },
      durations: {
        ...emptySnapshot().durations,
        start_to_terminal: { count: 4, totalMs: 900, minMs: 150, maxMs: 300 }
      },
      updatedAt: NOW
    });
    seeded.increment("failed");
    seeded.recordDuration("start_to_terminal", 100);
    const snapshot = seeded.snapshot("2026-07-20T00:01:00.000Z");
    expect(snapshot.counters["completed"]).toBe(4);
    expect(snapshot.counters["failed"]).toBe(1);
    expect(snapshot.durations["start_to_terminal"]).toEqual({
      count: 5,
      totalMs: 1000,
      minMs: 100,
      maxMs: 300
    });
    expect(snapshot.updatedAt).toBe("2026-07-20T00:01:00.000Z");
  });

  it("normalizes malformed seeds instead of throwing", () => {
    const metrics = new ExecutionMetrics({
      counters: { completed: 2, started: "oops" } as unknown as ExecutionMetricsSnapshot["counters"],
      durations: {} as unknown as ExecutionMetricsSnapshot["durations"],
      updatedAt: NOW
    });
    const snapshot = metrics.snapshot(NOW);
    expect(snapshot.counters["completed"]).toBe(2);
    expect(snapshot.counters["started"]).toBe(0);
    expect(snapshot.durations["quiescence"].count).toBe(0);
  });

  it("returns defensive copies from snapshot", () => {
    const metrics = new ExecutionMetrics();
    metrics.increment("started");
    const first = metrics.snapshot(NOW);
    first.counters["started"] = 99;
    first.durations["quiescence"] = { count: 7, totalMs: 1, minMs: 1, maxMs: 1 };
    const second = metrics.snapshot(NOW);
    expect(second.counters["started"]).toBe(1);
    expect(second.durations["quiescence"].count).toBe(0);
  });
});

describe("ExecutionMetricsRegistry", () => {
  it("restores the persisted snapshot only on first touch", () => {
    const persisted = new ExecutionMetrics({ counters: { ...emptySnapshot().counters, dispatched: 5 }, durations: emptySnapshot().durations, updatedAt: NOW }).snapshot(NOW);
    let loads = 0;
    const registry = new ExecutionMetricsRegistry(() => {
      loads += 1;
      return persisted;
    });
    registry.record("run-1", (metrics) => metrics.increment("started"));
    registry.record("run-1", (metrics) => metrics.increment("started"));
    expect(loads).toBe(1);
    expect(registry.snapshot("run-1", NOW)?.counters["dispatched"]).toBe(5);
    expect(registry.snapshot("run-1", NOW)?.counters["started"]).toBe(2);
  });

  it("falls back to an empty accumulator when the loader has nothing", () => {
    const registry = new ExecutionMetricsRegistry(() => undefined);
    registry.record("run-2", (metrics) => metrics.increment("cancelled"));
    expect(registry.snapshot("run-2", NOW)?.counters["cancelled"]).toBe(1);
  });

  it("returns undefined for runs never touched", () => {
    const registry = new ExecutionMetricsRegistry();
    expect(registry.snapshot("missing", NOW)).toBeUndefined();
  });

  it("explicit restore is ignored once the run was touched", () => {
    const registry = new ExecutionMetricsRegistry();
    registry.record("run-3", (metrics) => metrics.increment("completed"));
    registry.restore("run-3", new ExecutionMetrics({ counters: { ...emptySnapshot().counters, completed: 10 }, durations: emptySnapshot().durations, updatedAt: NOW }).snapshot(NOW));
    expect(registry.snapshot("run-3", NOW)?.counters["completed"]).toBe(1);
  });

  it("record with a timestamp returns the refreshed snapshot", () => {
    const registry = new ExecutionMetricsRegistry();
    const snapshot = registry.record("run-4", (metrics) => metrics.increment("failed"), NOW);
    expect(snapshot?.counters["failed"]).toBe(1);
    expect(snapshot?.updatedAt).toBe(NOW);
  });
});
