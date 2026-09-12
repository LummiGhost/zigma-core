/**
 * M4 restart recovery — env-gated. Two crash windows against a file-backed
 * Core:
 *
 * A. Pre-dispatch kill: the serve process pauses at the
 *    "before-dispatch-marker" fault-injection phase (command claimed, lease
 *    active, provider boundary not yet durable) and the harness kills it
 *    there. On restart the command is reset for redispatch — dispatched
 *    exactly once, worker_kills attributed to the foreign lease takeover,
 *    zero reconcile restarts, one Flow run directory, normal publish +
 *    cleanup.
 *
 * B. Mid-holding kill: only Core dies; the Flow owner and its step survive.
 *    On restart the sweep adopts the foreign lease (worker_kills) and
 *    reconciles the still-live invocation until release; the surviving owner
 *    then finalizes, publishes, and tears down with retention success:retain,
 *    and the terminal reconstruction records reconcile_restarts and
 *    start_to_terminal on the restarted Core.
 */

import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createProfile,
  createProject,
  createTask,
  describeRealPlatform,
  findJobRow,
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
  listWorkspaces,
  makeManagedProject,
  pollTaskUntil,
  readRunLogTail,
  rmWithRetry,
  spawnCore,
  startPayload,
  startTask,
  tempRoots,
  spawnedCores,
  waitFor,
  workspaceCliPath,
  writeDieFiles,
  type ManagedRepo
} from "./helpers.js";

const RESTART_WORKFLOW = `\
name: m4-restart
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
      - id: change
        type: script
        run: node -e "require('node:fs').writeFileSync('change.txt','from-job');"
`;

const RESTART_HOLD_WORKFLOW = `\
name: m4-restart-hold
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
  publish:
    strategy: branch
  retention:
    success: retain
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

function profilePayload(name: string, flowCommand: string, repo: ManagedRepo, extraEnv: Record<string, string> = {}) {
  return {
    name,
    mode: "local-cli",
    flowCommand,
    workspaceCommand: workspaceCliPath!,
    timeoutMs: 300_000,
    environment: {
      ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath!,
      ZIGMA_WORKSPACE_STATE_DIR: repo.stateDir,
      DIE_FILE: repo.dieFile,
      ...extraEnv
    },
    metadata: {}
  };
}

function projectPayload(key: string, displayName: string, profileId: string, repo: ManagedRepo) {
  return {
    key,
    displayName,
    repositories: [
      { id: "main", provider: "github", url: `https://github.com/LummiGhost/${key}.git`, defaultRef: "main", writable: true, metadata: {} }
    ],
    defaultRepositoryId: "main",
    defaultWorkflowRef: "code-change",
    executionProfileId: profileId,
    workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
    metadata: { projectRoot: repo.repository }
  };
}

describeRealPlatform("M4 restart recovery (real Core + Flow + Workspace CLIs)", () => {
  it("A: redispaches exactly once after a pre-dispatch crash at the provider handshake", async () => {
    const repo = await makeManagedProject("restart-a", RESTART_WORKFLOW, { registerDieFile: true });
    const dbPath = join(repo.root, "core.db");
    const port = await freePort();
    const blockFile = join(repo.root, "crashpoint-block");
    const startedFile = join(repo.root, "crashpoint-started");
    await writeFile(blockFile, "block", "utf8");
    const core = await spawnCore({
      dbPath,
      port,
      workers: 2,
      extraEnv: {
        ZIGMA_CORE_CRASHPOINT_PHASE: "before-dispatch-marker",
        ZIGMA_CORE_CRASHPOINT_BLOCK_FILE: blockFile,
        ZIGMA_CORE_CRASHPOINT_STARTED_FILE: startedFile
      }
    });
    let revived: Awaited<ReturnType<typeof spawnCore>> | undefined;
    try {
      const profileId = await createProfile(core.baseUrl, profilePayload("m4-restart-a", flowCliPath!, repo));
      const projectId = await createProject(core.baseUrl, projectPayload("m4-restart-a", "M4 Restart A", profileId, repo));
      const taskId = await createTask(core.baseUrl, projectId, "m4-restart-a");
      const started = await startTask(core.baseUrl, taskId, startPayload(repo.workflowPath, {
        idempotencyKey: "m4-restart-a"
      }));
      const run = started.activeFlowRun!;

      // The dispatch pauses between admission (lease active) and the durable
      // dispatch marker: the command is claimed but the provider boundary is
      // not yet committed, so a crash here must reset for redispatch.
      await waitFor("the dispatch to pause at the crashpoint", () =>
        existsSync(startedFile) ? true : undefined
      );
      killCoreProcess(core.child);
      await rm(blockFile, { force: true });

      revived = await spawnCore({ dbPath, port, workers: 2 });
      const terminal = await pollTaskUntil(revived.baseUrl, taskId, (candidate) => {
        const status = candidate.activeFlowRun?.status;
        if (status === "failed" || status === "cancelled") {
          throw new Error(`redispatch reached ${status} instead of completed`);
        }
        return status === "completed" ? true : undefined;
      }, 300_000);
      const externalRunId = terminal.activeFlowRun!.externalRunId!;

      const metrics = await getRunMetrics(revived.baseUrl, run.id);
      expect(metrics!.counters).toMatchObject({
        dispatched: 1,
        started: 1,
        completed: 1,
        failed: 0,
        reconcile_restarts: 0,
        worker_kills: 1,
        workspace_conflicts: 0
      });

      // The terminal callback reaches Core before Flow's publish and teardown
      // finish. Wait for the run workspace cleanup, then assert publish
      // evidence.
      await waitFor("run workspace cleanup after redispatch", () => {
        const row = findRunRow(repo.stateDir, externalRunId);
        return row && row.status === "CLEANED" ? row : undefined;
      }, 120_000);

      expect(flowRunIds(repo.repository).length).toBe(1);
      const dumpA = [
        `externalRunId: ${externalRunId}`,
        `flow run ids: ${flowRunIds(repo.repository).join(",")}`,
        `branches: ${git(repo.repository, "branch", "-a")}`,
        `run log: ${await readRunLogTail(repo.repository, externalRunId)}`,
        `revived core output: ${revived!.output.join("")}`,
        `run row: ${JSON.stringify(findRunRow(repo.stateDir, externalRunId) ?? null)}`,
        `all rows: ${JSON.stringify(listWorkspaces(repo.stateDir), null, 2)}`
      ].join("\n");
      expect(gitRefExists(repo.repository, `refs/heads/flow/${externalRunId}`), dumpA).toBe(true);
      expect(git(repo.repository, "rev-parse", "main"), dumpA).toBe(repo.initialCommit);

      const runRowAfter = findRunRow(repo.stateDir, externalRunId)!;
      expect(runRowAfter.status).toBe("CLEANED");
      expect(existsSync(runRowAfter.path)).toBe(false);
      const jobRowAfter = findJobRow(repo.stateDir, externalRunId)!;
      expect(jobRowAfter.status).toBe("CLEANED");
      expect(existsSync(jobRowAfter.path)).toBe(false);
    } finally {
      killCoreProcess(core.child);
      if (revived) killCoreProcess(revived.child);
    }
  }, 420_000);

  it("B: reconciles a surviving Flow owner to terminal and honors retention success:retain", async () => {
    const repo = await makeManagedProject("restart-b", RESTART_HOLD_WORKFLOW, { registerDieFile: true });
    const dbPath = join(repo.root, "core.db");
    const port = await freePort();
    const core = await spawnCore({ dbPath, port, workers: 2 });
    let revived: Awaited<ReturnType<typeof spawnCore>> | undefined;
    try {
      const profileId = await createProfile(core.baseUrl, profilePayload("m4-restart-b", flowCliPath!, repo));
      const projectId = await createProject(core.baseUrl, projectPayload("m4-restart-b", "M4 Restart B", profileId, repo));
      const taskId = await createTask(core.baseUrl, projectId, "m4-restart-b");
      const started = await startTask(core.baseUrl, taskId, startPayload(repo.workflowPath, {
        idempotencyKey: "m4-restart-b"
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

      // Kill only Core; the Flow owner and its step survive, still holding.
      killCoreProcess(core.child);
      revived = await spawnCore({ dbPath, port, workers: 2 });

      // The sweep adopts the foreign lease (worker_kills) and reconciles the
      // still-live invocation: interim reconciling, run not terminal. The
      // task itself stays running — no dispatch failure occurred, the owner
      // is merely mid-flight.
      await pollTaskUntil(revived.baseUrl, taskId, (candidate) =>
        candidate.executionCommand?.status === "reconciling" ? true : undefined
      );
      const interim = await getTaskView(revived.baseUrl, taskId);
      expect(interim.task.status).toBe("running");
      expect(interim.activeFlowRun?.status).toBe("running");

      // Release the surviving Flow owner; it finalizes, publishes, and tears
      // the run down with retention success:retain. The sweep's terminal
      // inspection then reconstructs completion on the restarted Core.
      await writeFile(join(jobRow.path, "release.txt"), "go", "utf8");
      try {
        await waitFor("terminal reconstruction on the restarted Core", async () => {
          const current = await getTaskView(revived!.baseUrl, taskId);
          if (current.activeFlowRun?.status === "failed" || current.activeFlowRun?.status === "cancelled") {
            throw new Error(`run reached ${current.activeFlowRun!.status} instead of completed`);
          }
          const metrics = await getRunMetrics(revived!.baseUrl, run.id);
          return current.activeFlowRun?.status === "completed" && metrics?.counters["reconcile_restarts"] === 1
            ? true
            : undefined;
        }, 300_000);
      } catch (error) {
        const lastView = await getTaskView(revived!.baseUrl, taskId).catch(() => undefined);
        const dumpB = [
          `last task view: ${JSON.stringify(lastView ?? null, null, 2)}`,
          `flow run ids: ${flowRunIds(repo.repository).join(",")}`,
          `run log: ${await readRunLogTail(repo.repository, externalRunId).catch(() => "unavailable")}`,
          `branches: ${git(repo.repository, "branch", "-a")}`,
          `run row: ${JSON.stringify(findRunRow(repo.stateDir, externalRunId) ?? null)}`,
          `job row: ${JSON.stringify(findJobRow(repo.stateDir, externalRunId) ?? null)}`,
          `all rows: ${JSON.stringify(listWorkspaces(repo.stateDir), null, 2)}`,
          `revived core output: ${revived!.output.join("")}`
        ].join("\n");
        throw new Error(`${dumpB}\n${error instanceof Error ? error.message : String(error)}`);
      }

      const metrics = await getRunMetrics(revived.baseUrl, run.id);
      expect(metrics!.counters).toMatchObject({
        completed: 1,
        failed: 0,
        reconcile_restarts: 1,
        worker_kills: 1,
        workspace_conflicts: 0
      });
      expect(metrics!.durations["start_to_terminal"]?.count).toBe(1);

      // Per-result retention: success:retain keeps the run workspace with the
      // job's integrated change; the completed attempt workspace is cleaned.
      const runRowAfter = findRunRow(repo.stateDir, externalRunId)!;
      expect(runRowAfter.status).not.toBe("CLEANED");
      expect(existsSync(runRowAfter.path)).toBe(true);
      // Content comparison, not byte comparison: the checkout may normalize
      // line endings per the local git autocrlf setting.
      expect(
        (await readFile(join(runRowAfter.path, "change.txt"), "utf8")).replace(/\r\n/g, "\n")
      ).toBe("from-job\n");
      expect(git(runRowAfter.path, "log", "--oneline", "--", "change.txt").split("\n").filter(Boolean).length).toBe(1);
      const jobRowAfter = findJobRow(repo.stateDir, externalRunId)!;
      expect(jobRowAfter.status).toBe("CLEANED");
      expect(existsSync(jobRowAfter.path)).toBe(false);

      expect(gitRefExists(repo.repository, `refs/heads/flow/${externalRunId}`)).toBe(true);
      expect(git(repo.repository, "rev-parse", "main")).toBe(repo.initialCommit);
    } finally {
      killCoreProcess(core.child);
      if (revived) killCoreProcess(revived.child);
    }
  }, 420_000);
});
