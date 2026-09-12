import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type {
  FlowCancelRequest,
  FlowCancelResult,
  FlowExecutor,
  FlowGateDecisionRequest,
  FlowReconcileRequest,
  FlowReconcileResult,
  FlowStartRequest,
  FlowStartResult
} from "../contracts/ports.js";
import type { FlowRunStatus } from "../contracts/schemas.js";
import { IntegrationError } from "../domain/errors.js";

const FLOW_CONTRACT_VERSION = 1;
const FLOW_PROVIDER = "zigma-flow";
const REQUIRED_FLOW_CAPABILITIES = [
  "caller-context-v1",
  "invoke-json-v1",
  "context-freeze-v1",
  "callback-envelope-v1",
  "callback-http-delivery-v1"
] as const;
const FLOW_INSPECT_CAPABILITY = "run-inspect-v1";

const VALID_STATUSES = new Set<string>([
  "created",
  "starting",
  "running",
  "awaiting_human",
  "completed",
  "failed",
  "cancelled"
]);

interface FlowInvokeEnvelope {
  contractVersion: number;
  runId: string;
  status: string;
  exitCode: number;
  pausedGate?: unknown;
  artifacts?: unknown[];
  eventLogUri?: string;
  error?: { message?: string };
}

interface FlowCommandEnvelope {
  contractVersion: number;
  command: string;
  status: "success" | "error";
  runId: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface FlowContractInfo {
  contractVersion: number;
  provider: string;
  packageVersion: string;
  capabilities: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractCacheKey(command: string, environment: Record<string, string>): string {
  return JSON.stringify([
    command,
    process.env["PATH"] ?? "",
    process.env["PATHEXT"] ?? "",
    Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
  ]);
}

function parseContractInfo(stdout: string, processExitCode: number): FlowContractInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new IntegrationError("zigma-flow contract-info returned invalid JSON", {
      stdoutTail: stdout.slice(-4_000),
      exitCode: processExitCode
    });
  }
  if (!isRecord(parsed)) {
    throw new IntegrationError("zigma-flow contract-info must return an object", { exitCode: processExitCode });
  }
  const info = parsed as unknown as FlowContractInfo;
  if (info.contractVersion !== FLOW_CONTRACT_VERSION) {
    throw new IntegrationError(
      `zigma-flow contract version mismatch: expected ${FLOW_CONTRACT_VERSION}, got ${String(info.contractVersion)}`,
      { contractVersion: info.contractVersion, expectedVersion: FLOW_CONTRACT_VERSION }
    );
  }
  if (info.provider !== FLOW_PROVIDER) {
    throw new IntegrationError(
      `zigma-flow provider mismatch: expected ${FLOW_PROVIDER}, got ${String(info.provider)}`,
      { provider: info.provider, expectedProvider: FLOW_PROVIDER }
    );
  }
  // Retain the provider's package version in the cached handshake for
  // diagnostics, but do not treat a patch/minor package release as a protocol
  // incompatibility. Provider identity, contract version, and capabilities
  // are the compatibility boundary.
  if (typeof info.packageVersion !== "string" || !info.packageVersion.trim()) {
    throw new IntegrationError("zigma-flow contract-info packageVersion must be a non-empty string", {
      packageVersion: info.packageVersion
    });
  }
  if (!Array.isArray(info.capabilities) || !info.capabilities.every((item) => typeof item === "string")) {
    throw new IntegrationError("zigma-flow contract-info capabilities must be a string array");
  }
  const missingCapabilities = REQUIRED_FLOW_CAPABILITIES.filter(
    (capability) => !(info.capabilities as string[]).includes(capability)
  );
  if (missingCapabilities.length > 0) {
    throw new IntegrationError("zigma-flow is missing required provider capabilities", {
      missingCapabilities,
      requiredCapabilities: [...REQUIRED_FLOW_CAPABILITIES]
    });
  }
  if (processExitCode !== 0) {
    throw new IntegrationError("zigma-flow contract-info command failed", { exitCode: processExitCode });
  }
  return info;
}

function parseInvokeJson(stdout: string, processExitCode: number): FlowStartResult {
  let envelope: FlowInvokeEnvelope;
  try {
    envelope = JSON.parse(stdout) as FlowInvokeEnvelope;
  } catch {
    throw new IntegrationError("zigma-flow --json output could not be parsed as JSON", {
      stdoutTail: stdout.slice(-4_000),
      exitCode: processExitCode
    });
  }

  if (envelope.contractVersion !== 1) {
    throw new IntegrationError(
      `zigma-flow --json contract version mismatch: expected 1, got ${envelope.contractVersion}`,
      { contractVersion: envelope.contractVersion, expectedVersion: 1 }
    );
  }

  if (!envelope.runId || typeof envelope.runId !== "string") {
    throw new IntegrationError("zigma-flow --json output missing required field: runId", {
      stdoutTail: stdout.slice(-4_000)
    });
  }

  if (!envelope.status || typeof envelope.status !== "string") {
    throw new IntegrationError("zigma-flow --json output missing required field: status", {
      stdoutTail: stdout.slice(-4_000)
    });
  }

  if (!VALID_STATUSES.has(envelope.status)) {
    throw new IntegrationError(
      `zigma-flow --json returned unknown status: ${envelope.status}`,
      { status: envelope.status, validStatuses: [...VALID_STATUSES] }
    );
  }

  const errorDetail = typeof envelope.error?.message === "string" && envelope.error.message.trim() !== ""
    ? `: ${envelope.error.message}`
    : "";

  return {
    externalRunId: envelope.runId,
    status: envelope.status as FlowRunStatus,
    exitCode: envelope.exitCode ?? processExitCode,
    summary: `zigma-flow run ${envelope.runId} finished with status ${envelope.status}${errorDetail}`,
    metadata: {
      pausedGate: envelope.pausedGate ?? null,
      artifacts: envelope.artifacts ?? [],
      eventLogUri: envelope.eventLogUri ?? null
    }
  };
}

function parseCommandJson(stdout: string, processExitCode: number, command: string): FlowCommandEnvelope {
  let envelope: FlowCommandEnvelope;
  try {
    envelope = JSON.parse(stdout) as FlowCommandEnvelope;
  } catch {
    throw new IntegrationError(`zigma-flow ${command} --json output could not be parsed as JSON`, {
      stdoutTail: stdout.slice(-4_000),
      exitCode: processExitCode
    });
  }
  if (envelope.contractVersion !== 1) {
    throw new IntegrationError(
      `zigma-flow ${command} contract version mismatch: expected 1, got ${String(envelope.contractVersion)}`,
      { contractVersion: envelope.contractVersion, expectedVersion: 1 }
    );
  }
  if (processExitCode !== 0 || envelope.status !== "success") {
    throw new IntegrationError(envelope.error?.message ?? `zigma-flow ${command} command failed`, {
      exitCode: processExitCode,
      providerCode: envelope.error?.code,
      details: envelope.error?.details,
      runId: envelope.runId
    });
  }
  return envelope;
}

function inspectReconciliationResult(
  stdout: string,
  processExitCode: number,
  request: FlowReconcileRequest
): FlowReconcileResult {
  let envelope: FlowCommandEnvelope;
  try {
    envelope = JSON.parse(stdout) as FlowCommandEnvelope;
  } catch {
    return {
      outcome: "unknown",
      reason: "zigma-flow inspect returned invalid JSON",
      metadata: { stdoutTail: stdout.slice(-4_000), exitCode: processExitCode }
    };
  }
  if (envelope.contractVersion !== FLOW_CONTRACT_VERSION || envelope.command !== "inspect") {
    return {
      outcome: "unknown",
      reason: "zigma-flow inspect returned an incompatible command envelope",
      metadata: { contractVersion: envelope.contractVersion, command: envelope.command, exitCode: processExitCode }
    };
  }
  if (processExitCode !== 0 || envelope.status !== "success") {
    if (envelope.error?.code === "RUN_NOT_FOUND") {
      return {
        outcome: "not_found",
        // A missing run directory does not prove an interrupted invocation was
        // fenced. Core must keep the command reconciling rather than replay it.
        safeToRedispatch: false,
        metadata: { providerCode: envelope.error.code, runId: envelope.runId }
      };
    }
    return {
      outcome: "unknown",
      reason: envelope.error?.message ?? "zigma-flow inspect command failed",
      metadata: { providerCode: envelope.error?.code, runId: envelope.runId, exitCode: processExitCode }
    };
  }
  const reconciliation = envelope.data?.["reconciliation"];
  if (!isRecord(reconciliation) || reconciliation["contractVersion"] !== 1) {
    return {
      outcome: "unknown",
      reason: "zigma-flow inspect omitted reconciliation V1 evidence",
      metadata: { runId: envelope.runId }
    };
  }
  const callerContext = reconciliation["callerContext"];
  if (
    !isRecord(callerContext)
    || callerContext["state"] !== "accepted"
    || callerContext["operationId"] !== request.operationId
  ) {
    return {
      outcome: "unknown",
      reason: "zigma-flow inspect could not prove operation correlation from a frozen caller context",
      metadata: { reconciliation }
    };
  }
  const lifecycle = reconciliation["lifecycle"];
  if (!isRecord(lifecycle) || typeof lifecycle["status"] !== "string") {
    return {
      outcome: "unknown",
      reason: "zigma-flow inspect omitted lifecycle evidence",
      metadata: { reconciliation }
    };
  }
  const status = lifecycle["status"];
  if (!["running", "awaiting_human", "completed", "failed", "cancelled"].includes(status)) {
    return {
      outcome: "unknown",
      reason: `zigma-flow inspect reported an unsupported lifecycle status: ${status}`,
      metadata: { reconciliation }
    };
  }
  const invocation = reconciliation["invocation"];
  const quiescent = isRecord(invocation)
    && invocation["state"] === "quiescent"
    && invocation["quiescent"] === true;
  return {
    outcome: "found",
    externalRunId: typeof reconciliation["externalRunId"] === "string"
      ? reconciliation["externalRunId"]
      : envelope.runId,
    status: status as FlowRunStatus,
    quiescent,
    metadata: { reconciliation }
  };
}

/** Exported for testing */
export function buildContextFilePayload(request: FlowStartRequest): Record<string, unknown> {
  if (!request.permissionSnapshotId.trim() || !request.integrityHash.trim()) {
    throw new IntegrationError("zigma-flow CallerContextV1 requires permission snapshot evidence");
  }
  return {
    contractVersion: FLOW_CONTRACT_VERSION,
    actor: request.callerContext.actor,
    capabilities: request.callerContext.capabilities,
    constraints: {
      repositoryIds: request.callerContext.constraints.repositoryIds,
      workflowRefs: request.callerContext.constraints.workflowRefs,
      toolNames: request.callerContext.constraints.toolNames,
      branchPatterns: request.callerContext.constraints.branchPatterns,
      ...(request.callerContext.constraints.maxRunDurationMs !== undefined
        ? { maxRunDurationMs: request.callerContext.constraints.maxRunDurationMs }
        : {}),
      ...(request.callerContext.constraints.expiresAt !== undefined
        ? { expiresAt: request.callerContext.constraints.expiresAt }
        : {})
    },
    source: request.callerContext.source,
    taskId: request.taskId,
    flowRunId: request.flowRunId,
    projectId: request.projectId,
    permissionSnapshotId: request.permissionSnapshotId,
    integrityHash: request.integrityHash,
    ...(request.operationId ? { operationId: request.operationId } : {}),
    ...(request.executionFence ? { executionFence: request.executionFence } : {}),
    ...(request.callbackCorrelationId ? { callbackCorrelationId: request.callbackCorrelationId } : {}),
    ...(request.repository ? { repository: request.repository } : {}),
    ...(request.baseRef ? { baseRef: request.baseRef } : {}),
    ...(request.workspacePolicy ? { workspacePolicy: request.workspacePolicy } : {}),
    ...(request.coreCallbackUrl ? { coreCallbackUrl: request.coreCallbackUrl } : {})
  };
}

export class LocalCliFlowExecutor implements FlowExecutor {
  private readonly contractCache = new Map<string, Promise<FlowContractInfo>>();

  private async ensureCompatibleProvider(
    command: string,
    timeoutMs: number,
    environment: Record<string, string>
  ): Promise<FlowContractInfo> {
    const key = contractCacheKey(command, environment);
    let pending = this.contractCache.get(key);
    if (!pending) {
      pending = (async () => {
        const result = await execa(command, ["contract-info", "--json"], {
          env: { ...process.env, ...environment },
          timeout: timeoutMs,
          reject: false,
          all: true
        });
        return parseContractInfo(result.stdout ?? result.all ?? "", result.exitCode ?? 1);
      })();
      this.contractCache.set(key, pending);
      pending.catch(() => this.contractCache.delete(key));
    }
    return pending;
  }

  async preflight(context: { command: string; timeoutMs: number; environment: Record<string, string> }): Promise<void> {
    await this.ensureCompatibleProvider(context.command, context.timeoutMs, context.environment);
  }

  async start(request: FlowStartRequest): Promise<FlowStartResult> {
    await this.ensureCompatibleProvider(request.command, request.timeoutMs, request.environment);
    const contextFilePath = join(tmpdir(), `zigma-ctx-${request.flowRunId}.json`);

    const args = [
      "--cwd",
      request.projectRoot,
      "invoke",
      request.workflowRef,
      "--task",
      request.taskText,
      "--context-file",
      contextFilePath
    ];
    for (const [key, value] of Object.entries(request.inputs)) {
      args.push("--input", `${key}=${value}`);
    }
    args.push("--json");
    if (request.backend) args.push("--backend", request.backend);
    if (request.parallelism !== undefined) args.push("--parallelism", String(request.parallelism));
    if (request.dryRun) args.push("--dry-run");

    try {
      await writeFile(contextFilePath, JSON.stringify(buildContextFilePayload(request), null, 2), "utf8");
      const result = await execa(request.command, args, {
        cwd: request.projectRoot,
        env: { ...process.env, ...request.environment },
        timeout: request.timeoutMs,
        reject: false,
        all: true,
        // The Flow owner must outlive Core: modern libuv on Windows places
        // non-detached children in a job object with KILL_ON_JOB_CLOSE, so a
        // hard Core kill would otherwise take the in-flight Flow run with it
        // (M4 restart-recovery window B). windowsHide keeps the detached
        // console window invisible.
        detached: true,
        windowsHide: true
      });
      const stdout = result.stdout ?? result.all ?? "";
      if (request.dryRun) {
        return {
          externalRunId: "dry-run",
          status: result.exitCode === 0 ? "completed" : "failed",
          exitCode: result.exitCode ?? 1,
          summary: stdout.slice(-4_000),
          metadata: { dryRun: true }
        };
      }
      const parsed = parseInvokeJson(stdout, result.exitCode ?? 1);
      if ((result.exitCode ?? 1) !== 0 && parsed.status !== "awaiting_human") {
        const stderrTail = (result.stderr ?? "").trim().slice(-4_000);
        return {
          ...parsed,
          status: "failed",
          summary: stderrTail
            ? `${parsed.summary}\n--- zigma-flow stderr ---\n${stderrTail}`
            : parsed.summary
        };
      }
      return parsed;
    } finally {
      await unlink(contextFilePath).catch(() => {});
    }
  }

  async decideGate(request: FlowGateDecisionRequest): Promise<void> {
    await this.ensureCompatibleProvider(request.command, request.timeoutMs, request.environment);
    const args = [
      "--cwd",
      request.projectRoot,
      "resume",
      request.externalRunId,
      "--job",
      request.jobId,
      "--input",
      `decision=${request.decision}`
    ];
    if (request.comment) args.push("--input", `comment=${request.comment}`);
    for (const [key, value] of Object.entries(request.input)) {
      args.push("--input", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
    args.push("--json");
    const result = await execa(request.command, args, {
      reject: false,
      all: true,
      timeout: request.timeoutMs,
      env: { ...process.env, ...request.environment }
    });
    parseCommandJson(result.stdout ?? result.all ?? "", result.exitCode ?? 1, "resume");
  }

  async cancel(request: FlowCancelRequest): Promise<FlowCancelResult> {
    await this.ensureCompatibleProvider(request.command, request.timeoutMs, request.environment);
    const result = await execa(request.command, [
      "--cwd",
      request.projectRoot,
      "abort",
      "--run",
      request.externalRunId,
      "--reason",
      request.reason,
      "--json"
    ], {
      reject: false,
      all: true,
      timeout: request.timeoutMs,
      env: { ...process.env, ...request.environment }
    });
    const envelope = parseCommandJson(result.stdout ?? result.all ?? "", result.exitCode ?? 1, "abort");
    if (envelope.data?.["quiescent"] !== true) {
      throw new IntegrationError("zigma-flow abort did not acknowledge quiescence", {
        runId: envelope.runId,
        quiescent: envelope.data?.["quiescent"]
      });
    }
    const ownerStatus = envelope.data["ownerStatus"];
    const status = ownerStatus === "completed" || ownerStatus === "failed" || ownerStatus === "cancelled"
      ? ownerStatus
      : "cancelled";
    return {
      externalRunId: envelope.runId,
      status,
      quiescent: true,
      metadata: envelope.data
    };
  }

  async reconcile(request: FlowReconcileRequest): Promise<FlowReconcileResult> {
    const contract = await this.ensureCompatibleProvider(request.command, request.timeoutMs, request.environment);
    if (!(contract.capabilities as string[]).includes(FLOW_INSPECT_CAPABILITY)) {
      return {
        outcome: "unsupported",
        reason: `zigma-flow does not advertise ${FLOW_INSPECT_CAPABILITY}`,
        metadata: { capabilities: contract.capabilities }
      };
    }
    if (!request.externalRunId) {
      return {
        outcome: "unknown",
        reason: "Core has no external Flow run id to inspect",
        metadata: { operationId: request.operationId }
      };
    }
    const result = await execa(request.command, [
      "--cwd",
      request.projectRoot,
      "inspect",
      "--run",
      request.externalRunId,
      "--json"
    ], {
      reject: false,
      all: true,
      timeout: request.timeoutMs,
      env: { ...process.env, ...request.environment }
    });
    return inspectReconciliationResult(result.stdout ?? result.all ?? "", result.exitCode ?? 1, request);
  }
}
