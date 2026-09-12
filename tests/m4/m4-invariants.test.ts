/**
 * M4 invariants — env-gated. Three tasks against one repository through one
 * Core: A holds the single-writable slot while B and C are due. The busy
 * runtime cannot poll while a worker awaits A's live invoke, so when the slot
 * opens exactly one admission denial happens — the race loser — and the
 * winner starves further polls until it completes. Asserts the single-writable
 * admission invariant (exactly one denial), step cwd equal to the managed job
 * workspace path, the frozen caller-context capability list, registry/store
 * consistency, and per-run completion with publish + cleanup.
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
  flowCliPath,
  freePort,
  getRunMetrics,
  git,
  gitRefExists,
  holdingStep,
  killCoreProcess,
  listWorkspaces,
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
  writeDieFiles,
  type WorkspaceRow
} from "./helpers.js";

const EXPECTED_CAPABILITIES = [
  "gate:approve",
  "gate:reject",
  "task:start",
  "workflow:invoke",
  "workspace:create",
  "workspace:write"
];

const HOLDING_A = `\
name: m4-invariants-a
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
        run: ${holdingStep("fs.writeFileSync('cwd.txt',process.cwd());fs.writeFileSync('a-marker.txt','present');")}
`;

const HOLDING_BC = `\
name: m4-invariants-bc
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
        run: ${holdingStep("fs.writeFileSync('cwd.txt',process.cwd());fs.writeFileSync('bc-marker.txt','present');")}
`;

afterEach(async () => {
  await writeDieFiles();
  for (const { child } of spawnedCores.splice(0)) killCoreProcess(child);
  await Promise.all(tempRoots.splice(0).map((root) => rmWithRetry(root)));
}, 120_000);

async function assertCwd(jobRow: WorkspaceRow): Promise<void> {
  const cwd = (await readFile(join(jobRow.path, "cwd.txt"), "utf8")).trim();
  const normalize = (path: string): string => (process.platform === "win32" ? path.toLowerCase() : path);
  expect(normalize(cwd)).toBe(normalize(jobRow.path));
}

describeRealPlatform("M4 invariants (real Core + Flow + Workspace CLIs)", () => {
  it("serializes three tasks on the single-writable slot with exactly one admission denial", async () => {
    const repo = await makeManagedProject("invariants", HOLDING_A, { registerDieFile: true });
    await writeFile(join(repo.repository, "workflow-a.yml"), HOLDING_A, "utf8");
    await writeFile(join(repo.repository, "workflow-bc.yml"), HOLDING_BC, "utf8");
    const workflowA = join(repo.repository, "workflow-a.yml");
    const workflowBC = join(repo.repository, "workflow-bc.yml");
    const dbPath = join(repo.root, "core.db");
    const port = await freePort();
    const core = await spawnCore({ dbPath, port, workers: 2 });
    try {
      const profileId = await createProfile(core.baseUrl, {
        name: "m4-invariants",
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
        key: "m4-invariants",
        displayName: "M4 Invariants",
        repositories: [
          { id: "main", provider: "github", url: "https://github.com/LummiGhost/m4-invariants.git", defaultRef: "main", writable: true, metadata: {} }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileId,
        workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot: repo.repository }
      });

      // A dispatches and holds the single-writable slot.
      const taskA = await createTask(core.baseUrl, projectId, "m4-invariants-a");
      const startedA = await startTask(core.baseUrl, taskA, startPayload(workflowA, { idempotencyKey: "m4-inv-a" }));
      const runA = startedA.activeFlowRun!;
      const viewA = await pollTaskUntil(core.baseUrl, taskA, (candidate) =>
        candidate.activeFlowRun?.externalRunId ? true : undefined
      );
      const runIdA = viewA.activeFlowRun!.externalRunId!;
      const jobRowA = await waitFor("A's job attempt workspace", () => {
        const row = findJobRow(repo.stateDir, runIdA);
        return row && existsSync(join(row.path, "a-marker.txt")) ? row : undefined;
      });
      await assertCwd(jobRowA);

      // B and C are created while A holds; the busy runtime cannot poll them.
      const taskB = await createTask(core.baseUrl, projectId, "m4-invariants-b");
      const taskC = await createTask(core.baseUrl, projectId, "m4-invariants-c");
      const startedB = await startTask(core.baseUrl, taskB, startPayload(workflowBC, { idempotencyKey: "m4-inv-b" }));
      const startedC = await startTask(core.baseUrl, taskC, startPayload(workflowBC, { idempotencyKey: "m4-inv-c" }));
      const runB = startedB.activeFlowRun!;
      const runC = startedC.activeFlowRun!;

      const metricsB0 = await getRunMetrics(core.baseUrl, runB.id);
      const metricsC0 = await getRunMetrics(core.baseUrl, runC.id);
      expect(metricsB0?.counters["started"] ?? 0).toBe(0);
      expect(metricsC0?.counters["started"] ?? 0).toBe(0);
      expect(metricsB0?.counters["admission_denied"] ?? 0).toBe(0);
      expect(metricsC0?.counters["admission_denied"] ?? 0).toBe(0);

      // Open the slot. The first poll after A completes admits exactly one of
      // B/C (single-writable) and denies the other once; the admitted sibling
      // holds until released, starving further polls.
      await writeFile(join(jobRowA.path, "release.txt"), "go", "utf8");
      await pollTaskUntil(core.baseUrl, taskA, (candidate) =>
        candidate.activeFlowRun?.status === "completed" ? true : undefined
      );

      const race = await waitFor("one sibling to win the writable slot", async () => {
        const mB = await getRunMetrics(core.baseUrl, runB.id);
        const mC = await getRunMetrics(core.baseUrl, runC.id);
        const bStarted = mB?.counters["started"] ?? 0;
        const cStarted = mC?.counters["started"] ?? 0;
        const bDenied = mB?.counters["admission_denied"] ?? 0;
        const cDenied = mC?.counters["admission_denied"] ?? 0;
        if (bStarted === 1 && cStarted === 0 && cDenied === 1) {
          return { winnerTask: taskB, winnerRun: runB, loserTask: taskC, loserRun: runC };
        }
        if (cStarted === 1 && bStarted === 0 && bDenied === 1) {
          return { winnerTask: taskC, winnerRun: runC, loserTask: taskB, loserRun: runB };
        }
        return undefined;
      }, 120_000);

      // The winner holds; prove its step cwd is the managed job workspace,
      // then release it so the loser can finally be admitted.
      const winnerView = await pollTaskUntil(core.baseUrl, race.winnerTask, (candidate) =>
        candidate.activeFlowRun?.externalRunId ? true : undefined
      );
      const winnerRunId = winnerView.activeFlowRun!.externalRunId!;
      const winnerJobRow = await waitFor("the winner's job attempt workspace", () => {
        const row = findJobRow(repo.stateDir, winnerRunId);
        return row && existsSync(join(row.path, "bc-marker.txt")) ? row : undefined;
      });
      await assertCwd(winnerJobRow);
      await writeFile(join(winnerJobRow.path, "release.txt"), "go", "utf8");
      await pollTaskUntil(core.baseUrl, race.winnerTask, (candidate) =>
        candidate.activeFlowRun?.status === "completed" ? true : undefined
      );

      const loserView = await pollTaskUntil(core.baseUrl, race.loserTask, (candidate) =>
        candidate.activeFlowRun?.externalRunId ? true : undefined
      );
      const loserRunId = loserView.activeFlowRun!.externalRunId!;
      const loserJobRow = await waitFor("the loser's job attempt workspace", () => {
        const row = findJobRow(repo.stateDir, loserRunId);
        return row && existsSync(join(row.path, "bc-marker.txt")) ? row : undefined;
      });
      await assertCwd(loserJobRow);
      await writeFile(join(loserJobRow.path, "release.txt"), "go", "utf8");
      await pollTaskUntil(core.baseUrl, race.loserTask, (candidate) =>
        candidate.activeFlowRun?.status === "completed" ? true : undefined
      );

      // Per-run completion metrics; exactly one admission denial in total.
      let denials = 0;
      for (const run of [runA, runB, runC]) {
        const metrics = await getRunMetrics(core.baseUrl, run.id);
        expect(metrics!.counters).toMatchObject({
          dispatched: 1,
          started: 1,
          completed: 1,
          failed: 0,
          workspace_conflicts: 0
        });
        denials += metrics!.counters["admission_denied"] ?? 0;
      }
      expect(denials).toBe(1);

      // Registry/store consistency: one run row + one job row per external
      // run id; all cleaned by the success retention default. Cleanup runs in
      // the flow process after the terminal event, so poll until rows settle.
      const runIds = [runIdA, winnerRunId, loserRunId];
      const settledRows = await waitFor("workspace registry rows to reach CLEANED", () => {
        const rows = listWorkspaces(repo.stateDir);
        if (rows.length !== 6) return undefined;
        for (const runId of runIds) {
          const runRows = rows.filter((row) => row.flow_run_id === runId && row.job_id === null);
          const jobRows = rows.filter((row) => row.flow_run_id === runId && row.job_id !== null);
          if (runRows.length !== 1 || jobRows.length !== 1) return undefined;
          if (runRows[0]!.status !== "CLEANED" || jobRows[0]!.status !== "CLEANED") return undefined;
          if (existsSync(runRows[0]!.path) || existsSync(jobRows[0]!.path)) return undefined;
        }
        return rows;
      }, 120_000);
      if (settledRows === undefined) {
        throw new Error(
          [
            "Workspace registry did not settle to CLEANED",
            `all rows: ${JSON.stringify(listWorkspaces(repo.stateDir), null, 2)}`,
            `core output: ${core.output.join("")}`
          ].join("\n"),
        );
      }

      // Frozen caller context: exactly the capabilities the harness passed at
      // start — no forked additions or omissions.
      for (const runId of runIds) {
        const snapshotPath = join(repo.repository, ".zigma-flow", "runs", runId, "caller-context.json");
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
          callerContext?: { capabilities?: string[] };
        };
        expect([...(snapshot.callerContext?.capabilities ?? [])].sort()).toEqual(EXPECTED_CAPABILITIES);
      }

      // All three runs published their branch; the default branch is untouched.
      for (const runId of runIds) {
        expect(gitRefExists(repo.repository, `refs/heads/flow/${runId}`)).toBe(true);
      }
      expect(git(repo.repository, "rev-parse", "main")).toBe(repo.initialCommit);
    } finally {
      killCoreProcess(core.child);
    }
  }, 600_000);
});
