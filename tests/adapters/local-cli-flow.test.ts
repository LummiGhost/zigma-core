import { describe, expect, it, vi } from "vitest";

const mockExeca = vi.fn();

vi.mock("execa", () => ({
  execa: mockExeca
}));

// Dynamic import so the mock is in place before the module loads
const { LocalCliFlowExecutor, buildContextFilePayload } = await import("../../src/adapters/local-cli-flow.js");

function jsonEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contractVersion: 1,
    runId: "run-abc123",
    status: "completed",
    exitCode: 0,
    pausedGate: null,
    artifacts: [],
    eventLogUri: "file:///tmp/events.jsonl",
    ...overrides
  });
}

function defaultRequest(overrides: Record<string, unknown> = {}) {
  return {
    command: "zigma-flow",
    taskId: "task-1",
    flowRunId: "fr-1",
    workflowRef: "wf/main",
    taskText: "build something",
    projectRoot: "/tmp/project",
    inputs: { key: "value" },
    callerContext: {
      actor: { type: "user" as const, id: "alice" },
      capabilities: ["task:create" as const],
      constraints: { repositoryIds: [], workflowRefs: [], toolNames: [], branchPatterns: [] },
      source: { kind: "api" as const, metadata: {} }
    },
    timeoutMs: 60_000,
    environment: {},
    dryRun: false,
    ...overrides
  };
}

describe("LocalCliFlowExecutor.start", () => {
  const executor = new LocalCliFlowExecutor();

  it("parses a valid JSON envelope into a FlowStartResult", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope(),
      all: jsonEnvelope(),
      exitCode: 0
    });

    const result = await executor.start(defaultRequest());

    expect(result).toEqual({
      externalRunId: "run-abc123",
      status: "completed",
      exitCode: 0,
      summary: "zigma-flow run run-abc123 finished with status completed",
      metadata: {
        pausedGate: null,
        artifacts: [],
        eventLogUri: "file:///tmp/events.jsonl"
      }
    });
  });

  it("passes --json and --context-file to zigma-flow invoke", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope(),
      all: jsonEnvelope(),
      exitCode: 0
    });

    await executor.start(defaultRequest());

    const lastCall = mockExeca.mock.lastCall;
    expect(lastCall).toBeDefined();
    const args = lastCall![1] as string[];
    expect(args).toContain("--json");
    expect(args).toContain("--context-file");
  });

  it("throws IntegrationError when stdout is not valid JSON", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: "not json at all",
      all: "not json at all",
      exitCode: 1
    });

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow --json output could not be parsed as JSON"
    );
  });

  it("throws IntegrationError when contractVersion is not 1", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({ contractVersion: 99 }),
      all: jsonEnvelope({ contractVersion: 99 }),
      exitCode: 0
    });

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow --json contract version mismatch: expected 1, got 99"
    );
  });

  it("throws IntegrationError when runId is missing", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({ runId: undefined }),
      all: jsonEnvelope({ runId: undefined }),
      exitCode: 0
    });

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow --json output missing required field: runId"
    );
  });

  it("throws IntegrationError when status is missing", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({ status: undefined }),
      all: jsonEnvelope({ status: undefined }),
      exitCode: 0
    });

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow --json output missing required field: status"
    );
  });

  it("throws IntegrationError when status is unknown", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({ status: "unknown_weird_status" }),
      all: jsonEnvelope({ status: "unknown_weird_status" }),
      exitCode: 0
    });

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow --json returned unknown status: unknown_weird_status"
    );
  });

  it("dry-run path is unaffected and does not parse output", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: "some dry-run output",
      all: "some dry-run output",
      exitCode: 0
    });

    const result = await executor.start(defaultRequest({ dryRun: true }));

    expect(result).toEqual({
      externalRunId: "dry-run",
      status: "completed",
      exitCode: 0,
      summary: "some dry-run output",
      metadata: { dryRun: true }
    });
  });

  it("sets status to failed when exit code is non-zero and status is not awaiting_human", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({ status: "completed", exitCode: 1 }),
      all: jsonEnvelope({ status: "completed", exitCode: 1 }),
      exitCode: 1
    });

    const result = await executor.start(defaultRequest());

    expect(result.status).toBe("failed");
  });

  it("preserves awaiting_human status even when exit code is non-zero", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({ status: "awaiting_human", exitCode: 0 }),
      all: jsonEnvelope({ status: "awaiting_human", exitCode: 0 }),
      exitCode: 1
    });

    const result = await executor.start(defaultRequest());

    expect(result.status).toBe("awaiting_human");
  });

  it("populates metadata fields from the JSON envelope", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: jsonEnvelope({
        pausedGate: { jobId: "job-1", stepId: "step-1" },
        artifacts: [{ name: "report.txt", uri: "file:///tmp/report.txt" }],
        eventLogUri: "file:///tmp/custom-events.jsonl"
      }),
      all: jsonEnvelope({
        pausedGate: { jobId: "job-1", stepId: "step-1" },
        artifacts: [{ name: "report.txt", uri: "file:///tmp/report.txt" }],
        eventLogUri: "file:///tmp/custom-events.jsonl"
      }),
      exitCode: 0
    });

    const result = await executor.start(defaultRequest());

    expect(result.metadata).toEqual({
      pausedGate: { jobId: "job-1", stepId: "step-1" },
      artifacts: [{ name: "report.txt", uri: "file:///tmp/report.txt" }],
      eventLogUri: "file:///tmp/custom-events.jsonl"
    });
  });
});

describe("buildContextFilePayload", () => {
  it("builds a structured payload from a FlowStartRequest", () => {
    const request = defaultRequest({
      permissionSnapshotId: "snap-1",
      integrityHash: "abc123def",
      coreCallbackUrl: "http://127.0.0.1:4736/v1"
    });

    const payload = buildContextFilePayload(request);

    expect(payload).toEqual({
      permissionSnapshotId: "snap-1",
      integrityHash: "abc123def",
      capabilities: ["task:create"],
      constraints: {
        allowedRepos: [],
        allowedBranches: [],
        maxRunDurationMs: null
      },
      source: { kind: "api", metadata: {} },
      coreCallbackUrl: "http://127.0.0.1:4736/v1",
      actor: { type: "user", id: "alice" },
      flowRunId: "fr-1",
      taskId: "task-1"
    });
  });

  it("defaults null for optional fields", () => {
    const request = defaultRequest();

    const payload = buildContextFilePayload(request);

    expect(payload.permissionSnapshotId).toBeNull();
    expect(payload.integrityHash).toBeNull();
    expect(payload.coreCallbackUrl).toBeUndefined();
  });
});
