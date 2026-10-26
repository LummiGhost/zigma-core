import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";
import {
  MAX_ARTIFACT_BYTES,
  MAX_CAPTURE_BYTES,
  OPS_MANIFEST_SCHEMA,
  OPS_PLAN_SCHEMA,
  OPS_RECEIPT_SCHEMA,
  OPS_RUN_SCHEMA,
  OpsError,
  OpsManifestSchema,
  OpsPlanSchema,
  OpsReceiptSchema,
  errorMessage,
  highestPriorityExit,
  isSafeHostPath,
  isSafeRelativePath,
  isSemver,
  parseLocalCoreUrl,
  relativePathKey,
  type OpsExitCode,
  type OpsFreezeEntry,
  type OpsManifest,
  type OpsPlan,
  type OpsReceipt,
  type OpsRunOutput,
  type OpsTaskSpec
} from "./schema.js";
import { packageVersion } from "../version.js";
import { runOwnedCommand } from "./command.js";

/**
 * Standard operations runner: sequential, HTTP-only task driving with
 * independent acceptance and receipt-copy delivery. It never spawns or kills
 * Core, never edits task state files and never merges or pushes code.
 */

const API_TIMEOUT_MS = 30_000;
const ACCEPTANCE_DEFAULT_TIMEOUT_MS = 300_000;
const POLL_FAILURE_LIMIT = 20;

const TERMINAL_COMMAND = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_FLOW = new Set(["completed", "failed", "cancelled"]);

export interface OpsRunOptions {
  manifestPath: string;
  outPath: string;
}

interface FreezeState {
  entry: OpsFreezeEntry;
  absolutePath: string;
}

interface LeaseState {
  path: string;
  token: string;
  engaged: boolean;
  released: boolean;
}

interface StepsState {
  lease?: LeaseState;
  freezes: FreezeState[];
  /** True while a provider invocation may still be live or ambiguous. */
  providerPending: boolean;
}

type FreezeCheck = { ok: boolean; reason?: string };
type FreezeChecker = () => Promise<FreezeCheck>;

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isWithin(root: string, target: string): boolean {
  const rootPrefix = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(rootPrefix);
}

/** Output paths are checked component by component, including existing ancestors. */
async function ensureOutputDirectory(ownerRoot: string, directory: string): Promise<string> {
  if (!isWithin(ownerRoot, directory)) throw new OpsError("output directory escapes batch root", 12);
  const rootInfo = await lstat(ownerRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new OpsError("batch root must be a real directory", 12);
  const realRoot = await realpath(ownerRoot);
  let cursor = ownerRoot;
  for (const part of relative(ownerRoot, directory).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try { await mkdir(cursor); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(realRoot, await realpath(cursor))) {
      throw new OpsError("output path contains a symlink or escapes batch root", 12);
    }
  }
  return realpath(directory);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseWith<T>(schema: ZodType<T>, value: unknown, label: string, exitCode: OpsExitCode = 12): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new OpsError(`${label} failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`, exitCode);
  }
  return parsed.data;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function bounded(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_CAPTURE_BYTES) return text;
  return Buffer.from(text, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
}

function clip(text: string, max = 8000): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

async function writeExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function taskDir(outDir: string, key: string): string {
  return join(outDir, "tasks", key);
}

async function readManifest(manifestPath: string): Promise<{ manifest: OpsManifest; bytes: Buffer; baseDir: string }> {
  const absolute = resolve(manifestPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new OpsError(`cannot read manifest ${absolute}: ${errorMessage(error)}`, 12);
  }
  const json = parseJson(bytes.toString("utf8"));
  if (json === undefined) throw new OpsError("manifest is not valid JSON", 12);
  const manifest = parseWith(OpsManifestSchema, json, "manifest");
  return { manifest, bytes, baseDir: dirname(absolute) };
}

/** Resolve a manifest host path: absolute paths are honoured, relative ones use the manifest directory. */
function resolveHostPath(baseDir: string, value: string): string {
  if (!isSafeHostPath(value)) throw new OpsError(`unsafe host path: ${value}`, 12);
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

/** Freeze a host file: final component must be a regular file (symlinks rejected). */
async function freezeHostFile(absolutePath: string, label: string): Promise<FreezeState> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    throw new OpsError(`frozen file missing: ${label} (${errorMessage(error)})`, 12);
  }
  if (info.isSymbolicLink()) throw new OpsError(`frozen file must not be a symlink: ${label}`, 12);
  if (!info.isFile()) throw new OpsError(`frozen file must be a regular file: ${label}`, 12);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    throw new OpsError(`frozen file unreadable: ${label} (${errorMessage(error)})`, 12);
  }
  return { entry: { path: label, sha256: sha256(bytes) }, absolutePath };
}

async function verifyFreezes(freezes: readonly FreezeState[]): Promise<FreezeCheck> {
  for (const freeze of freezes) {
    try {
      const info = await lstat(freeze.absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: `frozen input is no longer a regular file: ${freeze.entry.path}` };
      const current = sha256(await readFile(freeze.absolutePath));
      if (current !== freeze.entry.sha256) return { ok: false, reason: `frozen input changed: ${freeze.entry.path}` };
    } catch (error) {
      return { ok: false, reason: `frozen input unreadable: ${freeze.entry.path} (${errorMessage(error)})` };
    }
  }
  return { ok: true };
}

/** Absolute profile command resolved to an existing regular file (Windows command extensions supported). */
async function resolveProfileCommand(command: string): Promise<string> {
  if (!isAbsolute(command)) throw new OpsError(`provider command must be an absolute path: ${command}`, 12);
  const candidates = [command];
  if (process.platform === "win32" && !/\.(?:cmd|exe|bat|com)$/i.test(command)) {
    for (const extension of [".cmd", ".exe", ".bat"]) candidates.push(`${command}${extension}`);
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new OpsError(`provider command is not an absolute regular file: ${command}`, 12);
}

async function hashCommandFile(command: string): Promise<OpsFreezeEntry> {
  let real: string;
  try {
    real = await realpath(command);
  } catch (error) {
    throw new OpsError(`provider command unreadable: ${command} (${errorMessage(error)})`, 12);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new OpsError(`provider command is not a regular file: ${command}`, 12);
  return { path: command, sha256: sha256(await readFile(real)) };
}

function acquireLease(lease: LeaseState): void {
  // Exclusive create without pre-creating parent directories; an active lock is never modified.
  const fd = openSync(lease.path, "wx");
  try {
    const payload = JSON.stringify({ token: lease.token, runId: lease.token, pid: process.pid, createdAt: nowIso() });
    writeSync(fd, payload);
  } finally {
    closeSync(fd);
  }
  lease.engaged = true;
}

async function releaseLease(lease: LeaseState): Promise<void> {
  if (!lease.engaged || lease.released) return;
  try {
    const record = asRecord(parseJson(await readFile(lease.path, "utf8")));
    if (!record || record["token"] !== lease.token) return;
    await rm(lease.path);
    lease.released = true;
  } catch {
    // Never remove a lock we cannot prove is ours.
  }
}

class CoreClient {
  constructor(private readonly origin: string) {}

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const init: RequestInit = {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.origin}${path}`, init);
    const text = await response.text();
    const data = text.length === 0 ? undefined : parseJson(text);
    return { status: response.status, data };
  }

  envelope(data: unknown): unknown {
    const record = asRecord(data);
    return record && "data" in record ? record["data"] : data;
  }
}

async function checkProvider(kind: "flow" | "workspace", command: string, environment: Record<string, string>, state: StepsState, timeoutMs: number): Promise<string> {
  const base = { env: environment, timeoutMs, maxBuffer: MAX_CAPTURE_BYTES };
  const versionResult = await runOwnedCommand(command, ["--version"], base);
  if (versionResult.unknown) {
    state.providerPending = true;
    throw new OpsError(`${kind} version command outcome unknown (PID ${versionResult.pid ?? "unreported"}); lease retained`, 11);
  }
  const rawVersion = String(versionResult.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  if (versionResult.exitCode !== 0 || !isSemver(rawVersion)) {
    throw new OpsError(`${kind} provider --version failed or is not semver`, 12);
  }
  const infoResult = await runOwnedCommand(command, ["contract-info", "--json"], base);
  if (infoResult.unknown) {
    state.providerPending = true;
    throw new OpsError(`${kind} handshake command outcome unknown (PID ${infoResult.pid ?? "unreported"}); lease retained`, 11);
  }
  if (infoResult.exitCode !== 0) throw new OpsError(`${kind} provider contract-info failed`, 12);
  const record = asRecord(parseJson(String(infoResult.stdout ?? "")));
  if (!record) throw new OpsError(`${kind} provider contract-info is not a JSON object`, 12);
  if (kind === "flow") {
    if (record["contractVersion"] !== 1) throw new OpsError("flow provider contractVersion must be 1", 12);
    if (record["provider"] !== "zigma-flow") throw new OpsError("flow provider identity mismatch", 12);
    if (record["packageVersion"] !== rawVersion) throw new OpsError("flow provider versions disagree", 12);
  } else {
    const data = asRecord(record["data"]);
    if (record["ok"] !== true || !data) throw new OpsError("workspace provider envelope invalid", 12);
    if (data["contract_version"] !== 1) throw new OpsError("workspace provider contract_version must be 1", 12);
    if (data["provider"] !== "zigma-workspace") throw new OpsError("workspace provider identity mismatch", 12);
    if (data["package_version"] !== rawVersion) throw new OpsError("workspace provider versions disagree", 12);
    if (data["managed_supported"] !== true) throw new OpsError("workspace provider does not advertise managed_supported", 12);
  }
  return rawVersion;
}

/** Acceptance working directory: explicit operator cwd (absolute or manifest-relative) or the workspace. */
async function resolveAcceptanceCwd(manifestCwd: string | undefined, baseDir: string, workspacePath: string): Promise<string> {
  const candidate = manifestCwd === undefined ? workspacePath : resolveHostPath(baseDir, manifestCwd);
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    throw new OpsError(`acceptance cwd missing: ${candidate} (${errorMessage(error)})`, 12);
  }
  if (info.isSymbolicLink()) throw new OpsError(`acceptance cwd must not be a symlink: ${candidate}`, 12);
  if (!info.isDirectory()) throw new OpsError(`acceptance cwd must be a directory: ${candidate}`, 12);
  try {
    const realInfo = await stat(await realpath(candidate));
    if (!realInfo.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new OpsError(`acceptance cwd unavailable: ${candidate} (${errorMessage(error)})`, 12);
  }
  return candidate;
}

interface ReceiptBase {
  runId: string;
  key: string;
  startedAt?: string;
}

type ReceiptFields = Partial<Omit<OpsReceipt, "schema" | "runId" | "key" | "executionStatus">>;

/** Build a fully-formed receipt with defaults; the overrides object is spread exactly once. */
function makeReceipt(base: ReceiptBase, elapsedMs: number, overrides: ReceiptFields & { executionStatus: string }): OpsReceipt {
  const defaults: OpsReceipt = {
    schema: OPS_RECEIPT_SCHEMA,
    runId: base.runId,
    key: base.key,
    status: "blocked",
    executionStatus: overrides.executionStatus,
    acceptance: { status: "not_run" },
    delivery: { status: "not_run", artifacts: [] },
    providerQuiescent: false,
    finishedAt: nowIso(),
    elapsedMs,
    attempted: false,
    ...(base.startedAt !== undefined ? { startedAt: base.startedAt } : {})
  };
  return Object.assign(defaults, overrides, {
    schema: OPS_RECEIPT_SCHEMA,
    runId: base.runId,
    key: base.key,
    executionStatus: overrides.executionStatus,
    finishedAt: nowIso()
  });
}

function withReason(value: string): { reason: string } {
  return { reason: clip(value) };
}

interface Evaluation {
  receipt: OpsReceipt;
  exitCode: OpsExitCode;
  quiescent: boolean;
  attempted: boolean;
  mutationDetected: boolean;
}

export async function runOps(options: OpsRunOptions): Promise<{ output: OpsRunOutput; exitCode: OpsExitCode }> {
  const outDir = resolve(options.outPath);
  const state: StepsState = { freezes: [], providerPending: false };
  let result: { output: OpsRunOutput; exitCode: OpsExitCode } | undefined;
  let pendingError: unknown;
  try {
    result = await executeBatch(options, outDir, state);
  } catch (error) {
    pendingError = error;
  }
  // Fail closed: while provider quiescence is unproven the lease is retained.
  if (state.lease && !state.providerPending) {
    await releaseLease(state.lease);
  }
  if (pendingError !== undefined) throw pendingError;
  if (result === undefined) throw new OpsError("operations run ended without a result", 12);
  return result;
}

async function executeBatch(options: OpsRunOptions, outDir: string, state: StepsState): Promise<{ output: OpsRunOutput; exitCode: OpsExitCode }> {
  // 1. Validate manifest and host files before any output or network side effect.
  const loaded = await readManifest(options.manifestPath);
  const manifest = loaded.manifest;
  if (manifest.schema !== OPS_MANIFEST_SCHEMA) throw new OpsError("unsupported manifest schema", 12);
  const coreUrl = parseLocalCoreUrl(manifest.coreUrl);
  if (!coreUrl) throw new OpsError("coreUrl is not a local loopback origin", 12);

  for (const file of manifest.freezeFiles) {
    state.freezes.push(await freezeHostFile(resolveHostPath(loaded.baseDir, file), file));
  }
  if (!state.freezes.some((freeze) => freeze.entry.path === manifest.workflowRef)) {
    // Workflow/checker/policy assets are always frozen, even if not listed explicitly.
    state.freezes.push(await freezeHostFile(resolveHostPath(loaded.baseDir, manifest.workflowRef), manifest.workflowRef));
  }
  const leasePath = resolveHostPath(loaded.baseDir, manifest.suiteLeaseFile);
  const freezeCheck: FreezeChecker = () => verifyFreezes(state.freezes);

  const before = await freezeCheck();
  if (!before.ok) throw new OpsError(before.reason ?? "frozen input changed", 12);

  // 2. Exclusive output directory; an existing batch is never overwritten or replayed.
  try {
    await mkdir(outDir, { recursive: false });
  } catch (error) {
    throw new OpsError(`output directory must not exist and must be creatable: ${outDir} (${errorMessage(error)})`, 12);
  }

  const runId = `ops-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID()}`;
  // Lease before provider commands: a cooperating updater cannot replace the
  // installed suite between its handshake and the first task dispatch.
  const lease: LeaseState = { path: leasePath, token: `${runId}:${process.pid}`, engaged: false, released: false };
  state.lease = lease;
  try {
    acquireLease(lease);
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new OpsError(`suite lease is active: ${leasePath}`, 12);
    throw new OpsError(`cannot acquire suite lease: ${leasePath} (${errorMessage(error)})`, 12);
  }
  const client = new CoreClient(coreUrl.origin);

  // 3. Server identity, project and profile preflight.
  const healthRaw = await client.request("GET", "/health");
  const health = asRecord(healthRaw.data);
  if (healthRaw.status < 200 || healthRaw.status >= 300 || !health || health["ok"] !== true || health["service"] !== "zigma-core" || !isSemver(health["version"])) {
    throw new OpsError("health endpoint did not identify a zigma-core server with a semver version", 11);
  }
  const serverVersion = health["version"];

  let projectView: Record<string, unknown>;
  let profileView: Record<string, unknown>;
  try {
    projectView = asRecord(client.envelope((await client.request("GET", `/v1/projects/${encodeURIComponent(manifest.projectId)}`)).data)) ?? {};
    if (typeof projectView["id"] !== "string") throw new Error("project view missing id");
    const profileId = projectView["executionProfileId"];
    if (typeof profileId !== "string" || profileId.length === 0) throw new Error("project has no execution profile");
    profileView = asRecord(client.envelope((await client.request("GET", `/v1/execution-profiles/${encodeURIComponent(profileId)}`)).data)) ?? {};
    if (typeof profileView["id"] !== "string") throw new Error("execution profile view missing id");
  } catch (error) {
    throw new OpsError(`preflight fetch failed: ${errorMessage(error)}`, 11);
  }

  const workspacePolicy = asRecord(projectView["workspacePolicy"]) ?? {};
  if (workspacePolicy["cleanup"] !== "manual" || workspacePolicy["provider"] !== "zigma-workspace-cli") {
    throw new OpsError("local receipt-copy mode requires workspacePolicy.cleanup='manual' and workspacePolicy.provider='zigma-workspace-cli'", 12);
  }
  const flowCommandRaw = asString(profileView["flowCommand"]);
  const workspaceCommandRaw = asString(profileView["workspaceCommand"]);
  if (!flowCommandRaw || !workspaceCommandRaw) throw new OpsError("profile flowCommand/workspaceCommand missing", 12);
  const flowCommand = await resolveProfileCommand(flowCommandRaw);
  const workspaceCommand = await resolveProfileCommand(workspaceCommandRaw);

  const environment = asRecord(profileView["environment"]) ?? {};
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") childEnv[key] = value;
  for (const [key, value] of Object.entries(environment)) if (typeof value === "string") childEnv[key] = value;

  // 4. Provider contract checks (profile environment used only for children, never stored or printed).
  const flowHash = await hashCommandFile(flowCommand);
  const workspaceHash = await hashCommandFile(workspaceCommand);
  state.freezes.push({ entry: flowHash, absolutePath: await realpath(flowCommand) });
  state.freezes.push({ entry: workspaceHash, absolutePath: await realpath(workspaceCommand) });
  const flowVersion = await checkProvider("flow", flowCommand, childEnv, state, manifest.preflightTimeoutMs);
  const workspaceVersion = await checkProvider("workspace", workspaceCommand, childEnv, state, manifest.preflightTimeoutMs);

  const afterProviders = await freezeCheck();
  if (!afterProviders.ok) throw new OpsError(afterProviders.reason ?? "frozen input changed", 12);

  const policyHash = sha256(stableStringify({
    clientVersion: packageVersion,
    execution: {
      backend: manifest.backend,
      timeoutMs: manifest.timeoutMs,
      pollIntervalMs: manifest.pollIntervalMs,
      cancelGraceMs: manifest.cancelGraceMs,
      preflightTimeoutMs: manifest.preflightTimeoutMs,
      capabilities: manifest.callerContext.capabilities,
      constraints: manifest.callerContext.constraints,
      profileTimeoutMs: profileView["timeoutMs"],
      executionPolicy: profileView["executionPolicy"],
      workspacePolicy
    },
    freeze: state.freezes.map((freeze) => freeze.entry).sort((a, b) => a.path.localeCompare(b.path)),
    acceptance: {
      command: manifest.acceptance.command,
      args: manifest.acceptance.args,
      cwd: manifest.acceptance.cwd ?? null,
      timeoutMs: manifest.acceptance.timeoutMs ?? null
    },
    delivery: { files: manifest.delivery.files }
  }));

  // 6. Durable plan before any task POST.
  const plan: OpsPlan = {
    schema: OPS_PLAN_SCHEMA,
    runId,
    createdAt: nowIso(),
    manifestHash: sha256(loaded.bytes),
    cohort: manifest.cohort,
    workloadKind: manifest.workloadKind,
    proposalFreedom: manifest.proposalFreedom,
    modelRoute: manifest.modelRoute,
    modelRouteSource: "operator",
    workflowRef: manifest.workflowRef,
    policyHash,
    suite: { core: serverVersion, flow: flowVersion, workspace: workspaceVersion },
    freeze: state.freezes.map((freeze) => freeze.entry),
    tasks: manifest.tasks.map((task) => ({ key: task.key, title: task.title })),
    providerCommands: { flow: flowHash, workspace: workspaceHash },
    clientVersion: packageVersion
  };
  parseWith(OpsPlanSchema, plan, "plan");
  await writeExclusive(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  await mkdir(join(outDir, "tasks"), { recursive: true });

  // 7. Sequential dispatch; later tasks stop when freezes mutate or provider truth is unknown.
  const results: OpsReceipt[] = [];
  const codes: OpsExitCode[] = [];
  let stopDispatch = false;
  for (const spec of manifest.tasks) {
    if (stopDispatch) break;
    const dispatchFreeze = await freezeCheck();
    if (!dispatchFreeze.ok) {
      const receipt = makeReceipt({ runId, key: spec.key }, 0, {
        status: "blocked",
        executionStatus: "not_started",
        attempted: false,
        providerQuiescent: true,
        exitCode: 12,
        ...withReason(`frozen input mutated before dispatch: ${dispatchFreeze.reason ?? "unknown"}`)
      });
      await persistReceipt(outDir, receipt);
      results.push(receipt);
      codes.push(12);
      break;
    }
    // A thrown IO/HTTP error after a POST must not unlock a potentially live run.
    state.providerPending = true;
    const evaluation = await executeTask({ manifest, spec, runId, outDir, baseDir: loaded.baseDir, client, runEnv: childEnv, freezeCheck });
    state.providerPending = !evaluation.quiescent;
    const finalized = finalizeReceipt(evaluation);
    await persistReceipt(outDir, finalized);
    results.push(finalized);
    codes.push(finalized.exitCode ?? 11);
    if (!evaluation.quiescent) state.providerPending = true;
    if (!evaluation.quiescent || evaluation.mutationDetected) stopDispatch = true;
  }

  const finalFreeze = await freezeCheck();
  if (!finalFreeze.ok) codes.push(12);
  const exitCode = highestPriorityExit(codes);
  const output: OpsRunOutput = { schema: OPS_RUN_SCHEMA, runId, outDir, exitCode, results };
  await ensureOutputDirectory(outDir, outDir);
  await writeAtomic(join(outDir, "run.json"), `${JSON.stringify(output, null, 2)}\n`);
  return { output, exitCode };
}

function finalizeReceipt(evaluation: Evaluation): OpsReceipt {
  return parseWith(
    OpsReceiptSchema,
    { ...evaluation.receipt, providerQuiescent: evaluation.quiescent, attempted: evaluation.attempted, exitCode: evaluation.exitCode },
    "receipt"
  );
}

async function persistReceipt(outDir: string, receipt: OpsReceipt): Promise<void> {
  const path = join(taskDir(outDir, receipt.key), "receipt.json");
  await ensureOutputDirectory(outDir, dirname(path));
  try {
    await writeExclusive(path, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new OpsError(`receipt already exists for ${receipt.key}; refusing to overwrite`, 12);
    throw error;
  }
}

interface TaskRunContext {
  manifest: OpsManifest;
  spec: OpsTaskSpec;
  runId: string;
  outDir: string;
  baseDir: string;
  client: CoreClient;
  runEnv: Record<string, string>;
  freezeCheck: FreezeChecker;
}

interface TaskView {
  task: Record<string, unknown>;
  activeFlowRun: Record<string, unknown> | undefined;
  flowRuns: Record<string, unknown>[];
  executionCommand: Record<string, unknown> | undefined;
  workspace: Record<string, unknown> | undefined;
}

function readTaskView(raw: unknown): TaskView | undefined {
  const view = asRecord(raw);
  if (!view) return undefined;
  const task = asRecord(view["task"]);
  if (!task) return undefined;
  const flowRuns: Record<string, unknown>[] = [];
  if (Array.isArray(view["flowRuns"])) {
    for (const run of view["flowRuns"]) {
      const record = asRecord(run);
      if (record) flowRuns.push(record);
    }
  }
  return {
    task,
    activeFlowRun: asRecord(view["activeFlowRun"]),
    flowRuns,
    executionCommand: asRecord(view["executionCommand"]),
    workspace: asRecord(view["workspace"])
  };
}

function commandStatus(view: TaskView | undefined): string | undefined {
  return asString(view?.executionCommand?.["status"]);
}

function activeFlow(view: TaskView): Record<string, unknown> | undefined {
  return view.activeFlowRun ?? view.flowRuns[view.flowRuns.length - 1];
}

function flowStatus(view: TaskView | undefined): string | undefined {
  if (!view) return undefined;
  return asString(activeFlow(view)?.["status"]);
}

function commandQuiescent(view: TaskView | undefined): boolean {
  const response = asRecord(view?.executionCommand?.["providerResponse"]);
  return response?.["quiescent"] === true;
}

/** Normal completion is persisted after invoke returns, not merely on a callback. */
function invokeQuiescent(executionStatus: string | undefined, view: TaskView | undefined): boolean {
  return (executionStatus === "completed" || executionStatus === "failed")
    && isTerminal(view) && flowStatus(view) === executionStatus;
}

/** Cancelled is quiescent only with explicit provider proof. */
function cancelledQuiescent(executionStatus: string | undefined, view: TaskView | undefined): boolean {
  return executionStatus === "cancelled" && commandQuiescent(view);
}

function isTerminal(view: TaskView | undefined): boolean {
  if (!view) return false;
  const command = commandStatus(view);
  const flow = flowStatus(view);
  return command !== undefined && TERMINAL_COMMAND.has(command) && flow !== undefined && TERMINAL_FLOW.has(flow);
}

function identifiers(view: TaskView | undefined): ReceiptFields {
  const result: ReceiptFields = {};
  if (!view) return result;
  const flowRunId = asString(activeFlow(view)?.["id"]);
  if (flowRunId !== undefined) result.flowRunId = flowRunId;
  const commandId = asString(view.executionCommand?.["id"]);
  if (commandId !== undefined) result.executionCommandId = commandId;
  const workspacePath = asString(view.workspace?.["path"]);
  if (workspacePath !== undefined) result.workspacePath = workspacePath;
  return result;
}

async function readView(context: TaskRunContext, taskId: string): Promise<TaskView | undefined> {
  try {
    const response = await context.client.request("GET", `/v1/tasks/${encodeURIComponent(taskId)}`);
    if (response.status < 200 || response.status >= 300) return undefined;
    return readTaskView(context.client.envelope(response.data));
  } catch {
    return undefined;
  }
}

async function executeTask(context: TaskRunContext): Promise<Evaluation> {
  const { manifest, spec, runId, outDir } = context;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const dir = taskDir(outDir, spec.key);
  await ensureOutputDirectory(outDir, dir);
  const progressPath = join(dir, "progress.json");
  const writeProgress = async (progress: Record<string, unknown>): Promise<void> => {
    progress["updatedAt"] = nowIso();
    await ensureOutputDirectory(outDir, dir);
    await writeAtomic(progressPath, `${JSON.stringify(progress, null, 2)}\n`).catch(() => undefined);
  };
  const progress: Record<string, unknown> = { key: spec.key, runId, phase: "creating" };
  await writeProgress(progress);

  const base: ReceiptBase = { runId, key: spec.key, startedAt };
  const elapsed = () => Date.now() - startedMs;
  const evaluate = (
    fields: ReceiptFields & { executionStatus: string },
    exitCode: OpsExitCode,
    quiescent: boolean,
    attempted: boolean,
    mutationDetected = false
  ): Evaluation => ({ receipt: makeReceipt(base, elapsed(), fields), exitCode, quiescent, attempted, mutationDetected });

  // Create the task. A POST error after submission is ambiguous: no retry, later dispatch stops.
  let create: { status: number; data: unknown };
  try {
    create = await context.client.request("POST", "/v1/tasks", {
      projectId: manifest.projectId,
      title: spec.title,
      description: spec.description,
      source: { kind: "cli", metadata: {} },
      createdBy: manifest.callerContext.actor,
      labels: [],
      metadata: { runId, key: spec.key }
    });
  } catch (error) {
    progress["phase"] = "create_unknown";
    await writeProgress(progress);
    return evaluate({ status: "blocked", executionStatus: "create_unknown", ...withReason(`task creation outcome uncertain, not retried: ${errorMessage(error)}`) }, 11, false, false);
  }
  const created = asRecord(context.client.envelope(create.data));
  const taskId = asString(created?.["id"]);
  if (create.status < 200 || create.status >= 300 || !taskId) {
    progress["phase"] = "create_failed";
    await writeProgress(progress);
    return evaluate({ status: "blocked", executionStatus: "create_failed", ...withReason(`task creation rejected with status ${create.status}`) }, 11, false, false);
  }
  progress["taskId"] = taskId;
  progress["phase"] = "created";
  await writeProgress(progress);

  const idempotencyKey = `${runId}:${spec.key}`;
  const startPayload = {
    idempotencyKey,
    workflowRef: manifest.workflowRef,
    backend: manifest.backend,
    callerContext: manifest.callerContext,
    inputs: spec.inputs ?? {},
    dryRun: false
  };
  const known: ReceiptFields = { taskId };

  // Freeze recheck immediately before dispatch.
  const preDispatch = await context.freezeCheck();
  if (!preDispatch.ok) {
    progress["phase"] = "frozen_before_dispatch";
    await writeProgress(progress);
    return evaluate(
      { ...known, status: "blocked", executionStatus: "not_started", providerQuiescent: true, ...withReason(`frozen input mutated before dispatch: ${preDispatch.reason ?? "unknown"}`) },
      12,
      true,
      false,
      true
    );
  }
  progress["dispatchIntent"] = { idempotencyKey, at: nowIso() };
  progress["phase"] = "dispatching";
  await writeProgress(progress);

  let start: { status: number; data: unknown };
  try {
    start = await context.client.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/start`, startPayload);
  } catch (error) {
    progress["phase"] = "dispatch_unknown";
    await writeProgress(progress);
    return evaluate({ ...known, status: "blocked", executionStatus: "dispatch_unknown", ...withReason(`start submission uncertain: ${errorMessage(error)}`) }, 11, false, true);
  }
  if (start.status < 200 || start.status >= 300) {
    const startView = readTaskView(context.client.envelope(start.data));
    const status = commandStatus(startView) ?? "start_rejected";
    progress["phase"] = "start_rejected";
    progress["startStatus"] = start.status;
    await writeProgress(progress);
    const rejected = startView ?? (await readView(context, taskId));
    return evaluate(
      { ...known, ...identifiers(rejected), status: "failed", executionStatus: status, ...withReason(`task start rejected with status ${start.status}`) },
      10,
      invokeQuiescent(status, rejected),
      true
    );
  }

  let view = readTaskView(context.client.envelope(start.data)) ?? (await readView(context, taskId));
  progress["phase"] = "running";
  progress["taskStatus"] = asString(view?.task["status"]);
  await writeProgress(progress);

  const deadline = startedMs + manifest.timeoutMs;
  let cancelDeadline: number | undefined;
  let pollFailures = 0;

  for (;;) {
    if (view && isTerminal(view)) break;
    if (view && flowStatus(view) === "awaiting_human") {
      return evaluate({ ...known, ...identifiers(view), status: "blocked", executionStatus: "awaiting_human", ...withReason("awaiting human decision; provider is still live") }, 11, false, true);
    }
    const now = Date.now();
    if (cancelDeadline !== undefined && now >= cancelDeadline) {
      progress["phase"] = "cancel_unconfirmed";
      await writeProgress(progress);
      return evaluate(
        { ...known, ...identifiers(view), status: "blocked", executionStatus: commandStatus(view) ?? "cancel_unconfirmed", ...withReason("cancellation not confirmed quiescent within cancelGraceMs") },
        11,
        false,
        true
      );
    }
    if (cancelDeadline === undefined && now >= deadline) {
      cancelDeadline = now + manifest.cancelGraceMs;
      progress["phase"] = "cancel_requested";
      await writeProgress(progress);
      try {
        await context.client.request("POST", `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { reason: `ops timeout after ${manifest.timeoutMs}ms` });
      } catch {
        // Sent at most once; quiescence stays unproven until a terminal view proves it.
      }
    }
    if (pollFailures >= POLL_FAILURE_LIMIT) {
      progress["phase"] = "poll_unknown";
      await writeProgress(progress);
      return evaluate({ ...known, ...identifiers(view), status: "blocked", executionStatus: "poll_unknown", ...withReason("task state unavailable while polling") }, 11, false, true);
    }
    await delay(manifest.pollIntervalMs);
    const next = await readView(context, taskId);
    if (!next) {
      pollFailures += 1;
      continue;
    }
    pollFailures = 0;
    view = next;
    progress["taskStatus"] = asString(view.task["status"]);
    await writeProgress(progress);
  }

  const finalView = view as TaskView;
  const executionStatus = commandStatus(finalView) ?? "unknown";
  const flow = flowStatus(finalView) ?? "unknown";
  const workspacePath = asString(finalView.workspace?.["path"]);
  progress["phase"] = "terminal";
  progress["executionStatus"] = executionStatus;
  progress["flowStatus"] = flow;
  await writeProgress(progress);

  const knownFinal: ReceiptFields = {
    ...known,
    ...identifiers(finalView),
    ...(workspacePath !== undefined ? { workspacePath } : {})
  };

  // Provider is terminal here; a mutation that happened during the invocation still blocks later dispatch.
  const finalCheck = await context.freezeCheck();

  if (executionStatus === "cancelled" || flow === "cancelled") {
    const quiescent = cancelledQuiescent(executionStatus, finalView);
    return evaluate(
      { ...knownFinal, status: "blocked", executionStatus, ...withReason("task cancelled; not a product success") },
      11,
      quiescent,
      true,
      !finalCheck.ok
    );
  }

  const quiescent = invokeQuiescent(executionStatus, finalView);
  if (executionStatus === "failed" || flow === "failed") {
    return evaluate({ ...knownFinal, status: "failed", executionStatus, ...withReason("execution failed") }, 10, quiescent, true, !finalCheck.ok);
  }
  if (executionStatus !== "completed" || flow !== "completed" || !quiescent) {
    return evaluate({ ...knownFinal, status: "blocked", executionStatus, ...withReason("execution completion or provider quiescence not established") }, 11, quiescent, true, !finalCheck.ok);
  }

  // Acceptance is independent of Flow completion; a mutated freeze blocks it entirely.
  if (!finalCheck.ok) {
    return evaluate(
      { ...knownFinal, status: "rejected", executionStatus, ...withReason(`frozen input mutated during execution: ${finalCheck.reason ?? "unknown"}`) },
      12,
      true,
      true,
      true
    );
  }
  if (workspacePath === undefined) {
    return evaluate({ ...knownFinal, status: "blocked", executionStatus, acceptance: { status: "blocked", reason: "task workspace path missing" }, ...withReason("workspace path missing for acceptance") }, 11, true, true);
  }
  let workspaceOk = false;
  try {
    const info = await lstat(workspacePath);
    workspaceOk = info.isDirectory() && !info.isSymbolicLink();
  } catch {
    workspaceOk = false;
  }
  if (!workspaceOk) {
    return evaluate({ ...knownFinal, status: "blocked", executionStatus, acceptance: { status: "blocked", reason: "workspace path unavailable" }, ...withReason("workspace unavailable for acceptance") }, 11, true, true);
  }
  let acceptanceCwd: string;
  try {
    acceptanceCwd = await resolveAcceptanceCwd(manifest.acceptance.cwd, context.baseDir, workspacePath);
  } catch (error) {
    const code = error instanceof OpsError ? error.exitCode : 12;
    return evaluate(
      { ...knownFinal, status: "rejected", executionStatus, acceptance: { status: "blocked", reason: clip(errorMessage(error)) }, ...withReason(`acceptance cwd invalid: ${errorMessage(error)}`) },
      code,
      true,
      true
    );
  }

  const acceptanceTimeout = manifest.acceptance.timeoutMs ?? ACCEPTANCE_DEFAULT_TIMEOUT_MS;
  let stdout = "";
  let stderr = "";
  let acceptanceExit: number | undefined;
  let timedOut = false;
  try {
    const result = await runOwnedCommand(manifest.acceptance.command, manifest.acceptance.args, {
      cwd: acceptanceCwd,
      timeoutMs: acceptanceTimeout,
      maxBuffer: MAX_CAPTURE_BYTES,
      env: {
        ...context.runEnv,
        ZIGMA_OPS_WORKSPACE: workspacePath,
        ZIGMA_OPS_TASK_ID: taskId,
        ZIGMA_OPS_OUT_DIR: outDir
      }
    });
    if (result.unknown) {
      progress["acceptancePid"] = result.pid;
      progress["phase"] = "acceptance_unknown";
      await writeProgress(progress);
      return evaluate({ ...knownFinal, status: "blocked", executionStatus, acceptance: { status: "blocked", reason: `acceptance outcome unknown (PID ${result.pid ?? "unreported"}); lease retained` } }, 11, false, true);
    }
    stdout = bounded(String(result.stdout ?? ""));
    stderr = bounded(String(result.stderr ?? ""));
    acceptanceExit = result.exitCode;
    timedOut = result.timedOut;
  } catch (error) {
    stderr = bounded(errorMessage(error));
  }
  await ensureOutputDirectory(outDir, dir);
  await writeFile(join(dir, "acceptance.stdout.log"), stdout, { encoding: "utf8", flag: "wx" }).catch(() => undefined);
  await writeFile(join(dir, "acceptance.stderr.log"), stderr, { encoding: "utf8", flag: "wx" }).catch(() => undefined);

  const parsed = asRecord(parseJson(stdout.trim()));
  const declared = parsed?.["status"];
  const declaredReason = asString(parsed?.["reason"]);
  const acceptance = (fallback: string, status: "fail" | "blocked" = "fail"): { status: "fail" | "blocked"; reason: string } => ({ status, reason: clip(declaredReason ?? fallback) });

  if (timedOut || acceptanceExit === undefined || !parsed || (declared !== "pass" && declared !== "fail" && declared !== "blocked")) {
    const why = timedOut
      ? "acceptance timed out"
      : acceptanceExit === undefined
        ? "acceptance process could not be started"
        : !parsed
          ? "acceptance stdout is not a JSON object"
          : "acceptance stdout lacks status pass|fail|blocked";
    return evaluate({ ...knownFinal, status: "rejected", executionStatus, acceptance: acceptance(why), ...withReason(why) }, 12, true, true);
  }
  if ((declared === "pass" && acceptanceExit !== 0) || (declared !== "pass" && acceptanceExit === 0)) {
    const why = "acceptance exit code and declared status disagree";
    return evaluate({ ...knownFinal, status: "rejected", executionStatus, acceptance: acceptance(why), ...withReason(why) }, 12, true, true);
  }
  if (declared === "fail") {
    return evaluate({ ...knownFinal, status: "rejected", executionStatus, acceptance: acceptance("acceptance declared fail"), ...withReason("acceptance failed") }, 10, true, true);
  }
  if (declared === "blocked") {
    return evaluate({ ...knownFinal, status: "blocked", executionStatus, acceptance: acceptance("acceptance declared blocked", "blocked"), ...withReason("acceptance blocked") }, 11, true, true);
  }

  // Freeze recheck after gates and before copying bytes.
  const afterGates = await context.freezeCheck();
  if (!afterGates.ok) {
    return evaluate(
      { ...knownFinal, status: "rejected", executionStatus, acceptance: { status: "pass" }, ...withReason(`frozen input mutated after gates: ${afterGates.reason ?? "unknown"}`) },
      12,
      true,
      true,
      true
    );
  }

  let artifacts: OpsReceipt["delivery"]["artifacts"];
  try {
    artifacts = await copyDelivery(workspacePath, join(dir, "artifacts"), manifest.delivery.files, outDir);
  } catch (error) {
    const contractFailure = error instanceof OpsError && error.exitCode === 12;
    return evaluate(
      { ...knownFinal, status: contractFailure ? "rejected" : "blocked", executionStatus, acceptance: { status: "pass" }, delivery: { status: "blocked", artifacts: [] }, ...withReason(`delivery failed: ${errorMessage(error)}`) },
      contractFailure ? 12 : 11,
      true,
      true
    );
  }

  const afterCopy = await context.freezeCheck();
  if (!afterCopy.ok) {
    // Retain partial artifacts for diagnosis; this receipt never authorizes delivery.
    return evaluate(
      { ...knownFinal, status: "rejected", executionStatus, acceptance: { status: "pass" }, ...withReason(`frozen input mutated during delivery: ${afterCopy.reason ?? "unknown"}`) },
      12,
      true,
      true,
      true
    );
  }

  return evaluate(
    { ...knownFinal, status: "delivered", executionStatus, acceptance: { status: "pass" }, delivery: { status: "pass", artifacts } },
    0,
    true,
    true
  );
}

interface CopiedArtifact {
  path: string;
  sha256: string;
  sizeBytes: number;
}

async function copyDelivery(workspacePath: string, artifactsDir: string, files: readonly string[], ownerRoot: string): Promise<CopiedArtifact[]> {
  const rootInfo = await lstat(workspacePath).catch(() => undefined);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new OpsError("workspace root must be a real directory", 12);
  let realWorkspace: string;
  try {
    realWorkspace = await realpath(workspacePath);
  } catch (error) {
    throw new OpsError(`workspace unavailable: ${errorMessage(error)}`, 11);
  }
  const realArtifacts = await ensureOutputDirectory(ownerRoot, artifactsDir);
  const artifacts: CopiedArtifact[] = [];
  for (const file of files) {
    if (!isSafeRelativePath(file)) throw new OpsError(`unsafe delivery path: ${file}`, 12);
    const segments = file.split(/[\\/]/);
    const recordPath = relativePathKey(file);
    // Walk every component (root included), rejecting symlinks/junctions and non-directories.
    let cursor = workspacePath;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      cursor = join(cursor, segment);
      const info = await lstat(cursor).catch(() => undefined);
      if (!info) throw new OpsError(`artifact missing: ${recordPath}`, 11);
      if (info.isSymbolicLink()) throw new OpsError(`symlink component in delivery path: ${recordPath}`, 12);
      const last = index === segments.length - 1;
      if (!last && !info.isDirectory()) throw new OpsError(`non-directory component in delivery path: ${recordPath}`, 12);
      if (last && !info.isFile()) throw new OpsError(`artifact is not a regular file: ${recordPath}`, 12);
    }
    const source = cursor;
    let realSource: string;
    try {
      realSource = await realpath(source);
    } catch (error) {
      throw new OpsError(`artifact missing: ${recordPath} (${errorMessage(error)})`, 11);
    }
    if (!isWithin(realWorkspace, realSource)) throw new OpsError(`artifact escapes workspace: ${recordPath}`, 12);
    const info = await stat(source);
    if (info.size > MAX_ARTIFACT_BYTES) throw new OpsError(`artifact exceeds 32MiB: ${recordPath}`, 12);
    const bytes = await readFile(source);
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new OpsError(`artifact exceeds 32MiB: ${recordPath}`, 12);
    const destination = join(artifactsDir, ...segments);
    if (!isWithin(artifactsDir, destination) || !isWithin(realArtifacts, resolve(destination))) {
      throw new OpsError(`destination escapes artifacts directory: ${recordPath}`, 12);
    }
    const realParent = await ensureOutputDirectory(ownerRoot, dirname(destination));
    if (!isWithin(realArtifacts, realParent)) throw new OpsError(`delivery parent escapes artifacts directory: ${recordPath}`, 12);
    await writeFile(destination, bytes, { flag: "wx" });
    artifacts.push({ path: recordPath, sha256: sha256(bytes), sizeBytes: bytes.length });
  }
  return artifacts;
}
