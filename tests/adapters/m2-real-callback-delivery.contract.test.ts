import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCliFlowExecutor } from "../../src/adapters/local-cli-flow.js";
import { CoreService } from "../../src/application/core-service.js";
import { SystemClock, UuidGenerator } from "../../src/application/runtime.js";
import { buildServer } from "../../src/api/server.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

const flowCliPath = process.env["ZIGMA_FLOW_CLI_PATH"];
const describeRealFlow = flowCliPath ? describe : describe.skip;
const tempRoots: string[] = [];
const stores: SqliteStore[] = [];
const previousCoreUrl = process.env["ZIGMA_CORE_URL"];

const WORKFLOW = `\
name: m2-real-callback
version: "0.1.0"
jobs:
  smoke:
    steps:
      - id: pass
        type: script
        run: node -e "process.exit(0)"
`;

afterEach(async () => {
  if (previousCoreUrl === undefined) delete process.env["ZIGMA_CORE_URL"];
  else process.env["ZIGMA_CORE_URL"] = previousCoreUrl;
  for (const store of stores.splice(0)) store.close();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeRealFlow("M2 real Flow callback delivery", () => {
  it("projects a complete ordered callback stream from a real Flow process into Core", async () => {
    await chmod(flowCliPath!, 0o755);
    const projectRoot = await mkdtemp(join(tmpdir(), "zigma-core-m2-callback-"));
    tempRoots.push(projectRoot);
    await mkdir(join(projectRoot, ".zigma-flow", "runs"), { recursive: true });
    await writeFile(join(projectRoot, ".zigma-flow", "config.json"), JSON.stringify({
      tool_version: "0.8.12", active_run: null, agent: { backend: "claude-code", backends: {} }
    }), "utf8");
    await writeFile(join(projectRoot, ".zigma-flow", "skill-lock.json"), JSON.stringify({ skills: {} }), "utf8");
    const workflowPath = join(projectRoot, "workflow.yml");
    await writeFile(workflowPath, WORKFLOW, "utf8");

    const store = new SqliteStore(":memory:");
    stores.push(store);
    const core = new CoreService({
      store,
      flowExecutor: new LocalCliFlowExecutor(),
      clock: new SystemClock(),
      ids: new UuidGenerator()
    });
    const app = buildServer(core);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("Core callback server did not bind TCP");
    process.env["ZIGMA_CORE_URL"] = `http://127.0.0.1:${address.port}/v1`;

    try {
      const profile = core.createExecutionProfile({
        name: "m2-real-flow", mode: "local-cli", flowCommand: flowCliPath!,
        workspaceCommand: "unused", timeoutMs: 60_000, environment: {}, metadata: {}
      });
      const project = core.createProject({
        key: "m2-callback", displayName: "M2 callback contract",
        repositories: [{ id: "main", provider: "generic-git", url: projectRoot, defaultRef: "main", writable: false, metadata: {} }],
        defaultRepositoryId: "main", defaultWorkflowRef: workflowPath, executionProfileId: profile.id,
        workspacePolicy: { provider: "none", mode: "read-only", branchTemplate: "main", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot }
      });
      const task = core.createTask({
        projectId: project.id, title: "Real callback", description: "Prove real callback delivery",
        priority: "high", source: { kind: "system", metadata: {} },
        createdBy: { type: "service", id: "contract-test" }, labels: ["m2"], metadata: {}
      });

      const result = await core.startTask(task.id, {
        callerContext: {
          actor: { type: "service", id: "contract-test" },
          capabilities: ["task:start", "workflow:invoke"],
          constraints: { repositoryIds: ["main"], workflowRefs: [workflowPath], toolNames: ["node"], branchPatterns: ["main"] },
          source: { kind: "system", metadata: {} }
        },
        branch: "main", inputs: {}, dryRun: false
      });

      expect(result.task.status).toBe("completed");
      expect(result.activeFlowRun).toMatchObject({ status: "completed", externalRunId: expect.any(String) });
      const authoritativeEvents = (await readFile(
        join(projectRoot, ".zigma-flow", "runs", result.activeFlowRun!.externalRunId!, "events.jsonl"),
        "utf8"
      )).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      expect(authoritativeEvents.at(-1)?.type).toBe("run_completed");
      expect(result.activeFlowRun!.lastCallbackSequence).toBe(authoritativeEvents.length);
    } finally {
      await app.close();
    }
  }, 60_000);
});
