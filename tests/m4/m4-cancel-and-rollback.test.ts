/**
 * M4 cancel and rollback — env-gated. A task is cancelled through the Core
 * API while its job attempt holds; Core delivers abort to the live Flow
 * owner, which acknowledges quiescence, tears the run down with per-result
 * retention (failure: cleanup), and leaves the repository untouched.
 */

import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cancelTask,
  createProfile,
  createProject,
  createTask,
  describeRealPlatform,
  findJobRow,
  findRunRow,
  flowCliPath,
  freePort,
  getRunMetrics,
  getTaskView,
  git,
  gitRefExists,
  holdingStep,
  killCoreProcess,
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

const CANCEL_WORKFLOW = `\
name: m4-cancel
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
  publish:
    strategy: branch
  retention:
    failure: cleanup
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

describeRealPlatform("M4 cancel and rollback (real Core + Flow + Workspace CLIs)", () => {
  it("cancels a holding task, proves abort quiescence, strictly cleans the run workspace, and leaves the repository untouched", async () => {
    const repo = await makeManagedProject("cancel", CANCEL_WORKFLOW, { registerDieFile: true });
    const dbPath = join(repo.root, "core.db");
    const port = await freePort();
    const core = await spawnCore({ dbPath, port, workers: 2 });
    try {
      const profileId = await createProfile(core.baseUrl, {
        name: "m4-cancel",
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
        key: "m4-cancel",
        displayName: "M4 Cancel",
        repositories: [
          { id: "main", provider: "github", url: "https://github.com/LummiGhost/m4-cancel.git", defaultRef: "main", writable: true, metadata: {} }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileId,
        workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot: repo.repository }
      });
      const taskId = await createTask(core.baseUrl, projectId, "m4-cancel");
      const started = await startTask(core.baseUrl, taskId, startPayload(repo.workflowPath, {
        idempotencyKey: "m4-cancel"
      }));
      const run = started.activeFlowRun!;

      const view = await pollTaskUntil(core.baseUrl, taskId, (candidate) =>
        candidate.activeFlowRun?.externalRunId ? true : undefined
      );
      const externalRunId = view.activeFlowRun!.externalRunId!;
      const jobRow = await waitFor("the job attempt workspace row", () => {
        const row = findJobRow(repo.stateDir, externalRunId);
        return row && existsSync(join(row.path, "job-marker.txt")) ? row : undefined;
      });

      // Core alone must deliver cancellation while its invoke call is live.
      // A direct Flow abort here would hide cancellation delivery defects.
      await cancelTask(core.baseUrl, taskId, "m4 cancel rollback");

      const terminal = await pollTaskUntil(core.baseUrl, taskId, (candidate) => {
        const status = candidate.activeFlowRun?.status;
        if (status === "completed" || status === "failed") {
          throw new Error(`run reached ${status} instead of cancelled`);
        }
        return status === "cancelled" && candidate.executionCommand?.status === "cancelled" ? true : undefined;
      }, 60_000);
      expect(terminal.task.status).toBe("cancelled");
      expect((await getTaskView(core.baseUrl, taskId)).executionCommand?.status).toBe("cancelled");

      const metrics = await getRunMetrics(core.baseUrl, run.id);
      expect(metrics!.counters).toMatchObject({
        dispatched: 1,
        started: 1,
        completed: 0,
        failed: 0,
        cancelled: 1,
        reconcile_restarts: 0,
        worker_kills: 0
      });

      // Per-result retention: the cancelled run workspace is strictly cleaned,
      // the never-completed attempt workspace is retained. Cleanup runs in the
      // live owner after its quiescence acknowledgement, so poll until settled.
      const runRowAfter = await waitFor("run workspace cleanup after cancel", () => {
        const row = findRunRow(repo.stateDir, externalRunId);
        return row && row.status === "CLEANED" ? row : undefined;
      }, 60_000);
      expect(runRowAfter.path).toBeDefined();
      expect(existsSync(runRowAfter.path)).toBe(false);
      const jobRowAfter = findJobRow(repo.stateDir, externalRunId)!;
      expect(jobRowAfter.status).not.toBe("CLEANED");
      expect(existsSync(jobRowAfter.path)).toBe(true);

      // Rollback: nothing was committed to the repository and nothing was
      // published.
      expect(gitRefExists(repo.repository, `refs/heads/flow/${externalRunId}`)).toBe(false);
      expect(git(repo.repository, "rev-parse", "main")).toBe(repo.initialCommit);
    } finally {
      killCoreProcess(core.child);
    }
  }, 420_000);
});
