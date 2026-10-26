#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { CoreService, type DispatchExecutionPhase } from "./application/core-service.js";
import { AsyncExecutionRuntime } from "./application/async-execution-runtime.js";
import { ExecutionAdmissionService } from "./application/execution-admission.js";
import { SystemClock, UuidGenerator } from "./application/runtime.js";
import { LocalCliFlowExecutor } from "./adapters/local-cli-flow.js";
import { ZigmaWorkspaceCliAdapter } from "./adapters/zigma-workspace-cli.js";
import { buildServer } from "./api/server.js";
import { SqliteStore } from "./persistence/sqlite-store.js";
import { appendNote, buildReport } from "./operations/report.js";
import { runOps } from "./operations/runner.js";
import { EXIT_CONTRACT, EXIT_OK, OpsError, errorMessage, type OpsExitCode } from "./operations/schema.js";
import { packageVersion } from "./version.js";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

/**
 * Fault-injection seam for real-process tests: when
 * ZIGMA_CORE_CRASHPOINT_PHASE names a dispatch phase, the runtime pauses at
 * that phase while ZIGMA_CORE_CRASHPOINT_BLOCK_FILE exists (signalling via
 * ZIGMA_CORE_CRASHPOINT_STARTED_FILE), so a harness can kill the process in
 * an otherwise unreachable crash window. Absent the env vars this is a no-op.
 */
function phasePauseHook(env: NodeJS.ProcessEnv) {
  const phase = env["ZIGMA_CORE_CRASHPOINT_PHASE"];
  if (!phase) return undefined;
  const blockFile = env["ZIGMA_CORE_CRASHPOINT_BLOCK_FILE"];
  const startedFile = env["ZIGMA_CORE_CRASHPOINT_STARTED_FILE"];
  return async (current: DispatchExecutionPhase): Promise<void> => {
    if (current !== phase) return;
    if (!blockFile || !existsSync(blockFile)) return;
    if (startedFile) writeFileSync(startedFile, "blocking", "utf8");
    while (existsSync(blockFile)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
}

async function openCore(dbPath: string, executionMode: "synchronous" | "asynchronous" = "synchronous"): Promise<{ core: CoreService; store: SqliteStore; clock: SystemClock; ids: UuidGenerator }> {
  const resolved = resolve(dbPath);
  await mkdir(dirname(resolved), { recursive: true });
  const store = new SqliteStore(resolved);
  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const core = new CoreService({
    store,
    flowExecutor: new LocalCliFlowExecutor(),
    workspaceProvider: new ZigmaWorkspaceCliAdapter(),
    clock,
    ids,
    executionMode
  });
  return { core, store, clock, ids };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printOps(value: unknown, exitCode: OpsExitCode): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = exitCode;
}

function printOpsError(message: string, exitCode: OpsExitCode): void {
  process.stdout.write(`${JSON.stringify({ schema: "zigma.ops.error/1", error: { message }, exitCode }, null, 2)}\n`);
  process.exitCode = exitCode;
}

/**
 * Run an ops action and map every failure to a contract exit code. Ops
 * failures never escape to an unhandled rejection or a silent success exit.
 */
async function runOpsCommand(action: () => Promise<boolean>): Promise<void> {
  try {
    const printed = await action();
    if (!printed) printOpsError("operations command produced no output", EXIT_CONTRACT);
  } catch (error) {
    const code: OpsExitCode = error instanceof OpsError ? error.exitCode : EXIT_CONTRACT;
    printOpsError(errorMessage(error), code);
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("zigma-core")
    .description("Zigma platform control plane")
    .version(packageVersion)
    .option("--db <path>", "SQLite database path", ".zigma-core/core.db");

  // Operations commands are HTTP-only and registered before any store-opening
  // command; their handlers never open the local SQLite store.
  const ops = program.command("ops").description("Operator receipts (HTTP only; never opens the local store)");
  ops
    .command("run")
    .description("Run a manifest batch against a local Core server")
    .requiredOption("--manifest <file>", "Operations manifest path")
    .requiredOption("--out <directory>", "New batch output directory (must not exist)")
    .action(async (options: { manifest: string; out: string }) => {
      await runOpsCommand(async () => {
        const { output, exitCode } = await runOps({ manifestPath: options.manifest, outPath: options.out });
        printOps(output, exitCode);
        return true;
      });
    });
  ops
    .command("report")
    .description("Summarize one batch directory or a parent of batch directories")
    .requiredOption("--dir <directory>", "Batch directory or parent directory")
    .action(async (options: { dir: string }) => {
      await runOpsCommand(async () => {
        const report = await buildReport(options.dir);
        printOps(report, EXIT_OK);
        return true;
      });
    });
  ops
    .command("note")
    .description("Append a self-reported operator note to a batch")
    .requiredOption("--dir <directory>", "Batch directory")
    .requiredOption("--task <key>", "Planned task key")
    .requiredOption("--kind <kind>", "review|repair|reset|retry|other")
    .requiredOption("--reason <text>", "Non-empty reason")
    .action(async (options: { dir: string; task: string; kind: string; reason: string }) => {
      await runOpsCommand(async () => {
        const result = await appendNote({ dir: options.dir, key: options.task, kind: options.kind, reason: options.reason });
        printOps(result, EXIT_OK);
        return true;
      });
    });

  program
    .command("serve")
    .description("Start the Core HTTP API")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "4736")
    .option("--workers <count>", "Concurrent durable dispatch workers", "4")
    .action(async (options: { host: string; port: string; workers: string }) => {
      const workerConcurrency = Number(options.workers);
      if (!Number.isSafeInteger(workerConcurrency) || workerConcurrency < 1) {
        throw new Error("--workers must be a positive integer");
      }
      const { core, store, clock, ids } = await openCore(program.opts<{ db: string }>().db, "asynchronous");
      const runtime = new AsyncExecutionRuntime(store, core, new ExecutionAdmissionService(store, clock, ids), {
        ownerId: `core-${process.pid}`,
        workerConcurrency,
        metrics: core.metricsRegistry,
        onPhase: phasePauseHook(process.env),
        policyFor(commandId) {
          const command = store.getExecutionCommand(commandId);
          const project = store.getProject(command.projectId);
          return store.getExecutionProfile(project.executionProfileId).executionPolicy;
        }
      });
      const app = buildServer(core);
      app.addHook("onClose", async () => { await runtime.stop(); store.close(); });
      runtime.start();
      await app.listen({ host: options.host, port: Number(options.port) });
    });

  const profile = program.command("profile").description("Manage execution profiles");
  profile
    .command("create")
    .requiredOption("--file <path>", "JSON input file")
    .action(async (options: { file: string }) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: core.createExecutionProfile(await readJson(options.file) as never) });
      } finally {
        store.close();
      }
    });

  const project = program.command("project").description("Manage projects");
  project
    .command("create")
    .requiredOption("--file <path>", "JSON input file")
    .action(async (options: { file: string }) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: core.createProject(await readJson(options.file) as never) });
      } finally {
        store.close();
      }
    });
  project
    .command("show <id>")
    .action(async (id: string) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: core.getProject(id) });
      } finally {
        store.close();
      }
    });

  const task = program.command("task").description("Manage tasks");
  task
    .command("create")
    .requiredOption("--file <path>", "JSON input file")
    .action(async (options: { file: string }) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: core.createTask(await readJson(options.file) as never) });
      } finally {
        store.close();
      }
    });
  task
    .command("show <id>")
    .action(async (id: string) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: core.getTaskView(id) });
      } finally {
        store.close();
      }
    });
  task
    .command("start <id>")
    .requiredOption("--file <path>", "JSON input file")
    .action(async (id: string, options: { file: string }) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: await core.startTask(id, await readJson(options.file) as never) });
      } finally {
        store.close();
      }
    });
  task
    .command("cancel <id>")
    .option("--reason <reason>", "Cancellation reason", "Cancelled from CLI")
    .action(async (id: string, options: { reason: string }) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: await core.cancelTask(id, options.reason) });
      } finally {
        store.close();
      }
    });

  program
    .command("metrics <flowRunId>")
    .description("Show execution metrics for a flow run")
    .action(async (flowRunId: string) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: core.getFlowRunMetrics(flowRunId) });
      } finally {
        store.close();
      }
    });

  const gate = program.command("gate").description("Manage human gates");
  gate
    .command("decide <id>")
    .requiredOption("--file <path>", "JSON input file")
    .action(async (id: string, options: { file: string }) => {
      const { core, store } = await openCore(program.opts<{ db: string }>().db);
      try {
        print({ data: await core.decideHumanGate(id, await readJson(options.file) as never) });
      } finally {
        store.close();
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof OpsError) {
    printOpsError(errorMessage(error), error.exitCode);
    return;
  }
  const message = errorMessage(error);
  process.stderr.write(`${JSON.stringify({ error: { message } }, null, 2)}\n`);
  process.exitCode = 1;
});
