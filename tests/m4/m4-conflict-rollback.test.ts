/**
 * M4 conflict + rollback — env-gated. An external commit lands in the Run
 * workspace while a job attempt is open; the job's integrate must surface a
 * typed merge conflict, fail the job with workspace_merge_conflict, keep the
 * Run intact (no merge residue), retain the failed attempt workspace, and
 * skip publishing.
 */

import { afterEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
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
  isTerminal,
  killCoreProcess,
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
  writeDieFiles
} from "./helpers.js";

const CONFLICT_WORKFLOW = `\
name: m4-conflict
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
        run: ${holdingStep("fs.writeFileSync('conflict.txt','from-job\\n');fs.writeFileSync('job-marker.txt','present');")}
`;

afterEach(async () => {
  await writeDieFiles();
  for (const { child } of spawnedCores.splice(0)) killCoreProcess(child);
  await Promise.all(tempRoots.splice(0).map((root) => rmWithRetry(root)));
}, 120_000);

describeRealPlatform("M4 conflict and rollback (real Core + Flow + Workspace CLIs)", () => {
  it("surfaces an external-commit merge conflict as a failed job with the Run intact and unpolluted", async () => {
    const repo = await makeManagedProject("conflict", CONFLICT_WORKFLOW, { registerDieFile: true });
    const dbPath = join(repo.root, "core.db");
    const port = await freePort();
    const core = await spawnCore({ dbPath, port, workers: 2 });
    try {
      const profileId = await createProfile(core.baseUrl, {
        name: "m4-conflict",
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
        key: "m4-conflict",
        displayName: "M4 Conflict",
        repositories: [
          { id: "main", provider: "github", url: "https://github.com/LummiGhost/m4-conflict.git", defaultRef: "main", writable: true, metadata: {} }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileId,
        workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot: repo.repository }
      });
      const taskId = await createTask(core.baseUrl, projectId, "m4-conflict");
      const started = await startTask(core.baseUrl, taskId, startPayload(repo.workflowPath, {
        idempotencyKey: "m4-conflict"
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
      const runRow = await waitFor("the run workspace row", () => findRunRow(repo.stateDir, externalRunId));

      // External commit into the Run workspace while the job attempt is open.
      git(runRow.path, "config", "user.email", "external@example.test");
      git(runRow.path, "config", "user.name", "External Committer");
      await writeFile(join(runRow.path, "conflict.txt"), "from-external\n", "utf8");
      git(runRow.path, "add", "conflict.txt");
      git(runRow.path, "commit", "-m", "external commit into the run workspace");

      // Release the job; finalize commits the attempt and integrate conflicts.
      await writeFile(join(jobRow.path, "release.txt"), "go", "utf8");

      const terminal = await pollTaskUntil(core.baseUrl, taskId, (candidate) => {
        const status = candidate.activeFlowRun?.status;
        if (status && isTerminal(status)) {
          if (status !== "failed") {
            throw new Error(`run reached ${status} instead of failed`);
          }
          return true;
        }
        return undefined;
      }, 300_000);
      expect(terminal.activeFlowRun!.status).toBe("failed");

      const metrics = await getRunMetrics(core.baseUrl, run.id);
      const flowRunDir = join(repo.repository, ".zigma-flow", "runs", externalRunId);
      const eventDump = await (async () => {
        try {
          return await readFile(join(flowRunDir, "events.jsonl"), "utf8");
        } catch {
          return "(no events.jsonl)";
        }
      })();
      const cursorDump = await (async () => {
        try {
          return await readFile(join(flowRunDir, "core-callback-delivery.json"), "utf8");
        } catch {
          return "(no delivery cursor)";
        }
      })();
      const conflictDump = [
        `task view: ${JSON.stringify(await getTaskView(core.baseUrl, taskId), null, 2)}`,
        `run log: ${await readRunLogTail(repo.repository, externalRunId)}`,
        `events.jsonl: ${eventDump}`,
        `delivery cursor: ${cursorDump}`,
        `core output: ${core.output.join("")}`
      ].join("\n");
      expect(metrics!.counters, conflictDump).toMatchObject({
        dispatched: 1,
        started: 1,
        failed: 1,
        completed: 0,
        workspace_conflicts: 1
      });

      // Run workspace intact: integrate rolled the target back, so the
      // external commit is the head and the job's change never landed.
      const runRowAfter = findRunRow(repo.stateDir, externalRunId)!;
      expect(runRowAfter.status).not.toBe("CLEANED");
      expect(existsSync(runRowAfter.path)).toBe(true);
      // Working-tree content comparison, not byte comparison: the checkout
      // may normalize line endings per the local git autocrlf setting.
      const conflictContent = (await readFile(join(runRowAfter.path, "conflict.txt"), "utf8"))
        .replace(/\r\n/g, "\n");
      expect(
        conflictContent,
        `conflict.txt bytes: ${JSON.stringify(conflictContent)} — ${conflictDump}`
      ).toBe("from-external\n");
      expect(git(runRowAfter.path, "log", "--oneline").split("\n").length).toBe(2);
      expect(git(runRowAfter.path, "log", "--oneline", "-1", "--format=%an")).toBe("External Committer");

      // Failed attempt workspace is retained; nothing was published.
      const jobRowAfter = findJobRow(repo.stateDir, externalRunId)!;
      expect(jobRowAfter.status).not.toBe("CLEANED");
      expect(existsSync(jobRowAfter.path)).toBe(true);
      expect(gitRefExists(repo.repository, `refs/heads/flow/${externalRunId}`)).toBe(false);
      expect(git(repo.repository, "rev-parse", "main")).toBe(repo.initialCommit);
    } finally {
      killCoreProcess(core.child);
    }
  }, 420_000);
});
