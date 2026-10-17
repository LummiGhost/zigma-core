import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExeca = vi.fn();

vi.mock("execa", () => ({
  execa: mockExeca
}));

// Dynamic import so the mock is in place before the module loads
const { LocalCliFlowExecutor, buildContextFilePayload } = await import("../../src/adapters/local-cli-flow.js");

function contractInfo(overrides: Record<string, unknown> = {}) {
  return {
    stdout: JSON.stringify({
      contractVersion: 1,
      provider: "zigma-flow",
      packageVersion: "0.8.12",
      capabilities: ["caller-context-v1", "invoke-json-v1", "context-freeze-v1", "callback-envelope-v1", "callback-http-delivery-v1"],
      ...overrides
    }),
    exitCode: 0
  };
}

let executor: InstanceType<typeof LocalCliFlowExecutor>;

beforeEach(() => {
  mockExeca.mockReset();
  executor = new LocalCliFlowExecutor();
  mockExeca.mockResolvedValueOnce(contractInfo());
});

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

function commandEnvelope(command: "resume" | "abort", overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contractVersion: 1,
    command,
    status: "success",
    runId: "run-1",
    data: {},
    ...overrides
  });
}

function defaultRequest(overrides: Record<string, unknown> = {}) {
  return {
    command: "zigma-flow",
    projectId: "project-1",
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
    permissionSnapshotId: "snap-1",
    integrityHash: "sha256:abc123def",
    timeoutMs: 60_000,
    environment: {},
    dryRun: false,
    ...overrides
  };
}

describe("LocalCliFlowExecutor.start", () => {
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

  it("performs and caches a provider handshake before invoke", async () => {
    mockExeca.mockResolvedValueOnce({ stdout: jsonEnvelope(), exitCode: 0 });
    mockExeca.mockResolvedValueOnce({ stdout: jsonEnvelope({ runId: "run-second" }), exitCode: 0 });

    await executor.start(defaultRequest());
    await executor.start(defaultRequest({ flowRunId: "fr-2" }));

    expect(mockExeca).toHaveBeenCalledTimes(3);
    expect(mockExeca.mock.calls[0]?.[1]).toEqual(["contract-info", "--json"]);
    expect(mockExeca.mock.calls[1]?.[1]).toContain("invoke");
    expect(mockExeca.mock.calls[2]?.[1]).toContain("invoke");
  });

  it("fails closed on an unknown provider contract before invoke", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ contractVersion: 99 }));

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow contract version mismatch: expected 1, got 99"
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-object handshake before invoke", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce({ stdout: "null", exitCode: 0 });

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow contract-info must return an object"
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a required provider capability is absent", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ capabilities: ["invoke-json-v1"] }));

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow is missing required provider capabilities"
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("accepts a compatible provider release with a different diagnostic packageVersion", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ packageVersion: "0.8.13" }));
    mockExeca.mockResolvedValueOnce({ stdout: jsonEnvelope(), exitCode: 0 });

    await expect(executor.start(defaultRequest())).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects a missing diagnostic packageVersion", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ packageVersion: "" }));

    await expect(executor.start(defaultRequest())).rejects.toThrow(
      "zigma-flow contract-info packageVersion must be a non-empty string"
    );
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
      contractVersion: 1,
      actor: { type: "user", id: "alice" },
      capabilities: ["task:create"],
      constraints: {
        repositoryIds: [],
        workflowRefs: [],
        toolNames: [],
        branchPatterns: []
      },
      source: { kind: "api", metadata: {} },
      taskId: "task-1",
      flowRunId: "fr-1",
      projectId: "project-1",
      permissionSnapshotId: "snap-1",
      integrityHash: "abc123def",
      coreCallbackUrl: "http://127.0.0.1:4736/v1",
    });
  });

  it("omits optional correlation and callback fields", () => {
    const payload = buildContextFilePayload(defaultRequest());

    expect(payload.operationId).toBeUndefined();
    expect(payload.callbackCorrelationId).toBeUndefined();
    expect(payload.coreCallbackUrl).toBeUndefined();
  });

  it("rejects missing permission evidence instead of emitting null", () => {
    expect(() => buildContextFilePayload(defaultRequest({ permissionSnapshotId: "" })))
      .toThrow("requires permission snapshot evidence");
  });
});

describe("LocalCliFlowExecutor command contracts", () => {
  it("fails closed when the provider does not advertise inspect capability", async () => {
    await expect(executor.reconcile({
      operationId: "command-1",
      executionFence: { commandId: "command-1", leaseId: "lease-1", ownerId: "worker-1", fencingToken: 1 },
      externalRunId: "run-1",
      command: "zigma-flow",
      projectRoot: "/tmp/project",
      timeoutMs: 60_000,
      environment: {}
    })).resolves.toMatchObject({ outcome: "unsupported" });
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("negotiates run-inspect-v1 and accepts only correlated quiescent evidence", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({
      capabilities: ["caller-context-v1", "invoke-json-v1", "context-freeze-v1", "callback-envelope-v1", "callback-http-delivery-v1", "run-inspect-v1"]
    }));
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        contractVersion: 1,
        command: "inspect",
        status: "success",
        runId: "run-1",
        data: {
          reconciliation: {
            contractVersion: 1,
            externalRunId: "run-1",
            lifecycle: { status: "cancelled", terminal: true },
            invocation: { state: "quiescent", quiescent: true },
            callerContext: { state: "accepted", operationId: "command-1" }
          }
        }
      }),
      exitCode: 0
    });

    await expect(executor.reconcile({
      operationId: "command-1",
      executionFence: { commandId: "command-1", leaseId: "lease-1", ownerId: "worker-1", fencingToken: 1 },
      externalRunId: "run-1",
      command: "zigma-flow",
      projectRoot: "/tmp/project",
      timeoutMs: 60_000,
      environment: {}
    })).resolves.toMatchObject({
      outcome: "found",
      externalRunId: "run-1",
      status: "cancelled",
      quiescent: true
    });
    expect(mockExeca.mock.lastCall?.[1]).toEqual([
      "--cwd", "/tmp/project", "inspect", "--run", "run-1", "--json"
    ]);
  });

  it("uses the versioned resume JSON command for gate decisions", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: commandEnvelope("resume"),
      all: commandEnvelope("resume"),
      exitCode: 0
    });

    await executor.decideGate({
      command: "zigma-flow",
      externalRunId: "run-1",
      jobId: "job-1",
      decision: "approve",
      input: {},
      projectRoot: "/tmp/project",
      timeoutMs: 60_000,
      environment: {}
    });

    expect(mockExeca.mock.lastCall?.[1]).toEqual([
      "--cwd",
      "/tmp/project",
      "resume",
      "run-1",
      "--job",
      "job-1",
      "--input",
      "decision=approve",
      "--json"
    ]);
  });

  it("uses abort --run with a structured reason and JSON response", async () => {
    const response = commandEnvelope("abort", { data: { quiescent: true, ownerStatus: "cancelled" } });
    mockExeca.mockResolvedValueOnce({
      stdout: response,
      all: response,
      exitCode: 0
    });

    await expect(executor.cancel({
      command: "zigma-flow",
      externalRunId: "run-1",
      projectRoot: "/tmp/project",
      reason: "user-requested",
      timeoutMs: 60_000,
      environment: {}
    })).resolves.toMatchObject({ externalRunId: "run-1", status: "cancelled", quiescent: true });

    expect(mockExeca.mock.lastCall?.[1]).toEqual([
      "--cwd",
      "/tmp/project",
      "abort",
      "--run",
      "run-1",
      "--reason",
      "user-requested",
      "--json"
    ]);
  });

  it("rejects an unsupported abort command contract version", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: commandEnvelope("abort", { contractVersion: 2 }),
      all: commandEnvelope("abort", { contractVersion: 2 }),
      exitCode: 0
    });

    await expect(executor.cancel({
      command: "zigma-flow",
      externalRunId: "run-1",
      projectRoot: "/tmp/project",
      reason: "user-requested",
      timeoutMs: 60_000,
      environment: {}
    })).rejects.toThrow("zigma-flow abort contract version mismatch: expected 1, got 2");
  });
});


describe("Flow startup failures", () => {
  it("does not persist a sentinel as an external run ID", async () => {
    mockExeca.mockResolvedValueOnce({stdout:jsonEnvelope({runId:"(error)",status:"failed",error:{message:"Workflow validation failed"}}),exitCode:1});
    await expect(executor.start(defaultRequest())).rejects.toThrow("rejected invocation before creating a run: Workflow validation failed");
  });
});


it("preserves a cancelled Flow result with its nonzero CLI exit status", async () => {
  mockExeca.mockResolvedValueOnce({stdout:jsonEnvelope({status:"cancelled",exitCode:1}),exitCode:1});
  expect(await executor.start(defaultRequest())).toMatchObject({status:"cancelled",exitCode:1});
});
