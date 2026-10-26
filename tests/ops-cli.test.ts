/** Black-box operator contract tests: compiled CLI + real temporary HTTP server.
 * Providers and workloads here are explicit deterministic fixtures, not live
 * model calls or evidence that Zigma can autonomously repair a real project.
 * Run `npm run build` before this file so dist/cli.js matches the source.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "dist", "cli.js");
const SECRET = "OPS_FIXTURE_ENV_VALUE_MUST_NOT_APPEAR";
const roots: string[] = [];
const servers: Server[] = [];

type Json = Record<string, any>;
interface CommandResult { code: number; stdout: string; stderr: string }
interface Fixture {
  root: string;
  workspace: string;
  frozen: string;
  manifestPath: string;
  manifest: Json;
  calls: { creates: number; starts: number; cancels: number; paths: string[] };
  behavior: { running: boolean; failed: boolean; mutateFrozen: boolean; omitQuiescent: boolean; cancelAck: boolean; awaitingHuman: boolean };
}

async function cli(args: string[], timeoutMs = 20_000): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI, "ops", ...args], {
      cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (part) => { stdout += part; });
    child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("ops CLI exceeded its test timeout: " + stderr));
      else resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function jsonFile(path: string): Promise<Json> {
  return JSON.parse(await readFile(path, "utf8")) as Json;
}

async function saveManifest(fixture: Fixture): Promise<void> {
  await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest, null, 2), "utf8");
}

async function provider(root: string, kind: "flow" | "workspace"): Promise<string> {
  const script = join(root, kind + "-provider.cjs");
  const version = kind === "flow" ? "0.8.18" : "0.1.6";
  const capabilities = kind === "flow"
    ? ["caller-context-v1", "invoke-json-v1", "context-freeze-v1", "callback-envelope-v1", "callback-http-delivery-v1", "run-inspect-v1"]
    : ["workspace-create-v1", "workspace-bind-run-v1", "workspace-diff-artifact-v1", "workspace-snapshot-artifacts-v1", "workspace-cleanup-v1"];
  const contract = kind === "flow"
    ? { contractVersion: 1, provider: "zigma-flow", packageVersion: version, capabilities }
    : { ok: true, data: { contract_version: 1, provider: "zigma-workspace", package_version: version, managed_supported: true, capabilities } };
  await writeFile(script, `#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log(${JSON.stringify(version)});\nelse if(process.argv.includes('contract-info')) console.log(${JSON.stringify(JSON.stringify(contract))});\nelse process.exitCode=2;\n`, "utf8");
  if (process.platform === "win32") {
    const wrapper = join(root, kind + "-provider.cmd");
    await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  await chmod(script, 0o755);
  return script;
}

async function fixture(): Promise<Fixture> {
  const tempParent = resolve(tmpdir());
  const root = resolve(await mkdtemp(join(tempParent, "zigma-ops-cli-")));
  if (dirname(root) !== tempParent || !root.startsWith(join(tempParent, "zigma-ops-cli-"))) {
    throw new Error("Unexpected test-owned temporary path");
  }
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "candidate.txt"), "accepted fixture bytes\n", "utf8");
  const frozen = join(root, "workflow.yml");
  await writeFile(frozen, "name: deterministic-ops-fixture\nversion: '1'\n", "utf8");
  const flowCommand = await provider(root, "flow");
  const workspaceCommand = await provider(root, "workspace");
  const calls = { creates: 0, starts: 0, cancels: 0, paths: [] as string[] };
  const behavior = { running: false, failed: false, mutateFrozen: false, omitQuiescent: false, cancelAck: false, awaitingHuman: false };
  const timestamp = "2026-10-26T00:00:00.000Z";
  const project = {
    id: "project-ops", key: "fixture", displayName: "Ops fixture", status: "active", executionProfileId: "profile-ops",
    repositories: [{ id: "repo", provider: "generic-git", url: workspace, defaultRef: "main", writable: false, metadata: {} }],
    defaultRepositoryId: "repo", defaultWorkflowRef: frozen,
    workspacePolicy: { provider: "zigma-workspace-cli", mode: "read-only", branchTemplate: "zigma/{taskId}", cleanup: "manual", snapshotOnTerminal: true },
    metadata: { projectRoot: workspace }, createdAt: timestamp, updatedAt: timestamp
  };
  const profile = {
    id: "profile-ops", name: "fixture", mode: "local-cli", flowCommand, workspaceCommand,
    timeoutMs: 5000, environment: { DO_NOT_SERIALIZE_PROFILE_ENV: SECRET }, metadata: {}, createdAt: timestamp, updatedAt: timestamp,
    executionPolicy: { contractVersion: 1, capacity: { global: 1, perProject: 1, perRepository: 1, perBackend: 1 }, admission: { writablePerRepository: 1, queueDiscipline: "fifo", requireDistinctWorkspace: true } }
  };
  const view = (taskId: string): Json => {
    const cancelled = behavior.cancelAck && calls.cancels > 0;
    const pending = behavior.running && !cancelled;
    const status = cancelled ? "cancelled" : behavior.awaitingHuman ? "awaiting_human" : pending ? "running" : behavior.failed ? "failed" : "completed";
    const flow = { id: "flow-" + taskId, taskId, status, externalRunId: "external-" + taskId, lastCallbackSequence: 1 };
    return {
      task: { id: taskId, projectId: project.id, title: "Fixture task", description: "Deterministic protocol fixture", priority: "normal",
        source: { kind: "api", metadata: {} }, createdBy: { type: "user", id: "ops-test" }, labels: [], metadata: {},
        activeFlowRunId: flow.id, revision: 1, createdAt: timestamp, updatedAt: timestamp,
        status: behavior.running && calls.cancels ? "blocked" : status },
      project,
      activeFlowRun: flow,
      flowRuns: [flow],
      executionCommand: {
        id: "command-" + taskId,
        status: behavior.awaitingHuman ? "dispatched" : pending ? calls.cancels ? "cancel_requested" : "dispatching" : status,
        ...(pending || behavior.awaitingHuman ? {} : { providerResponse: { status, ...(behavior.omitQuiescent ? {} : { quiescent: true }) } })
      },
      workspace: { id: "workspace-" + taskId, path: workspace, status: "active" },
      workspaceHandles: [], evidence: { bundle: { status: "open" }, items: [] }
    };
  };
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    calls.paths.push((request.method ?? "GET") + " " + path);
    let result: Json;
    let code = 200;
    try {
      // Consume bodies so keep-alive behavior matches an actual HTTP API.
      let body = "";
      for await (const part of request) body += part.toString();
      if (body) JSON.parse(body);
      if (path === "/health") result = { ok: true, service: "zigma-core", version: "0.1.3" };
      else if (path === "/v1/projects/project-ops") result = { data: project };
      else if (path === "/v1/execution-profiles/profile-ops") result = { data: profile };
      else if (path === "/v1/tasks" && request.method === "POST") {
        calls.creates += 1;
        code = 201;
        result = { data: { id: "task-" + calls.creates, projectId: project.id, status: "created" } };
      } else {
        const match = /^\/v1\/tasks\/(task-\d+)(?:\/(start|cancel))?$/.exec(path);
        if (match) {
          const taskId = match[1]!;
          if (match[2] === "start") {
            calls.starts += 1;
            if (behavior.mutateFrozen) await writeFile(frozen, "mutated after dispatch\n", "utf8");
            code = 202;
            result = { data: view(taskId) };
          } else if (match[2] === "cancel") {
            calls.cancels += 1;
            result = { data: { id: taskId, status: "blocked" } };
          } else result = { data: view(taskId) };
        } else if (path.endsWith("/evidence")) result = { data: { bundle: { status: "open" }, items: [] } };
        else { code = 404; result = { error: { code: "NOT_FOUND", message: path } }; }
      }
    } catch (error) {
      code = 500;
      result = { error: { message: String(error) } };
    }
    response.writeHead(code, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture HTTP address");
  const manifestPath = join(root, "manifest.json");
  const manifest: Json = {
    schema: "zigma.ops/1", coreUrl: `http://127.0.0.1:${address.port}`, projectId: project.id,
    cohort: "black-box-fixture-v1", workloadKind: "deterministic", proposalFreedom: "none", modelRoute: "no-model-fixture",
    workflowRef: frozen, backend: "claude-code", suiteLeaseFile: join(root, "suite-use.lock"), freezeFiles: ["workflow.yml"],
    callerContext: {
      actor: { type: "user", id: "ops-test" }, capabilities: ["task:start", "workflow:invoke", "workspace:create"],
      constraints: { repositoryIds: ["repo"], workflowRefs: [frozen], toolNames: [], branchPatterns: ["zigma/*"] },
      source: { kind: "api", metadata: {} }
    },
    acceptance: { command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({status:'pass'}))"], timeoutMs: 1000 },
    delivery: { files: ["candidate.txt"] }, tasks: [{ key: "one", title: "One fixture task", description: "Deterministic protocol fixture only", inputs: {} }],
    timeoutMs: 5000, pollIntervalMs: 10, cancelGraceMs: 100
  };
  const value = { root, workspace, frozen, manifestPath, manifest, calls, behavior };
  await saveManifest(value);
  return value;
}

async function run(f: Fixture, name = "batch"): Promise<{ out: string; result: CommandResult }> {
  await saveManifest(f);
  const out = join(f.root, name);
  return { out, result: await cli(["run", "--manifest", f.manifestPath, "--out", out]) };
}

async function receipt(out: string, key = "one"): Promise<Json> {
  return jsonFile(join(out, "tasks", key, "receipt.json"));
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  const tempParent = resolve(tmpdir());
  for (const root of roots.splice(0)) {
    // Only the freshly created, fixed-prefix fixture roots can be deleted.
    if (dirname(root) !== tempParent || !root.startsWith(join(tempParent, "zigma-ops-cli-"))) throw new Error("Refusing unsafe test cleanup");
    await rm(root, { recursive: true, force: true });
  }
});

describe("ops CLI black-box contract", { timeout: 30_000 }, () => {
  it.each(["ignore", "inherit"] as const)("bounds checker timeout with %s grandchild pipes and retains the lease", async (stdio) => {
    const f = await fixture();
    const pidFile = join(f.root, "checker-grandchild.pid");
    f.manifest.tasks.push({ key: "later", title: "Must not dispatch", description: "Unknown checker scope blocks the batch" });
    f.manifest.acceptance.timeoutMs = 500;
    f.manifest.acceptance.args = ["-e", `const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000);setInterval(()=>{},1000)'],{stdio:${JSON.stringify(stdio)}});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`];
    const started = Date.now();
    try {
      const { out, result } = await run(f);
      expect(result.code, result.stderr).toBe(11);
      expect(Date.now() - started).toBeLessThan(8000);
      expect(f.calls.creates).toBe(1);
      expect(f.calls.starts).toBe(1);
      expect(await receipt(out)).toMatchObject({ status: "blocked", acceptance: { status: "blocked" }, providerQuiescent: false, delivery: { status: "not_run" } });
      expect((await stat(f.manifest.suiteLeaseFile)).isFile()).toBe(true);
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  });

  it("retains a lease when an owned provider preflight command times out", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "flow-provider.cjs"), "setTimeout(()=>process.exit(0),5000);setInterval(()=>{},1000);");
    f.manifest.preflightTimeoutMs = 300;
    const { result } = await run(f);
    expect(result.code, result.stderr).toBe(11);
    expect(f.calls.creates).toBe(0);
    expect((await stat(f.manifest.suiteLeaseFile)).isFile()).toBe(true);
  });
  it("rejects destination junction ancestors planted by an acceptance command", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside-target");
    await mkdir(join(outside, "nested"), { recursive: true });
    await mkdir(join(f.workspace, "linked", "nested"), { recursive: true });
    await writeFile(join(f.workspace, "linked", "nested", "candidate.txt"), "must stay inside delivery");
    f.manifest.delivery.files = ["linked/nested/candidate.txt"];
    f.manifest.acceptance.args = ["-e", `const fs=require('node:fs'),p=require('node:path');const dest=p.join(process.env.ZIGMA_OPS_OUT_DIR,'tasks','one','artifacts');fs.mkdirSync(dest,{recursive:true});fs.symlinkSync(${JSON.stringify(outside)},p.join(dest,'linked'),'junction');process.stdout.write(JSON.stringify({status:'pass'}));`];
    const { result } = await run(f);
    expect(result.code, result.stderr).toBe(12);
    await expect(stat(join(outside, "nested", "candidate.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not append audit notes through a hard link to an outside file", async () => {
    const f = await fixture();
    const { out, result } = await run(f);
    expect(result.code).toBe(0);
    const outside = join(f.root, "outside-audit.txt");
    await writeFile(outside, "preserve outside bytes\n");
    await link(outside, join(out, "interventions.jsonl"));
    const note = await cli(["note", "--dir", out, "--task", "one", "--kind", "repair", "--reason", "must not escape"]);
    expect(note.code, note.stderr).toBe(12);
    expect(await readFile(outside, "utf8")).toBe("preserve outside bytes\n");
  });

  it("cannot count an unattempted receipt as an acceptance success", async () => {
    const f = await fixture();
    const { out, result } = await run(f);
    expect(result.code).toBe(0);
    const file = join(out, "tasks", "one", "receipt.json");
    const forged = await jsonFile(file);
    Object.assign(forged, { status: "not_started", attempted: false, executionStatus: "not_started", providerQuiescent: false, delivery: { status: "not_run", artifacts: [] } });
    await writeFile(file, JSON.stringify(forged));
    expect((await cli(["report", "--dir", out])).code).toBe(12);
  });

  it("keeps different operations client versions in separate measurement groups", async () => {
    const f = await fixture();
    const first = await run(f, "client-old");
    const second = await run(f, "client-new");
    expect(first.result.code).toBe(0);
    expect(second.result.code).toBe(0);
    const file = join(second.out, "plan.json");
    const plan = await jsonFile(file);
    plan.clientVersion = "0.1.5";
    await writeFile(file, JSON.stringify(plan));
    const result = await cli(["report", "--dir", f.root]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).groups).toHaveLength(2);
  });
  it("refuses an occupied suite lease before contacting providers or Core", async () => {
    const f = await fixture();
    await writeFile(f.manifest.suiteLeaseFile, "other owner");
    expect((await run(f)).result.code).toBe(12);
    expect(f.calls.paths).toEqual([]);
    expect(await readFile(f.manifest.suiteLeaseFile, "utf8")).toBe("other owner");
  });

  it("accepts normal invoke completion without a cancellation-specific quiescence field", async () => {
    const f = await fixture();
    f.behavior.omitQuiescent = true;
    expect((await run(f)).result.code).toBe(0);
  });

  it("retains an awaiting-human run without cancelling or treating it as a success", async () => {
    const f = await fixture();
    f.behavior.awaitingHuman = true;
    const { out, result } = await run(f);
    expect(result.code).toBe(11);
    expect(f.calls.cancels).toBe(0);
    expect(await receipt(out)).toMatchObject({ status: "blocked", providerQuiescent: false });
    expect((await stat(f.manifest.suiteLeaseFile)).isFile()).toBe(true);
  });

  it("releases the lease after timeout cancellation has explicit quiescence proof", async () => {
    const f = await fixture();
    f.behavior.running = true;
    f.behavior.cancelAck = true;
    f.manifest.timeoutMs = 80;
    const { out, result } = await run(f);
    expect(result.code).toBe(11);
    expect(f.calls.cancels).toBe(1);
    expect(await receipt(out)).toMatchObject({ status: "blocked", executionStatus: "cancelled", providerQuiescent: true });
    await expect(stat(f.manifest.suiteLeaseFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects contradictory delivered receipts and duplicate plan keys in reports", async () => {
    const f = await fixture();
    const { out, result } = await run(f);
    expect(result.code).toBe(0);
    const file = join(out, "tasks", "one", "receipt.json");
    const original = await readFile(file, "utf8");
    const forged = JSON.parse(original);
    forged.acceptance.status = "fail";
    await writeFile(file, JSON.stringify(forged));
    expect((await cli(["report", "--dir", out])).code).toBe(12);
    await writeFile(file, original);
    const plan = await jsonFile(join(out, "plan.json"));
    plan.tasks.push(plan.tasks[0]);
    await writeFile(join(out, "plan.json"), JSON.stringify(plan));
    expect((await cli(["report", "--dir", out])).code).toBe(12);
  });
  it("rejects incompatible manifests and remote/userinfo URLs before dispatch", async () => {
    const f = await fixture();
    const original = structuredClone(f.manifest);
    const mutations = [
      () => { f.manifest.schema = "zigma.ops/999"; },
      () => { f.manifest.coreUrl = "https://example.invalid"; },
      () => { f.manifest.coreUrl = "http://user:password@127.0.0.1:1"; },
      () => { f.manifest.freezeFiles = ["missing-file"]; }
    ];
    for (let i = 0; i < mutations.length; i++) {
      f.manifest = structuredClone(original);
      mutations[i]!();
      expect((await run(f, "invalid-" + i)).result.code).toBe(12);
    }
    expect(f.calls.creates).toBe(0);
    expect(f.calls.starts).toBe(0);
  });

  it("refuses an existing output directory without overwriting or redispatching", async () => {
    const f = await fixture();
    const out = join(f.root, "existing");
    await mkdir(out);
    await writeFile(join(out, "sentinel"), "preserve me", "utf8");
    const result = await cli(["run", "--manifest", f.manifestPath, "--out", out]);
    expect(result.code).toBe(12);
    expect(await readFile(join(out, "sentinel"), "utf8")).toBe("preserve me");
    expect(f.calls.creates).toBe(0);
  });

  it("runs the HTTP lifecycle, independently accepts, copies bytes and records truthful receipts", async () => {
    const f = await fixture();
    const { out, result } = await run(f);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).schema).toBe("zigma.ops.run/1");
    const plan = await jsonFile(join(out, "plan.json"));
    const item = await receipt(out);
    expect(plan).toMatchObject({ schema: "zigma.ops.plan/1", cohort: "black-box-fixture-v1", tasks: [{ key: "one" }] });
    expect(item).toMatchObject({ schema: "zigma.ops.receipt/1", runId: plan.runId, key: "one", status: "delivered", attempted: true, providerQuiescent: true, acceptance: { status: "pass" }, delivery: { status: "pass" } });
    expect(item.taskId).toBe("task-1");
    expect(item.flowRunId).toBe("flow-task-1");
    expect(item.executionCommandId).toBe("command-task-1");
    expect(item.elapsedMs).toBeGreaterThanOrEqual(0);
    const bytes = await readFile(join(out, "tasks", "one", "artifacts", "candidate.txt"));
    expect(bytes.toString()).toBe("accepted fixture bytes\n");
    expect(item.delivery.artifacts).toEqual([expect.objectContaining({ path: "candidate.txt", sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length })]);
    expect(await readFile(f.frozen, "utf8")).toBe("name: deterministic-ops-fixture\nversion: '1'\n");
    await expect(stat(f.manifest.suiteLeaseFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify({ result, plan, item })).not.toContain(SECRET);
    expect(f.calls.creates).toBe(1);
    expect(f.calls.starts).toBe(1);
  });

  it("records a failed execution without accepting or delivering it", async () => {
    const f = await fixture();
    f.behavior.failed = true;
    const { out, result } = await run(f);
    expect(result.code).toBe(10);
    expect(await receipt(out)).toMatchObject({ status: "failed", attempted: true, acceptance: { status: "not_run" }, delivery: { status: "not_run" } });
  });

  it("distinguishes declared acceptance failure from contradictory exit/status evidence", async () => {
    const f = await fixture();
    for (const [name, status, code, expected] of [["fail", "fail", 10, 10], ["false-pass", "pass", 7, 12], ["false-success", "fail", 0, 12]] as const) {
      f.manifest.acceptance.args = ["-e", `process.stdout.write(JSON.stringify({status:'${status}'}));process.exitCode=${code}`];
      const result = await run(f, name);
      expect(result.result.code, result.result.stderr).toBe(expected);
      expect((await receipt(result.out)).status).toBe("rejected");
      expect((await receipt(result.out)).delivery.status).not.toBe("pass");
    }
  });

  it("rejects malformed checker JSON as a contract error", async () => {
    const f = await fixture();
    f.manifest.acceptance.args = ["-e", "process.stdout.write('not-json')"];
    const { out, result } = await run(f);
    expect(result.code).toBe(12);
    expect(await receipt(out)).toMatchObject({ status: "rejected", delivery: { status: "not_run" } });
  });

  it("keeps independent blocked acceptance distinct and releases only a quiescent lease", async () => {
    const f = await fixture();
    f.manifest.acceptance.args = ["-e", "process.stdout.write(JSON.stringify({status:'blocked'}));process.exitCode=11"];
    const { out, result } = await run(f);
    expect(result.code).toBe(11);
    expect(await receipt(out)).toMatchObject({ status: "blocked", providerQuiescent: true, acceptance: { status: "blocked" }, delivery: { status: "not_run" } });
    await expect(stat(f.manifest.suiteLeaseFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requests cancellation on timeout and retains the lease when provider truth stays unknown", async () => {
    const f = await fixture();
    f.behavior.running = true;
    f.manifest.timeoutMs = 80;
    f.manifest.cancelGraceMs = 80;
    const { out, result } = await run(f);
    expect(result.code, result.stderr).toBe(11);
    expect(f.calls.cancels).toBe(1);
    expect(await receipt(out)).toMatchObject({ status: "blocked", providerQuiescent: false, acceptance: { status: "not_run" }, delivery: { status: "not_run" } });
    expect((await stat(f.manifest.suiteLeaseFile)).isFile()).toBe(true);
  });

  it("detects frozen-input mutation after dispatch instead of delivering a false pass", async () => {
    const f = await fixture();
    f.behavior.mutateFrozen = true;
    const { out, result } = await run(f);
    expect(result.code, result.stderr).toBe(12);
    expect(await receipt(out)).toMatchObject({ status: "rejected", delivery: { status: "not_run" } });
  });

  it("rejects delivery path traversal, absolute paths and git metadata before dispatch", async () => {
    const f = await fixture();
    for (const [i, path] of ["../outside.txt", resolve(f.root, "outside.txt"), ".git/config"].entries()) {
      f.manifest.delivery.files = [path];
      expect((await run(f, "escape-" + i)).result.code).toBe(12);
    }
    expect(f.calls.creates).toBe(0);
    expect(f.calls.starts).toBe(0);
  });

  it("rejects a symlink/junction component escaping the reported workspace", async () => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "private.txt"), "must not deliver", "utf8");
    await symlink(outside, join(f.workspace, "linked"), "junction");
    f.manifest.delivery.files = ["linked/private.txt"];
    const { out, result } = await run(f);
    expect(result.code, result.stderr).toBe(12);
    expect((await receipt(out)).delivery.status).not.toBe("pass");
    await expect(stat(join(out, "tasks", "one", "artifacts", "linked", "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports all planned tasks, preserves unknown receipts, separates cohorts and records self-reported notes", async () => {
    const f = await fixture();
    f.manifest.tasks = ["one", "two", "three"].map((key) => ({ key, title: key, description: "deterministic measurement fixture" }));
    const first = await run(f, "cohort-first");
    expect(first.result.code, first.result.stderr).toBe(0);
    await unlink(join(first.out, "tasks", "two", "receipt.json"));
    await unlink(join(first.out, "tasks", "three", "receipt.json"));
    for (const kind of ["review", "repair"]) {
      const note = await cli(["note", "--dir", first.out, "--task", "one", "--kind", kind, "--reason", "self-reported test note"]);
      expect(note.code, note.stderr).toBe(0);
    }
    f.manifest.tasks = [{ key: "injected", title: "injected", description: "fault injection fixture, not real repair" }];
    f.manifest.workloadKind = "fault-injection";
    const second = await run(f, "cohort-second");
    expect(second.result.code, second.result.stderr).toBe(0);
    const result = await cli(["report", "--dir", f.root]);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Json;
    expect(report.schema).toBe("zigma.ops.report/1");
    expect(report.groups).toHaveLength(2);
    const group = report.groups.find((item: Json) => item.workloadKind === "deterministic");
    expect(group).toMatchObject({ planned: 3, attempted: 1, accepted: 1, delivered: 1, unknown: 2, recordedInterventions: 1, recordedReviews: 1, acceptanceRate: 1, deliveryRate: 1 / 3 });
    expect(report.groups.find((item: Json) => item.workloadKind === "fault-injection")).toMatchObject({ planned: 1, accepted: 1, delivered: 1, unknown: 0 });
    const bad = await receipt(first.out);
    bad.key = "wrong-key";
    await writeFile(join(first.out, "tasks", "one", "receipt.json"), JSON.stringify(bad), "utf8");
    expect((await cli(["report", "--dir", first.out])).code).toBe(12);
  });
});
