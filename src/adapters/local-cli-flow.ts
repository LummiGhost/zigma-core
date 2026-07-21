import { execa } from "execa";
import type { FlowCancelRequest, FlowExecutor, FlowGateDecisionRequest, FlowStartRequest, FlowStartResult } from "../contracts/ports.js";
import { IntegrationError } from "../domain/errors.js";

function mapStatus(status: string | undefined, exitCode: number): FlowStartResult["status"] {
  const normalized = status?.trim().toLowerCase();
  if (normalized === "completed" || normalized === "succeeded" || normalized === "success") return "completed";
  if (normalized === "awaiting_human" || normalized === "paused" || normalized === "waiting") return "awaiting_human";
  if (normalized === "cancelled" || normalized === "aborted") return "cancelled";
  if (normalized === "running") return "running";
  return exitCode === 0 ? "completed" : "failed";
}

function parseInvokeOutput(stdout: string, exitCode: number): FlowStartResult {
  const match = stdout.match(/Run\s+([^\s]+)\s+finished with status:\s*([^\r\n]+)/i);
  if (!match) {
    throw new IntegrationError("zigma-flow output did not contain a machine-identifiable run result", {
      requiredContract: "invoke must emit a JSON result or a stable final status record",
      stdoutTail: stdout.slice(-4_000),
      exitCode
    });
  }
  const externalRunId = match[1]!;
  const rawStatus = match[2]!;
  return {
    externalRunId,
    status: mapStatus(rawStatus, exitCode),
    exitCode,
    summary: `zigma-flow run ${externalRunId} finished with status ${rawStatus.trim()}`,
    metadata: { rawStatus: rawStatus.trim() }
  };
}

export class LocalCliFlowExecutor implements FlowExecutor {
  async start(request: FlowStartRequest): Promise<FlowStartResult> {
    const args = [
      "--cwd",
      request.projectRoot,
      "invoke",
      request.workflowRef,
      "--task",
      request.taskText
    ];
    for (const [key, value] of Object.entries(request.inputs)) {
      args.push("--input", `${key}=${value}`);
    }
    if (request.backend) args.push("--backend", request.backend);
    if (request.parallelism !== undefined) args.push("--parallelism", String(request.parallelism));
    if (request.dryRun) args.push("--dry-run");

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
    const parsed = parseInvokeOutput(stdout, result.exitCode ?? 1);
    if ((result.exitCode ?? 1) !== 0 && parsed.status !== "awaiting_human") {
      return { ...parsed, status: "failed" };
    }
    return parsed;
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
    const result = await execa(request.command, args, {
      reject: false,
      all: true,
      timeout: request.timeoutMs,
      env: { ...process.env, ...request.environment }
    });
    if ((result.exitCode ?? 1) !== 0) {
      throw new IntegrationError("zigma-flow rejected the human gate decision", {
        exitCode: result.exitCode,
        output: result.all?.slice(-4_000)
      });
    }
  }

  async cancel(request: FlowCancelRequest): Promise<void> {
    const result = await execa(request.command, ["--cwd", request.projectRoot, "abort", request.externalRunId], {
      reject: false,
      all: true,
      timeout: request.timeoutMs,
      env: { ...process.env, ...request.environment, ZIGMA_CORE_CANCEL_REASON: request.reason }
    });
    if ((result.exitCode ?? 1) !== 0) {
      throw new IntegrationError("zigma-flow could not cancel the run", {
        externalRunId: request.externalRunId,
        exitCode: result.exitCode,
        output: result.all?.slice(-4_000)
      });
    }
  }
}
