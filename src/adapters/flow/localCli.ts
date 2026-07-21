/**
 * LocalCliFlowInvoker — drives zigma-flow through its CLI.
 *
 * Known contract gaps in zigma-flow v0.7.x (tracked as upstream issues,
 * see docs/issues/):
 *   1. `invoke` has no `--json` output, so the new run id is not printed in
 *      machine-readable form. Workaround: snapshot `.zigma-flow/runs/`
 *      directory names before invoking and diff afterwards. Only directory
 *      NAMES are read — run state is always read via `inspect --json`.
 *   2. `invoke` has no `--caller-context <file>` flag, so the caller context
 *      snapshot cannot be injected from the CLI. Workaround: Core keeps the
 *      authoritative PermissionSnapshot itself and best-effort writes
 *      `caller-context.json` into the run directory once discovered.
 *   3. `approve`/`reject` accept no `--actor`, so the deciding actor is
 *      recorded only on the Core side.
 */

import { execa, type Options as ExecaOptions } from "execa";
import { spawn } from "node:child_process";
import { readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../../errors.js";
import type {
  FlowGateDecision,
  FlowInvokeHandle,
  FlowInvokeRequest,
  FlowInvoker,
  FlowRunStatusMirror,
} from "./types.js";

export interface LocalCliFlowInvokerOptions {
  /** Command name or path for the zigma-flow binary. */
  command?: string;
  /** How long to poll for a new run directory to appear (ms). */
  runDiscoveryTimeoutMs?: number;
}

export class LocalCliFlowInvoker implements FlowInvoker {
  private readonly command: string;
  private readonly discoveryTimeout: number;

  constructor(options: LocalCliFlowInvokerOptions = {}) {
    this.command = options.command ?? "zigma-flow";
    this.discoveryTimeout = options.runDiscoveryTimeoutMs ?? 15000;
  }

  private runsDir(cwd: string): string {
    return join(cwd, ".zigma-flow", "runs");
  }

  async listRunIds(cwd: string): Promise<string[]> {
    const dir = this.runsDir(cwd);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  async invoke(req: FlowInvokeRequest): Promise<FlowInvokeHandle> {
    const before = new Set(await this.listRunIds(req.cwd));
    const args = ["invoke", req.workflow, "--task", req.taskText];
    for (const [k, v] of Object.entries(req.inputs)) {
      args.push("--input", `${k}=${v}`);
    }

    if (req.wait) {
      const opts: ExecaOptions = {
        cwd: req.cwd,
        reject: false,
        timeout: req.timeoutSeconds ? req.timeoutSeconds * 1000 : undefined,
        env: { ZIGMA_CALLER_CONTEXT_JSON: JSON.stringify(req.callerContext) },
      };
      const result = await execa(this.command, args, opts);
      const runId = await this.discoverNewRunId(req.cwd, before);
      if (runId) this.writeCallerContext(req.cwd, runId, req.callerContext);
      if (result.failed && !runId) {
        throw new CoreError("FLOW_INVOCATION_FAILED", `zigma-flow invoke failed`, {
          exitCode: result.exitCode,
          stderr: String(result.stderr ?? "").slice(-2000),
        });
      }
      return { zigmaFlowRunId: runId, exitCode: result.exitCode ?? undefined };
    }

    // Detached mode: spawn and return immediately; run id is discovered by polling.
    const child = spawn(this.command, args, {
      cwd: req.cwd,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ZIGMA_CALLER_CONTEXT_JSON: JSON.stringify(req.callerContext),
      },
    });
    child.unref();
    const runId = await this.discoverNewRunId(req.cwd, before);
    if (runId) this.writeCallerContext(req.cwd, runId, req.callerContext);
    return { zigmaFlowRunId: runId, pid: child.pid ?? undefined };
  }

  async resume(cwd: string, zigmaFlowRunId: string, wait = false): Promise<FlowInvokeHandle> {
    // `invoke --resume` requires the workflow name in some versions; the
    // portable form is `invoke <workflow> --resume <id>`, but run metadata
    // already knows the workflow, so `run-all --resume` style is avoided and
    // we rely on `invoke` accepting resume with workflow inferred from the run.
    const args = ["invoke", "--resume", zigmaFlowRunId];
    if (wait) {
      const result = await execa(this.command, args, { cwd, reject: false });
      return { zigmaFlowRunId, exitCode: result.exitCode ?? undefined };
    }
    const child = spawn(this.command, args, { cwd, detached: true, stdio: "ignore" });
    child.unref();
    return { zigmaFlowRunId, pid: child.pid ?? undefined };
  }

  async getStatus(cwd: string, zigmaFlowRunId: string): Promise<FlowRunStatusMirror> {
    const result = await execa(
      this.command,
      ["inspect", zigmaFlowRunId, "--jobs", "--events", "--artifacts", "--json"],
      { cwd, reject: false }
    );
    if (result.failed) {
      throw new CoreError("FLOW_INVOCATION_FAILED", `zigma-flow inspect failed for ${zigmaFlowRunId}`, {
        stderr: String(result.stderr ?? "").slice(-2000),
      });
    }
    let parsed: any;
    try {
      parsed = JSON.parse(String(result.stdout));
    } catch (err) {
      throw new CoreError("FLOW_INVOCATION_FAILED", "inspect --json output was not valid JSON", {
        sample: String(result.stdout).slice(0, 500),
      });
    }
    return normalizeInspectOutput(zigmaFlowRunId, parsed);
  }

  async decideGate(input: FlowGateDecision): Promise<void> {
    const args = [
      input.decision, // "approve" | "reject"
      "--job",
      input.jobId,
      "--step",
      input.stepId,
      "--run",
      input.zigmaFlowRunId,
    ];
    if (input.comment && input.decision === "approve") {
      args.push("--comment", input.comment);
    }
    const result = await execa(this.command, args, { cwd: input.cwd, reject: false });
    if (result.failed) {
      throw new CoreError("FLOW_INVOCATION_FAILED", `zigma-flow ${input.decision} failed`, {
        stderr: String(result.stderr ?? "").slice(-2000),
      });
    }
  }

  async cancel(cwd: string, zigmaFlowRunId: string, reason: string): Promise<void> {
    const result = await execa(
      this.command,
      ["abort", "--run", zigmaFlowRunId, "--reason", reason],
      { cwd, reject: false }
    );
    if (result.failed) {
      throw new CoreError("FLOW_INVOCATION_FAILED", "zigma-flow abort failed", {
        stderr: String(result.stderr ?? "").slice(-2000),
      });
    }
  }

  private async discoverNewRunId(cwd: string, before: Set<string>): Promise<string | undefined> {
    const deadline = Date.now() + this.discoveryTimeout;
    while (Date.now() < deadline) {
      const now = await this.listRunIds(cwd);
      const fresh = now.filter((id) => !before.has(id));
      if (fresh.length > 0) {
        // Newest wins if multiple appeared.
        return fresh.sort().at(-1);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return undefined;
  }

  /** Best-effort caller-context snapshot until zigma-flow supports --caller-context. */
  private writeCallerContext(cwd: string, runId: string, ctx: unknown): void {
    try {
      const runDir = join(this.runsDir(cwd), runId);
      if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
      const file = join(runDir, "caller-context.json");
      if (!existsSync(file)) {
        writeFileSync(file, JSON.stringify(ctx, null, 2));
      }
    } catch {
      // Non-fatal: Core keeps the authoritative snapshot in its own DB.
    }
  }
}

/**
 * Normalize `inspect --json` output defensively: zigma-flow's exact JSON
 * shape may evolve, so we probe common field names and always keep `raw`.
 */
export function normalizeInspectOutput(runId: string, parsed: any): FlowRunStatusMirror {
  const root = parsed ?? {};
  const state = root.state ?? root.run ?? root.summary ?? root;

  const status: FlowRunStatusMirror["status"] =
    state.status ?? state.runStatus ?? root.status ?? "running";

  const jobsRaw: any[] = state.jobs ?? root.jobs ?? [];
  const jobs = (Array.isArray(jobsRaw) ? jobsRaw : Object.entries(jobsRaw).map(([jobId, j]: any) => ({ jobId, ...(j as object) }))).map(
    (j: any) => ({
      jobId: j.jobId ?? j.id ?? j.job ?? "unknown",
      status: j.status,
      currentStep: j.currentStep ?? j.current_step,
      stepStatus: j.stepStatus ?? j.step_status,
    })
  );

  const gatesRaw: any[] =
    root.pendingHumanGates ?? state.pendingHumanGates ?? root.pending_human_gates ?? [];
  const pendingHumanGates = gatesRaw.map((g: any) => ({
    jobId: g.jobId ?? g.job_id ?? g.job,
    stepId: g.stepId ?? g.step_id ?? g.step,
    prompt: g.prompt,
    approvers: g.approvers,
    instructions: g.instructions,
    enteredAt: g.enteredAt ?? g.entered_at,
  }));

  // If inspect json doesn't surface gates directly, derive from jobs awaiting_human.
  if (pendingHumanGates.length === 0) {
    for (const j of jobs) {
      if (j.stepStatus === "awaiting_human" || j.status === "awaiting_human" || j.status === "blocked_on_human") {
        pendingHumanGates.push({
          jobId: j.jobId,
          stepId: j.currentStep ?? "unknown",
          prompt: "",
          approvers: undefined,
          instructions: undefined,
          enteredAt: undefined,
        });
      }
    }
  }

  const artifactsRaw: any[] = root.artifacts ?? state.artifacts ?? [];
  const artifacts = artifactsRaw.map((a: any) => ({
    jobId: a.jobId ?? a.job_id,
    stepId: a.stepId ?? a.step_id,
    name: a.name ?? a.filename ?? a.path ?? "artifact",
    path: a.path,
    kind: a.kind ?? a.type,
    createdAt: a.createdAt ?? a.created_at,
  }));

  const events: any[] = root.events ?? state.events ?? [];

  return {
    runId,
    workflow: state.workflow ?? root.workflow,
    status,
    task: state.task ?? root.task,
    createdAt: state.createdAt ?? state.created_at,
    updatedAt: state.updatedAt ?? state.updated_at,
    jobs,
    pendingHumanGates,
    artifacts,
    events: Array.isArray(events) ? events : [],
    raw: parsed,
  };
}
