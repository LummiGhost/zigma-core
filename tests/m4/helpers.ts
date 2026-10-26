/**
 * M4 shared harness. Env-gated on ZIGMA_FLOW_CLI_PATH + ZIGMA_WORKSPACE_CLI_PATH
 * + ZIGMA_CORE_CLI_PATH (the cross-repo runner builds all three and exports
 * them). Drives the real Core `serve` process over HTTP with the real Flow and
 * Workspace CLIs injected through the execution profile environment.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect } from "vitest";

export const flowCliPath = process.env["ZIGMA_FLOW_CLI_PATH"];
export const workspaceCliPath = process.env["ZIGMA_WORKSPACE_CLI_PATH"];
export const coreCliPath = process.env["ZIGMA_CORE_CLI_PATH"];
export const platformEnabled = Boolean(flowCliPath && workspaceCliPath && coreCliPath);
export function describeRealPlatform(name: string, fn: () => void): void {
  (platformEnabled ? describe : describe.skip)(name, fn);
}

export interface WorkspaceRow {
  workspace_id: string;
  status: string;
  path: string;
  branch: string;
  base_ref: string;
  base_commit: string;
  repository_url: string;
  task_id: string | null;
  flow_run_id: string | null;
  workflow_run_id: string | null;
  job_id: string | null;
  step_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskViewJson {
  task: { id: string; status: string };
  flowRuns: Array<Record<string, unknown>>;
  activeFlowRun?: {
    id: string;
    status: string;
    externalRunId?: string;
    metrics?: Record<string, unknown>;
  };
  executionCommand?: { id: string; status: string };
}

export interface MetricsSnapshotJson {
  counters: Record<string, number>;
  durations: Record<string, { count: number; totalMs: number; minMs: number; maxMs: number }>;
  updatedAt: string;
}

export const tempRoots: string[] = [];
export const spawnedCores: Array<{ child: ChildProcess; port: number }> = [];
export const dieFiles: string[] = [];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface ManagedRepo {
  root: string;
  repository: string;
  stateDir: string;
  workflowPath: string;
  initialCommit: string;
  dieFile: string;
}

/** Holds the job step in place until release.txt (or DIE_FILE, or timeout). */
export function holdingStep(nodeCode: string, timeoutMs = 180_000): string {
  return [
    "node -e \"",
    "const fs=require('node:fs');",
    nodeCode,
    `const end=Date.now()+${timeoutMs};`,
    "(function poll(){",
    "if(fs.existsSync('release.txt')) process.exit(0);",
    "if(process.env.DIE_FILE&&fs.existsSync(process.env.DIE_FILE)) process.exit(0);",
    "if(Date.now()>end) process.exit(0);",
    "setTimeout(poll,200);",
    "})();\""
  ].join("");
}

export async function makeManagedProject(
  name: string,
  workflowYaml: string,
  options: { registerDieFile?: boolean } = {}
): Promise<ManagedRepo> {
  const root = await mkdtemp(join(tmpdir(), `zigma-core-m4-${name}-`));
  tempRoots.push(root);
  const repository = join(root, "repository");
  const stateDir = join(root, "state");
  const dieFile = join(root, "die");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "core-m4@example.test");
  git(repository, "config", "user.name", "Core M4 harness");
  git(repository, "config", "core.autocrlf", "false");
  await writeFile(join(repository, "README.md"), `# ${name}\n`, "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  const initialCommit = git(repository, "rev-parse", "HEAD");
  await mkdir(join(repository, ".zigma-flow", "runs"), { recursive: true });
  await writeFile(join(repository, ".zigma-flow", "config.json"), JSON.stringify({
    tool_version: "0.8.12",
    active_run: null,
    agent: { backend: "claude-code", backends: {} }
  }, null, 2), "utf8");
  await writeFile(join(repository, ".zigma-flow", "skill-lock.json"), JSON.stringify({ skills: {} }), "utf8");
  const workflowPath = join(repository, "workflow.yml");
  await writeFile(workflowPath, workflowYaml, "utf8");
  if (options.registerDieFile) dieFiles.push(dieFile);
  return { root, repository, stateDir, workflowPath, initialCommit, dieFile };
}

export async function writeDieFiles(): Promise<void> {
  for (const dieFile of dieFiles.splice(0)) {
    await writeFile(dieFile, "die", "utf8").catch(() => {});
  }
}

export async function rmWithRetry(target: string, attempts = 8): Promise<void> {
  const absolute = resolve(target);
  const samePath = (left: string, right: string): boolean => process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!samePath(dirname(absolute), resolve(tmpdir())) || !basename(absolute).startsWith("zigma-core-m4-")) {
    throw new Error(`Refusing recursive cleanup outside an owned M4 temporary root: ${absolute}`);
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(absolute, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await rm(absolute, { recursive: true, force: true });
}

export async function waitFor<T>(
  description: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 120_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Run a workspace CLI subcommand and return the parsed envelope. */
export function workspaceEnvelope(stateDir: string, ...args: string[]): {
  contract_version: number;
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
} {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [workspaceCliPath!, "--state-dir", stateDir, ...args, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Vitest's JSON reporter omits execFileSync's extra stdout/stderr fields.
    // Preserve the provider's actual failure in the retained M4 evidence.
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number; signal?: string };
    throw new Error(`workspace CLI ${args[0]} failed (status=${failed.status}, signal=${failed.signal}): ${String(failed.stdout ?? "")}\n${String(failed.stderr ?? "")}`, { cause: error });
  }
  const envelope = JSON.parse(stdout) as {
    contract_version: number;
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  expect(envelope.contract_version).toBe(1);
  return envelope;
}

export function workspaceData(stateDir: string, ...args: string[]): unknown {
  const envelope = workspaceEnvelope(stateDir, ...args);
  if (envelope.ok !== true) {
    throw new Error(`workspace CLI ${args[0]} failed: ${envelope.error?.code ?? "UNKNOWN"} ${envelope.error?.message ?? ""}`);
  }
  return envelope.data;
}

export function listWorkspaces(stateDir: string): WorkspaceRow[] {
  return workspaceData(stateDir, "list") as WorkspaceRow[];
}

export function findRunRow(stateDir: string, flowRunId: string): WorkspaceRow | undefined {
  return listWorkspaces(stateDir).find((row) => row.flow_run_id === flowRunId && row.job_id === null);
}

export function findJobRow(stateDir: string, flowRunId: string): WorkspaceRow | undefined {
  return listWorkspaces(stateDir).find((row) => row.flow_run_id === flowRunId && row.job_id !== null);
}

interface CoreProcess {
  child: ChildProcess;
  port: number;
  baseUrl: string;
  dbPath: string;
  output: string[];
}

export async function spawnCore(options: {
  dbPath: string;
  port: number;
  workers?: number;
  extraEnv?: Record<string, string>;
}): Promise<CoreProcess> {
  const workers = options.workers ?? 4;
  const output: string[] = [];
  const child = spawn(process.execPath, [
    coreCliPath!,
    "--db", options.dbPath,
    "serve",
    "--host", "127.0.0.1",
    "--port", String(options.port),
    "--workers", String(workers)
  ], {
    env: {
      ...process.env,
      ZIGMA_CORE_URL: `http://127.0.0.1:${options.port}/v1`,
      ...options.extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  spawnedCores.push({ child, port: options.port });
  const capture = (stream: NodeJS.ReadableStream | null): void => {
    stream?.on("data", (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      if (output.length > 200) output.shift();
    });
  };
  capture(child.stdout);
  capture(child.stderr);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  await waitFor("Core serve health", async () => {
    if (child.exitCode !== null) {
      throw new Error(`Core serve exited early with code ${child.exitCode}: ${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, 60_000);
  return { child, port: options.port, baseUrl, dbPath: options.dbPath, output };
}

/** Kill only the Core serve process; provider children (Flow invoke) survive. */
export function killCoreProcess(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/PID", String(child.pid)]);
    } catch {
      // already dead — a test's finally may have killed it before afterEach re-ran
    }
  } else {
    child.kill("SIGKILL");
  }
}

export function findPidByCommandLine(substring: string): number | undefined {
  if (process.platform === "win32") {
    const stdout = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${substring}*' } | Select-Object -First 1 -ExpandProperty ProcessId)`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return stdout ? Number(stdout) : undefined;
  }
  const stdout = execFileSync("pgrep", ["-f", substring], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  const first = stdout.split("\n")[0]?.trim();
  return first ? Number(first) : undefined;
}

/** Snapshot descendants before any kill can reparent them; children precede parents. */
export function processTreeKillOrder(pid: number, processTable: string): number[] {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Unsafe provider process id");
  const children = new Map<number, number[]>();
  for (const line of processTable.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) continue;
    const child = Number(fields[0]), parent = Number(fields[1]);
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent) || child <= 1 || parent < 0) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  const seen = new Set<number>(), order: number[] = [];
  const visit = (current: number): void => {
    if (seen.has(current)) return;
    seen.add(current);
    for (const child of children.get(current) ?? []) visit(child);
    order.push(current);
  };
  visit(pid);
  return order;
}

/** Kill only the known provider tree; this is not a machine-wide orphan census. */
export function killProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Unsafe provider process id");
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
    return;
  }
  const processTable = execFileSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  });
  for (const ownedPid of processTreeKillOrder(pid, processTable)) {
    try { process.kill(ownedPid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function chmodExecutable(path: string): Promise<void> {
  await chmod(path, 0o755).catch(() => {});
}

async function apiJson(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

export async function createProfile(baseUrl: string, payload: Record<string, unknown>): Promise<string> {
  const response = await apiJson("POST", `${baseUrl}/v1/execution-profiles`, payload);
  expect(response.status).toBe(201);
  return (response.json["data"] as { id: string }).id;
}

export async function createProject(baseUrl: string, payload: Record<string, unknown>): Promise<string> {
  const response = await apiJson("POST", `${baseUrl}/v1/projects`, payload);
  expect(response.status).toBe(201);
  return (response.json["data"] as { id: string }).id;
}

export async function createTask(baseUrl: string, projectId: string, title: string): Promise<string> {
  const response = await apiJson("POST", `${baseUrl}/v1/tasks`, {
    projectId,
    title,
    description: `M4 harness task: ${title}`,
    priority: "normal",
    source: { kind: "api", metadata: {} },
    createdBy: { type: "user", id: "owner" },
    labels: [],
    metadata: {}
  });
  expect(response.status).toBe(201);
  return (response.json["data"] as { id: string }).id;
}

export function startPayload(workflowPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowRef: workflowPath,
    callerContext: {
      actor: { type: "user", id: "owner" },
      capabilities: ["task:start", "workflow:invoke", "workspace:create", "workspace:write", "gate:approve", "gate:reject"],
      constraints: {
        repositoryIds: ["main"],
        workflowRefs: [workflowPath],
        toolNames: ["git", "zigma-workspace", "node"],
        branchPatterns: ["zigma/*"]
      },
      source: { kind: "api", metadata: {} }
    },
    inputs: {},
    dryRun: false,
    ...extra
  };
}

export async function startTask(baseUrl: string, taskId: string, payload: Record<string, unknown>): Promise<TaskViewJson> {
  const response = await apiJson("POST", `${baseUrl}/v1/tasks/${taskId}/start`, payload);
  expect(response.status).toBe(202);
  return response.json["data"] as unknown as TaskViewJson;
}

export async function cancelTask(baseUrl: string, taskId: string, reason: string): Promise<TaskViewJson> {
  const response = await apiJson("POST", `${baseUrl}/v1/tasks/${taskId}/cancel`, { reason });
  expect(response.status).toBe(200);
  return response.json["data"] as unknown as TaskViewJson;
}

export async function getTaskView(baseUrl: string, taskId: string): Promise<TaskViewJson> {
  const response = await apiJson("GET", `${baseUrl}/v1/tasks/${taskId}`);
  expect(response.status).toBe(200);
  return response.json["data"] as unknown as TaskViewJson;
}

export async function getRunMetrics(baseUrl: string, runId: string): Promise<MetricsSnapshotJson | null> {
  const response = await apiJson("GET", `${baseUrl}/v1/flow-runs/${runId}/metrics`);
  expect(response.status).toBe(200);
  return response.json["data"] as unknown as MetricsSnapshotJson | null;
}

export async function pollTaskUntil(
  baseUrl: string,
  taskId: string,
  predicate: (view: TaskViewJson) => boolean | undefined,
  timeoutMs = 180_000
): Promise<TaskViewJson> {
  return waitFor(`task ${taskId} condition`, async () => {
    const view = await getTaskView(baseUrl, taskId);
    return predicate(view) ? view : undefined;
  }, timeoutMs);
}

export function isTerminal(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function flowRunIds(repository: string): string[] {
  const stdout = execFileSync(process.execPath, ["-e",
    "const fs=require('node:fs');const p=process.argv[1]+'/.zigma-flow/runs';process.stdout.write(JSON.stringify(fs.existsSync(p)?fs.readdirSync(p):[]))",
    repository
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return JSON.parse(stdout) as string[];
}

/** Tail of the Flow run's structured log (teardown/reconcile messages). */
export async function readRunLogTail(repository: string, runId: string, maxLines = 40): Promise<string> {
  const path = join(repository, ".zigma-flow", "runs", runId, "run.log.jsonl");
  try {
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return `(no run log at ${path})`;
  }
}

export function gitRefExists(repository: string, ref: string): boolean {
  try {
    git(repository, "show-ref", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

export async function assertCleanup(repo: ManagedRepo, flowRunId: string, retained: boolean, timeoutMs = 60_000): Promise<void> {
  // Core marks the task terminal before Flow's managed teardown finishes, so
  // wait for the workspace row to reach the post-teardown state instead of
  // asserting immediately. MERGED (integrated, cleanup skipped/retained) and
  // CLEANUP_FAILED only appear once teardown has actually run.
  const row = await waitFor(`cleanup of run ${flowRunId}`, async () => {
    const candidate = findRunRow(repo.stateDir, flowRunId);
    if (candidate === undefined) return undefined;
    if (retained) {
      return candidate.status === "MERGED" || candidate.status === "CLEANUP_FAILED"
        ? candidate
        : undefined;
    }
    return candidate.status === "CLEANED" ? candidate : undefined;
  }, timeoutMs);
  expect(row).toBeDefined();
  if (retained) {
    expect(row!.status).not.toBe("CLEANED");
    expect(existsSync(row!.path)).toBe(true);
  } else {
    expect(row!.status).toBe("CLEANED");
    expect(existsSync(row!.path)).toBe(false);
  }
}
