import { afterEach, describe, expect, it } from "vitest";
import type { FlowExecutor, FlowStartRequest, FlowStartResult } from "../src/contracts/ports.js";
import { CoreService } from "../src/application/core-service.js";
import { SystemClock, UuidGenerator } from "../src/application/runtime.js";
import { buildServer } from "../src/api/server.js";
import { SqliteStore } from "../src/persistence/sqlite-store.js";

class CompletedFlow implements FlowExecutor {
  async preflight(): Promise<void> {}

  async start(_request: FlowStartRequest): Promise<FlowStartResult> {
    return { externalRunId: "run-api", status: "completed", exitCode: 0, metadata: {} };
  }
}

const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("HTTP API", () => {
  it("returns a normalized execution policy for legacy profile payloads", async () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const app = buildServer(new CoreService({
      store,
      flowExecutor: new CompletedFlow(),
      clock: new SystemClock(),
      ids: new UuidGenerator()
    }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution-profiles",
      payload: { name: "legacy-local" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.executionPolicy).toEqual({
      contractVersion: 1,
      capacity: {
        global: 4,
        perProject: 4,
        perRepository: 2,
        perBackend: 4
      },
      admission: {
        writablePerRepository: 1,
        queueDiscipline: "fifo",
        requireDistinctWorkspace: true
      }
    });
    await app.close();
  });

  it("exposes execution metrics for a completed flow run and 404s for unknown runs", async () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const app = buildServer(new CoreService({
      store,
      flowExecutor: new CompletedFlow(),
      clock: new SystemClock(),
      ids: new UuidGenerator()
    }));

    const profileResponse = await app.inject({
      method: "POST",
      url: "/v1/execution-profiles",
      payload: {
        name: "metrics-api",
        mode: "local-cli",
        flowCommand: "zigma-flow",
        workspaceCommand: "zigma-workspace",
        timeoutMs: 60_000,
        environment: {},
        metadata: {}
      }
    });
    const profileId = profileResponse.json().data.id as string;

    const projectResponse = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        key: "metrics-api",
        displayName: "Metrics API",
        repositories: [
          {
            id: "main",
            provider: "github",
            url: "https://github.com/LummiGhost/zigma-core.git",
            defaultRef: "main",
            writable: true,
            metadata: {}
          }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileId,
        workspacePolicy: {
          provider: "none",
          mode: "writable",
          branchTemplate: "zigma/{taskId}",
          cleanup: "manual",
          snapshotOnTerminal: true
        },
        metadata: {}
      }
    });
    const projectId = projectResponse.json().data.id as string;

    const taskResponse = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      payload: {
        projectId,
        title: "Metrics task",
        description: "Prove metrics through the API",
        priority: "normal",
        source: { kind: "api", metadata: {} },
        createdBy: { type: "user", id: "owner" },
        labels: [],
        metadata: {}
      }
    });
    const taskId = taskResponse.json().data.id as string;

    const startResponse = await app.inject({
      method: "POST",
      url: `/v1/tasks/${taskId}/start`,
      payload: {
        callerContext: {
          actor: { type: "user", id: "owner" },
          capabilities: ["task:start", "workflow:invoke", "workspace:create", "workspace:write", "gate:approve", "gate:reject"],
          constraints: {
            repositoryIds: ["main"],
            workflowRefs: ["code-change"],
            toolNames: ["git", "zigma-workspace"],
            branchPatterns: ["zigma/*"]
          },
          source: { kind: "api", metadata: {} }
        },
        inputs: { feature: "metrics" },
        dryRun: false
      }
    });
    expect(startResponse.statusCode).toBe(202);
    const runId = startResponse.json().data.activeFlowRun.id as string;

    const metricsResponse = await app.inject({
      method: "GET",
      url: `/v1/flow-runs/${runId}/metrics`
    });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.json().data.counters).toMatchObject({
      dispatched: 1,
      started: 1,
      completed: 1
    });
    expect(metricsResponse.json().data.durations["start_to_terminal"].count).toBe(1);

    const missingResponse = await app.inject({
      method: "GET",
      url: "/v1/flow-runs/run-missing/metrics"
    });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("returns structured validation errors", async () => {
    const store = new SqliteStore(":memory:");
    stores.push(store);
    const app = buildServer(new CoreService({
      store,
      flowExecutor: new CompletedFlow(),
      clock: new SystemClock(),
      ids: new UuidGenerator()
    }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution-profiles",
      payload: { name: "" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });
});
