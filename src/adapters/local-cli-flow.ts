import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { FlowCancelRequest, FlowExecutor, FlowGateDecisionRequest, FlowStartRequest, FlowStartResult } from "../contracts/ports.js";
import type { FlowRunStatus } from "../contracts/schemas.js";
import { IntegrationError } from "../domain/errors.js";

const FLOW_CONTRACT_VERSION = 1;
const FLOW_PROVIDER = "zigma-flow";
const REQUIRED_FLOW_CAPABILITIES = [
  "caller-context-v1",
  "invoke-json-v1",
  "context-freeze-v1"
] as const;

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

  return {
    externalRunId: envelope.runId,
    status: envelope.status as FlowRunStatus,
    exitCode: envelope.exitCode ?? processExitCode,
    summary: `zigma-flow run ${envelope.runId} finished with status ${envelope.status}`,
    metadata: {
      pausedGate: envelope.pausedGate ?? null,
      artifacts: envelope.artifacts ?? [],
      eventLogUri: envelope.eventLogUri ?? null
    }
  };
}

function assertCommandJson(stdout: string, processExitCode: number, command: string): void {
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
  ): Promise<void> {
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
    await pending;
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
        all: true
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
        return { ...parsed, status: "failed" };
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
    assertCommandJson(result.stdout ?? result.all ?? "", result.exitCode ?? 1, "resume");
  }

  async cancel(request: FlowCancelRequest): Promise<void> {
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
    assertCommandJson(result.stdout ?? result.all ?? "", result.exitCode ?? 1, "abort");
  }
}
