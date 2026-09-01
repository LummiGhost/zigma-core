import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { FlowCancelRequest, FlowExecutor, FlowGateDecisionRequest, FlowStartRequest, FlowStartResult } from "../contracts/ports.js";
import type { FlowRunStatus } from "../contracts/schemas.js";
import { IntegrationError } from "../domain/errors.js";

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
  return {
    permissionSnapshotId: request.permissionSnapshotId ?? null,
    integrityHash: request.integrityHash ?? null,
    capabilities: request.callerContext.capabilities,
    constraints: {
      allowedRepos: request.callerContext.constraints.repositoryIds,
      allowedBranches: request.callerContext.constraints.branchPatterns,
      maxRunDurationMs: request.callerContext.constraints.maxRunDurationMs ?? null
    },
    source: request.callerContext.source,
    coreCallbackUrl: request.coreCallbackUrl,
    actor: request.callerContext.actor,
    flowRunId: request.flowRunId,
    taskId: request.taskId
  };
}

export class LocalCliFlowExecutor implements FlowExecutor {
  async start(request: FlowStartRequest): Promise<FlowStartResult> {
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
