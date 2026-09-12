/**
 * M4 managed parallel dispatch — env-gated on ZIGMA_FLOW_CLI_PATH +
 * ZIGMA_WORKSPACE_CLI_PATH + ZIGMA_CORE_CLI_PATH.
 *
 * Runs many tasks across two repositories through one `core serve` process
 * with real worker concurrency, and asserts the full managed lifecycle per
 * run: job commit + integrate, branch publish, per-result cleanup, and
 * persisted execution metrics within latency bounds.
 */

import { afterEach, expect, it } from "vitest";
import { join } from "node:path";
import {
  assertCleanup,
  createProfile,
  createProject,
  createTask,
  describeRealPlatform,
  flowCliPath,
  freePort,
  getRunMetrics,
  git,
  gitRefExists,
  isTerminal,
  killCoreProcess,
  makeManagedProject,
  pollTaskUntil,
  rmWithRetry,
  spawnCore,
  startPayload,
  startTask,
  tempRoots,
  spawnedCores,
  workspaceCliPath,
  writeDieFiles,
  type ManagedRepo
} from "./helpers.js";

const TASKS_PER_PROJECT = 8;

const PARALLEL_WORKFLOW = `\
name: m4-parallel
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
        run: node -e "require('node:fs').writeFileSync('change.txt','m4-parallel');setTimeout(()=>{},100)"
`;

afterEach(async () => {
  await writeDieFiles();
  for (const { child } of spawnedCores.splice(0)) killCoreProcess(child);
  await Promise.all(tempRoots.splice(0).map((root) => rmWithRetry(root)));
}, 120_000);

describeRealPlatform("M4 managed parallel dispatch (real Core + Flow + Workspace CLIs)", () => {
  it("completes many tasks across two repositories with publish and cleanup proven per run", async () => {
    const repoA = await makeManagedProject("parallel-a", PARALLEL_WORKFLOW);
    const repoB = await makeManagedProject("parallel-b", PARALLEL_WORKFLOW);
    const repos: ManagedRepo[] = [repoA, repoB];

    const dbPath = join(repoA.root, "core.db");
    const port = await freePort();
    const core = await spawnCore({ dbPath, port, workers: 4 });
    try {
      const profilePayload = (name: string, stateDir: string) => ({
        name,
        mode: "local-cli",
        flowCommand: flowCliPath!,
        workspaceCommand: workspaceCliPath!,
        timeoutMs: 300_000,
        environment: {
          ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath!,
          ZIGMA_WORKSPACE_STATE_DIR: stateDir
        },
        metadata: {}
      });
      const profileA = await createProfile(core.baseUrl, profilePayload("m4-parallel-a", repoA.stateDir));
      const profileB = await createProfile(core.baseUrl, profilePayload("m4-parallel-b", repoB.stateDir));

      const projectA = await createProject(core.baseUrl, {
        key: "m4-parallel-a",
        displayName: "M4 Parallel A",
        repositories: [
          { id: "main", provider: "github", url: "https://github.com/LummiGhost/m4-parallel-a.git", defaultRef: "main", writable: true, metadata: {} }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileA,
        workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot: repoA.repository }
      });
      const projectB = await createProject(core.baseUrl, {
        key: "m4-parallel-b",
        displayName: "M4 Parallel B",
        repositories: [
          { id: "main", provider: "github", url: "https://github.com/LummiGhost/m4-parallel-b.git", defaultRef: "main", writable: true, metadata: {} }
        ],
        defaultRepositoryId: "main",
        defaultWorkflowRef: "code-change",
        executionProfileId: profileB,
        workspacePolicy: { provider: "none", mode: "writable", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
        metadata: { projectRoot: repoB.repository }
      });

      const projects: Array<{ id: string; repo: ManagedRepo }> = [
        { id: projectA, repo: repoA },
        { id: projectB, repo: repoB }
      ];

      const startedAt = Date.now();
      const launches: Array<{ taskId: string; repo: ManagedRepo }> = [];
      let index = 0;
      for (const { id, repo } of projects) {
        for (let i = 0; i < TASKS_PER_PROJECT; i += 1) {
          const taskId = await createTask(core.baseUrl, id, `m4-parallel-${index}`);
          const view = await startTask(core.baseUrl, taskId, startPayload(repo.workflowPath, {
            idempotencyKey: `m4-parallel-${index}`
          }));
          expect(view.activeFlowRun).toBeDefined();
          expect(view.executionCommand).toBeDefined();
          launches.push({ taskId, repo });
          index += 1;
        }
      }

      const views = await Promise.all(launches.map(({ taskId }) =>
        pollTaskUntil(core.baseUrl, taskId, (view) => {
          const run = view.activeFlowRun;
          if (run && isTerminal(run.status)) {
            if (run.status !== "completed") {
              throw new Error(`run for task ${taskId} reached ${run.status} instead of completed\nview: ${JSON.stringify(view, null, 2)}\ncore output: ${core.output.join("")}`);
            }
            return true;
          }
          return undefined;
        }, 420_000)
      ));
      const wallMs = Date.now() - startedAt;

      expect(views.length).toBe(TASKS_PER_PROJECT * 2);
      for (const [i, view] of views.entries()) {
        const { repo } = launches[i]!;
        const run = view.activeFlowRun!;
        expect(run.status).toBe("completed");
        const externalRunId = run.externalRunId;
        expect(externalRunId).toBeTruthy();

        // Publish: the completed run pushed its flow/<runId> branch.
        expect(gitRefExists(repo.repository, `refs/heads/flow/${externalRunId}`)).toBe(true);
        // The default branch is untouched by integration.
        expect(git(repo.repository, "rev-parse", "main")).toBe(repo.initialCommit);
        // Per-result retention: success cleans the run and attempt workspaces.
        await assertCleanup(repo, externalRunId!, false);

        const metrics = await getRunMetrics(core.baseUrl, run.id);
        expect(metrics).not.toBeNull();
        expect(metrics!.counters).toMatchObject({
          dispatched: 1,
          started: 1,
          completed: 1,
          failed: 0,
          workspace_conflicts: 0,
          reconcile_restarts: 0
        });
        expect(metrics!.durations["queue_to_dispatch"]!.count).toBe(1);
        expect(metrics!.durations["start_to_terminal"]!.count).toBe(1);
        expect(metrics!.durations["start_to_terminal"]!.maxMs).toBeLessThan(300_000);
      }

      // Throughput bound: 16 managed runs (clone + commit + integrate +
      // publish + cleanup each) under real concurrency.
      expect(wallMs).toBeLessThan(420_000);
    } finally {
      killCoreProcess(core.child);
    }
  }, 600_000);
});
