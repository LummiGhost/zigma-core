#!/usr/bin/env node
/**
 * zigma-core CLI — local adapter over the ZigmaCore API (mirrors FR-013).
 */

import { Command } from "commander";
import { ZigmaCore } from "../api/core.js";
import { createHttpServer } from "../http/server.js";
import type { ActorRef } from "../types/index.js";
import { CoreError } from "../errors.js";

const program = new Command();
program
  .name("zigma-core")
  .description("Zigma platform control plane: projects, tasks, gates, evidence.")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path", ".zigma-core/core.db")
  .option("--flow-command <cmd>", "zigma-flow command", "zigma-flow");

function core(): ZigmaCore {
  const opts = program.opts();
  return new ZigmaCore({ dbPath: opts.db, zigmaFlowCommand: opts.flowCommand });
}

function actorFromOpts(opts: { actor?: string; actorType?: string }): ActorRef {
  return {
    type: (opts.actorType as ActorRef["type"]) ?? "user",
    id: opts.actor ?? process.env.USER ?? "local-user",
  };
}

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(err: unknown): never {
  if (err instanceof CoreError) {
    console.error(JSON.stringify(err.toJSON(), null, 2));
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

// ── project ────────────────────────────────────────────────────────────

const project = program.command("project").description("Manage projects (FR-001)");

project
  .command("create")
  .requiredOption("--name <name>", "Project name")
  .option("--description <text>")
  .option("--root <path>", "Local project root containing .zigma-flow/")
  .option("--workflow <id>", "Default zigma-flow workflow")
  .action((opts) => {
    try {
      out(
        core().createProject({
          name: opts.name,
          description: opts.description,
          projectRoot: opts.root,
          defaultFlowWorkflowId: opts.workflow,
        })
      );
    } catch (err) {
      fail(err);
    }
  });

project.command("list").action(() => {
  try {
    out(core().listProjects());
  } catch (err) {
    fail(err);
  }
});

project
  .command("archive")
  .requiredOption("--id <projectId>")
  .action((opts) => {
    try {
      out(core().archiveProject(opts.id));
    } catch (err) {
      fail(err);
    }
  });

project
  .command("add-repo")
  .requiredOption("--id <projectId>")
  .requiredOption("--name <name>")
  .requiredOption("--url <url>")
  .option("--default-branch <branch>", "Default branch", "main")
  .option("--make-default", "Set as project default repository")
  .action((opts) => {
    try {
      out(
        core().registerRepository({
          projectId: opts.id,
          name: opts.name,
          url: opts.url,
          defaultBranch: opts.defaultBranch,
          makeDefault: opts.makeDefault,
        })
      );
    } catch (err) {
      fail(err);
    }
  });

// ── task ───────────────────────────────────────────────────────────────

const task = program.command("task").description("Manage tasks (FR-002/003)");

task
  .command("create")
  .requiredOption("--project <projectId>")
  .requiredOption("--title <title>")
  .option("--description <text>", "Task description", "")
  .option("--priority <p>", "low|normal|high|urgent", "normal")
  .option("--actor <id>", "Creating actor id")
  .option("--actor-type <type>", "user|system|service", "user")
  .action((opts) => {
    try {
      out(
        core().createTask({
          projectId: opts.project,
          title: opts.title,
          description: opts.description,
          priority: opts.priority,
          source: { channel: "cli" },
          createdBy: actorFromOpts(opts),
        })
      );
    } catch (err) {
      fail(err);
    }
  });

task
  .command("start")
  .requiredOption("--id <taskId>")
  .option("--workflow <id>", "Override workflow")
  .option("--input <key=value...>", "Workflow inputs (repeatable)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--wait", "Wait for the flow process to exit")
  .option("--write-code", "Grant canWriteCode")
  .option("--create-pr", "Grant canCreatePullRequest + canCreateBranch")
  .option("--actor <id>")
  .option("--actor-type <type>", "user|system|service", "user")
  .action(async (opts) => {
    try {
      const inputs: Record<string, string> = {};
      for (const pair of opts.input as string[]) {
        const idx = pair.indexOf("=");
        if (idx > 0) inputs[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
      out(
        await core().startTask(opts.id, {
          workflowId: opts.workflow,
          inputs,
          wait: opts.wait,
          actor: actorFromOpts(opts),
          grants: {
            canWriteCode: Boolean(opts.writeCode || opts.createPr),
            canCreateBranch: Boolean(opts.createPr),
            canCreatePullRequest: Boolean(opts.createPr),
          },
        })
      );
    } catch (err) {
      fail(err);
    }
  });

task
  .command("status")
  .requiredOption("--id <taskId>")
  .option("--sync", "Sync flow run status before reading")
  .action(async (opts) => {
    try {
      const c = core();
      if (opts.sync) await c.syncTask(opts.id);
      out(c.getTaskStatus(opts.id));
    } catch (err) {
      fail(err);
    }
  });

task
  .command("list")
  .option("--project <projectId>")
  .option("--status <status>")
  .action((opts) => {
    try {
      out(core().listTasks({ projectId: opts.project, status: opts.status }));
    } catch (err) {
      fail(err);
    }
  });

task
  .command("cancel")
  .requiredOption("--id <taskId>")
  .option("--reason <text>", "Cancellation reason", "cancelled via cli")
  .option("--actor <id>")
  .action(async (opts) => {
    try {
      await core().cancelTask(opts.id, opts.reason, actorFromOpts(opts));
      out({ ok: true });
    } catch (err) {
      fail(err);
    }
  });

task
  .command("sync")
  .requiredOption("--id <taskId>")
  .action(async (opts) => {
    try {
      out(await core().syncTask(opts.id));
    } catch (err) {
      fail(err);
    }
  });

task
  .command("link")
  .requiredOption("--id <taskId>")
  .requiredOption("--url <url>")
  .option("--kind <kind>", "pull_request|issue|ci_run|commit|doc|other", "other")
  .option("--title <title>")
  .action((opts) => {
    try {
      out(
        core().addExternalLink({
          taskId: opts.id,
          kind: opts.kind,
          url: opts.url,
          title: opts.title,
        })
      );
    } catch (err) {
      fail(err);
    }
  });

// ── gate ───────────────────────────────────────────────────────────────

const gate = program.command("gate").description("Human gate mirror (FR-008)");

gate
  .command("list")
  .option("--status <status>", "awaiting|approved|rejected|expired", "awaiting")
  .option("--task <taskId>")
  .action((opts) => {
    try {
      out(core().listGates({ status: opts.status, taskId: opts.task }));
    } catch (err) {
      fail(err);
    }
  });

for (const decision of ["approve", "reject"] as const) {
  gate
    .command(decision)
    .requiredOption("--id <gateId>")
    .option("--comment <text>")
    .option("--actor <id>")
    .option("--actor-type <type>", "user|system|service", "user")
    .action(async (opts) => {
      try {
        const input = {
          gateRequestId: opts.id,
          actor: actorFromOpts(opts),
          comment: opts.comment,
        };
        const c = core();
        out(decision === "approve" ? await c.approveGate(input) : await c.rejectGate(input));
      } catch (err) {
        fail(err);
      }
    });
}

// ── evidence & audit ───────────────────────────────────────────────────

program
  .command("evidence")
  .description("Collect an evidence bundle for a task (FR-009)")
  .requiredOption("--task <taskId>")
  .option("--run <flowRunRefId>")
  .action(async (opts) => {
    try {
      out(await core().collectEvidence(opts.task, opts.run));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("audit")
  .description("List audit events (FR-012)")
  .option("--task <taskId>")
  .option("--limit <n>", "Max events", "50")
  .action((opts) => {
    try {
      out(core().listAudit({ taskId: opts.task, limit: Number(opts.limit) }));
    } catch (err) {
      fail(err);
    }
  });

// ── serve ──────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the HTTP API (FR-013)")
  .option("--port <port>", "Port", "7180")
  .action((opts) => {
    const c = core();
    const server = createHttpServer(c);
    server.listen(Number(opts.port), () => {
      console.log(`zigma-core API listening on http://localhost:${opts.port}`);
    });
  });

program.parseAsync(process.argv);
