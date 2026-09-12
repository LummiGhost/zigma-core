/**
 * M4 worker kill — env-gated. The Flow owner is killed mid-job; Core must
 * fail safe: the command parks in reconciling (the sweep keeps inspecting a
 * run whose owner is gone and never terminal), the run never redispaches,
 * both workspaces stay intact, and nothing is published or committed.
 */

import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createProfile,
  createProject,
  createTask,
  describeRealPlatform,
  findJobRow,
  findPidByCommandLine,
  findRunRow,
  flowCliPath,
  flowRunIds,
  freePort,
  getRunMetrics,
  getTaskView,
  git,
  gitRefExists,
  holdingStep,
  killCoreProcess,
  killProcessTree,
  makeManagedProject,
  pollTaskUntil,
  rmWithRetry,
  spawnCore,
  startPayload,
  startTask,
  tempRoots,
  spawnedCores,
  waitFor,
  workspaceCliPath,
  writeDieFiles
} from "./helpers.js";

const WORKER_KILL_WORKFLOW = `\
name: m4-worker-kill
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
  publish:
    strategy: branch
jobs:
  worker:
    steps:
      - id: change-and-hold
        type: script
        run: ${holdingStep("fs.writeFileSync('change.txt','from-job\\n');fs.writeFileSync('job-marker.txt','present');")}
`;

afterEach(async () => {
  await writeDieFiles();
  for (const { child } of spawnedCores.splice(0)) killCoreProcess(child);
  await Promise.all(tempRoots.splice(0).map((root) => rmWithRetry(root)));
}, 120_000);

describeRealPlatform("M4 worker kill (real Core + Flow + Workspace CLIs)", () => {
  it("parks the run in reconciling without redispatch after the Flow worker is killed", async () => {
    const repo = await makeManagedProject("worker-kill", WORKER_KILL_WORKFLOW, { registerDieFile: true });
    const dbPath = join(repo.root, "core.db");
    const port = await freePort();
    const core = await spawnCore({ dbPath, port, workers: 2 });
    try {
      const profileId = await createProfile(core.baseUrl, {
        name: "m4-worker-kill",
        mode: "local-cli",
        flowCommand: flowCliPath!,
        workspaceCommand: workspaceCliPath!,
        timeoutMs: 300_000,
        environment: {
          ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath!,
          ZIGMA_WORKSPACE_STATE_DIR: repo.stateDir,
          DIE_FILE: repo.dieFile
        },
        metadata: {}
      });
      const projectId = await createProject(core.baseUrl, {
        key: "m4-worker-kill",
        displayName: "M4 Worker Kill",
        repositories: [
          { id: "main", provider: "github", url: "https://github.com/LummiGhost/m4-worker-kill.git", defaultRef: "main", writable: true, metadata: {} }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileId,
        workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot: repo.repository }
      });
      const taskId = await createTask(core.baseUrl, projectId, "m4-worker-kill");
      const started = await startTask(core.baseUrl, taskId, startPayload(repo.workflowPath, {
        idempotencyKey: "m4-worker-kill"
      }));
      const run = started.activeFlowRun!;

      const view = await pollTaskUntil(core.baseUrl, taskId, (candidate) =>
        candidate.activeFlowRun?.externalRunId ? true : undefined
      );
      const externalRunId = view.activeFlowRun!.externalRunId!;
      await waitFor("the job attempt workspace row", () => {
        const row = findJobRow(repo.stateDir, externalRunId);
        return row && existsSync(join(row.path, "job-marker.txt")) ? row : undefined;
      });

      // The invoke argv carries the absolute workflow ref; kill the Flow
      // owner and its step children mid-holding.
      const workerPid = findPidByCommandLine(repo.workflowPath);
      expect(workerPid).toBeDefined();
      killProcessTree(workerPid!);

      await pollTaskUntil(core.baseUrl, taskId, (candidate) =>
        candidate.executionCommand?.status === "reconciling" ? true : undefined
      );
      const parked = await getTaskView(core.baseUrl, taskId);
      expect(parked.task.status).toBe("blocked");
      expect(parked.activeFlowRun?.status).toBe("running");

      const metrics = await getRunMetrics(core.baseUrl, run.id);
      expect(metrics!.counters).toMatchObject({ dispatched: 1, started: 1 });
      expect(metrics!.counters["completed"] ?? 0).toBe(0);
      expect(metrics!.counters["failed"] ?? 0).toBe(0);
      expect(metrics!.counters["cancelled"] ?? 0).toBe(0);

      // Fail-safe state: one Flow run directory, both workspaces intact with
      // their markers, nothing published, repository untouched.
      expect(flowRunIds(repo.repository).length).toBe(1);
      const runRowAfter = findRunRow(repo.stateDir, externalRunId)!;
      expect(runRowAfter.status).not.toBe("CLEANED");
      expect(existsSync(runRowAfter.path)).toBe(true);
      const jobRowAfter = findJobRow(repo.stateDir, externalRunId)!;
      expect(jobRowAfter.status).not.toBe("CLEANED");
      expect(existsSync(jobRowAfter.path)).toBe(true);
      expect(existsSync(join(jobRowAfter.path, "job-marker.txt"))).toBe(true);
      expect(gitRefExists(repo.repository, `refs/heads/flow/${externalRunId}`)).toBe(false);
      expect(git(repo.repository, "rev-parse", "main")).toBe(repo.initialCommit);
    } finally {
      killCoreProcess(core.child);
    }
  }, 420_000);
});
