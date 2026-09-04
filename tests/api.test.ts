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
