/**
 * M3.5 managed lifecycle — env-gated on ZIGMA_FLOW_CLI_PATH and
 * ZIGMA_WORKSPACE_CLI_PATH.
 *
 * Drives the real Flow CLI (via LocalCliFlowExecutor) with the managed
 * workspace bridge activated (`ZIGMA_WORKSPACE_CLI_PATH` +
 * `ZIGMA_WORKSPACE_STATE_DIR` in the request environment), through the full
 * host-owned lifecycle:
 *
 *   invoke (managed workflow)  → run + job attempt workspaces exist
 *   same-cwd proof             → the script step wrote into the job workspace
 *   abort                      → quiescence acknowledged by the Flow provider
 *   reconcile + strict cleanup → workspace CLI removes every leftover
 *                                workspace; registry converges to CLEANED
 *
 * Flow's M3.5 bridge only implements prepare-run/prepare-job, so after the
 * abort the workspace registry still holds RUNNING rows — exactly the state a
 * crashed or cancelled host must reconcile. This test proves Core can drive
 * that recovery over the real CLI boundary.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCliFlowExecutor } from "../../src/adapters/local-cli-flow.js";

const flowCliPath = process.env["ZIGMA_FLOW_CLI_PATH"];
const workspaceCliPath = process.env["ZIGMA_WORKSPACE_CLI_PATH"];
const describeRealProviders = flowCliPath && workspaceCliPath ? describe : describe.skip;
const tempRoots: string[] = [];

let activeCleanup:
  | {
      executor: LocalCliFlowExecutor;
      repository: string;
      environment: Record<string, string>;
      startPromise: Promise<unknown>;
    }
  | undefined;
let activeRunId: string | undefined;
let quiesced = false;
let callbackServer: Server | undefined;

const MANAGED_WORKFLOW = `\
name: core-managed-lifecycle
version: "1"
workspace:
  provider: zigma-workspace
  repository: .
  base: main
jobs:
  worker:
    steps:
      - id: hold
        type: script
        run: node -e "require('node:fs').writeFileSync('job-marker.txt','present'); setTimeout(()=>{},30000)"
`;

interface WorkspaceRow {
  workspace_id: string;
  status: string;
  path: string;
  flow_run_id: string | null;
  job_id: string | null;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeManagedProject(): Promise<{ root: string; repository: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "zigma-core-m3-lifecycle-"));
  tempRoots.push(root);
  const repository = join(root, "repository");
  const stateDir = join(root, "state");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "core-m3@example.test");
  git(repository, "config", "user.name", "Core M3 lifecycle");
  git(repository, "config", "core.autocrlf", "false");
  await writeFile(join(repository, "README.md"), "# managed lifecycle\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  // Flow project scaffolding. Untracked files stay out of the workspace clone.
  await mkdir(join(repository, ".zigma-flow", "runs"), { recursive: true });
  await writeFile(join(repository, ".zigma-flow", "config.json"), JSON.stringify({
    tool_version: "0.8.12",
    active_run: null,
    agent: { backend: "claude-code", backends: {} }
  }, null, 2), "utf8");
  await writeFile(join(repository, ".zigma-flow", "skill-lock.json"), JSON.stringify({ skills: {} }), "utf8");
  await writeFile(join(repository, "workflow.yml"), MANAGED_WORKFLOW, "utf8");
  return { root, repository, stateDir };
}

/** Run a workspace CLI subcommand and return the ok-envelope data. */
function workspaceJson(stateDir: string, ...args: string[]): unknown {
  const stdout = execFileSync(process.execPath, [workspaceCliPath!, "--state-dir", stateDir, ...args, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const envelope = JSON.parse(stdout) as {
    contract_version: number;
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  expect(envelope.contract_version).toBe(1);
  if (envelope.ok !== true) {
    throw new Error(`workspace CLI ${args[0]} failed: ${envelope.error?.code ?? "UNKNOWN"} ${envelope.error?.message ?? ""}`);
  }
  return envelope.data;
}

function listWorkspaces(stateDir: string): WorkspaceRow[] {
  return workspaceJson(stateDir, "list") as WorkspaceRow[];
}

async function waitFor<T>(description: string, probe: () => Promise<T | undefined> | T | undefined, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function rmWithRetry(target: string, attempts = 6): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await rm(target, { recursive: true, force: true });
}

interface ReceivedCallback {
  type?: unknown;
  runId?: unknown;
}

/** Ephemeral host callback endpoint: hosts are required to listen, so a dead
 * callback URL must not be part of the contract evidence. */
async function startCallbackListener(): Promise<{ url: string; received: ReceivedCallback[] }> {
  const received: ReceivedCallback[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        received.push(JSON.parse(body) as ReceivedCallback);
      } catch {
        // best-effort; only the terminal-callback shape is asserted below
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  callbackServer = server;
  return { url: `http://127.0.0.1:${port}/v1`, received };
}

afterEach(async () => {
  // A failed test can leave the invoke child (and its step children) alive;
  // on Windows their CWD locks make the rm below fail with EBUSY and the
  // processes would keep running. Best-effort quiescence before cleanup.
  const cleanup = activeCleanup;
  if (cleanup !== undefined && !quiesced) {
    const runIds = activeRunId !== undefined
      ? [activeRunId]
      : await readdir(join(cleanup.repository, ".zigma-flow", "runs")).catch(() => [] as string[]);
    for (const runId of runIds) {
      try {
        await cleanup.executor.cancel({
          command: flowCliPath!,
          externalRunId: runId,
          projectRoot: cleanup.repository,
          reason: "M3 lifecycle test cleanup",
          timeoutMs: 30_000,
          environment: cleanup.environment,
        });
      } catch {
        // best-effort; the rm retries below absorb residual locks
      }
    }
  }
  if (cleanup !== undefined) {
    await Promise.race([
      cleanup.startPromise.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  activeCleanup = undefined;
  activeRunId = undefined;
  quiesced = false;
  if (callbackServer !== undefined) {
    callbackServer.close();
    callbackServer = undefined;
  }
  await Promise.all(tempRoots.splice(0).map((root) => rmWithRetry(root)));
}, 60_000);

describeRealProviders("M3 managed lifecycle (ZIGMA_FLOW_CLI_PATH + ZIGMA_WORKSPACE_CLI_PATH)", () => {
  it("invokes a managed workflow, proves the same-cwd contract, aborts to quiescence, then reconciles and strictly cleans up", async () => {
    const { repository, stateDir } = await makeManagedProject();
    const flowRunId = "flow-m3-managed-lifecycle";
    const environment = {
      ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath!,
      ZIGMA_WORKSPACE_STATE_DIR: stateDir,
    };
    const executor = new LocalCliFlowExecutor();
    const { url: callbackUrl, received } = await startCallbackListener();

    const startPromise = executor.start({
      command: flowCliPath!,
      projectId: "project-m3-lifecycle",
      taskId: "task-m3-lifecycle",
      flowRunId,
      workflowRef: join(repository, "workflow.yml"),
      taskText: "prove the managed lifecycle boundary",
      projectRoot: repository,
      inputs: {},
      callerContext: {
        actor: { type: "service", id: "zigma-core" },
        capabilities: ["task:start", "workflow:invoke"],
        constraints: {
          repositoryIds: ["repository-m3-lifecycle"],
          workflowRefs: ["core-managed-lifecycle"],
          toolNames: ["node"],
          branchPatterns: ["flow/*"]
        },
        source: { kind: "system", metadata: { test: "m3-managed-lifecycle" } }
      },
      permissionSnapshotId: "permission-m3-lifecycle",
      integrityHash: `sha256:${"b".repeat(64)}`,
      operationId: "command-m3-lifecycle",
      callbackCorrelationId: "command-m3-lifecycle",
      coreCallbackUrl: callbackUrl,
      timeoutMs: 300_000,
      environment,
      dryRun: false
    });
    activeCleanup = { executor, repository, environment, startPromise };

    // The invoke envelope only prints when the run terminates, so the run id
    // comes from the runs directory while the child is still holding.
    const runId = await waitFor(
      "the Flow run directory",
      async () => {
        const entries = await readdir(join(repository, ".zigma-flow", "runs")).catch(() => [] as string[]);
        return entries.length === 1 ? entries[0] : undefined;
      },
    );
    activeRunId = runId;

    // Same-cwd proof: the job attempt workspace exists in the provider
    // registry and the step wrote its marker inside it. The engine passes its
    // own run id (the runs-directory name) to prepare-run, so that is the
    // registry's flow_run_id — not the caller flowRunId above.
    const jobWorkspace = await waitFor(
      "the managed job attempt workspace with its execution marker",
      () => {
        const row = listWorkspaces(stateDir).find(
          (candidate) => candidate.flow_run_id === runId && candidate.job_id !== null,
        );
        return row !== undefined && existsSync(join(row.path, "job-marker.txt")) ? row : undefined;
      },
    );
    expect(jobWorkspace.status).not.toBe("CLEANED");

    // Abort the live invocation; the provider must acknowledge quiescence
    // (children terminated and reaped) before Core proceeds to cleanup.
    const cancelled = await executor.cancel({
      command: flowCliPath!,
      externalRunId: runId,
      projectRoot: repository,
      reason: "M3 managed lifecycle contract abort",
      timeoutMs: 120_000,
      environment
    });
    expect(cancelled).toMatchObject({ status: "cancelled", quiescent: true });
    quiesced = true;

    const started = await startPromise;
    expect(started.externalRunId).toBe(runId);
    expect(started.status).toBe("cancelled");

    // The host boundary is two-way: Core hands over the callback URL and the
    // provider must post the terminal run.cancelled event to it before
    // acknowledging quiescence.
    expect(received.some((event) => event.type === "run.cancelled" && event.runId === runId)).toBe(true);

    // Flow's bridge owns only prepare-run/prepare-job today, so the registry
    // still holds the run + job rows. Reconcile each, then strictly clean up
    // job-first so the run workspace is last.
    const rows = listWorkspaces(stateDir).filter((row) => row.flow_run_id === runId);
    const jobRows = rows.filter((row) => row.job_id !== null);
    const runRow = rows.find((row) => row.job_id === null);
    expect(jobRows.length).toBeGreaterThanOrEqual(1);
    expect(runRow).toBeDefined();

    const ordered = [...jobRows, runRow!];
    let cleanupIndex = 0;
    for (const row of ordered) {
      const reconciled = workspaceJson(stateDir, "reconcile", "--workspace", row.workspace_id) as {
        workspace_id: string;
        reconciled_status: string;
      };
      expect(reconciled.workspace_id).toBe(row.workspace_id);
      expect(typeof reconciled.reconciled_status).toBe("string");

      const cleaned = workspaceJson(
        stateDir,
        "cleanup",
        "--workspace", row.workspace_id,
        "--operation-id", `core:m3:cleanup:${cleanupIndex}`,
        "--strict",
      ) as { workspace_id: string; status: string; removed: boolean };
      expect(cleaned).toMatchObject({ workspace_id: row.workspace_id, status: "CLEANED", removed: true });
      expect(existsSync(row.path)).toBe(false);
      cleanupIndex += 1;
    }

    // Registry convergence: every workspace for this run is CLEANED and the
    // state directory survived the whole sequence.
    const finalRows = listWorkspaces(stateDir).filter((row) => row.flow_run_id === runId);
    expect(finalRows.length).toBeGreaterThanOrEqual(2);
    for (const row of finalRows) {
      expect(row.status).toBe("CLEANED");
    }
    expect(existsSync(join(stateDir, "registry.db"))).toBe(true);
  }, 300_000);
});
