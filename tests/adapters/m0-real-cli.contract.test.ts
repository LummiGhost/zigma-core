import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { LocalCliFlowExecutor } from "../../src/adapters/local-cli-flow.js";
import { ZigmaWorkspaceCliAdapter } from "../../src/adapters/zigma-workspace-cli.js";

const flowCliPath = process.env["ZIGMA_FLOW_CLI_PATH"];
const workspaceCliPath = process.env["ZIGMA_WORKSPACE_CLI_PATH"];
const describeRealProviders = flowCliPath && workspaceCliPath ? describe : describe.skip;
const tempRoots: string[] = [];

const SCRIPT_ONLY_WORKFLOW = `\
name: core-flow-contract
version: "0.1.0"
jobs:
  smoke:
    steps:
      - id: pass
        type: script
        run: node -e "process.exit(0)"
`;

async function makeFlowProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zigma-core-flow-contract-"));
  tempRoots.push(root);
  await mkdir(join(root, ".zigma-flow", "runs"), { recursive: true });
  await writeFile(join(root, ".zigma-flow", "config.json"), JSON.stringify({
    tool_version: "0.8.12",
    active_run: null,
    agent: { backend: "claude-code", backends: {} }
  }, null, 2), "utf8");
  await writeFile(join(root, ".zigma-flow", "skill-lock.json"), JSON.stringify({ skills: {} }), "utf8");
  await writeFile(join(root, "workflow.yml"), SCRIPT_ONLY_WORKFLOW, "utf8");
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function makeGitRepository(): Promise<{ root: string; repository: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "zigma-core-workspace-contract-"));
  tempRoots.push(root);
  const repository = join(root, "repository");
  const stateDir = join(root, "state");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "core-contract@example.test");
  git(repository, "config", "user.name", "Core contract test");
  git(repository, "config", "core.autocrlf", "false");
  await writeFile(join(repository, "README.md"), "# initial\n", "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  return { root, repository, stateDir };
}

async function makeExecutable(directory: string, name: string, source: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

function workspaceRequest(command: string, repository: string, stateDir: string, flowRunId: string) {
  return {
    projectId: "project-real-contract",
    taskId: "task-real-contract",
    flowRunId,
    repository: {
      id: "repository-real-contract",
      provider: "github" as const,
      url: repository,
      defaultRef: "main",
      writable: true,
      metadata: {}
    },
    baseRef: "main",
    branch: `zigma/${flowRunId}`,
    policy: {
      provider: "zigma-workspace-cli" as const,
      mode: "writable" as const,
      branchTemplate: "zigma/{taskId}",
      cleanup: "manual" as const,
      snapshotOnTerminal: true
    },
    command,
    timeoutMs: 60_000,
    environment: { ZIGMA_WORKSPACE_STATE_DIR: stateDir }
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeRealProviders("M0 real sibling CLI contracts", () => {
  it("sends canonical CallerContextV1 to Flow and observes the frozen snapshot", async () => {
    await stat(flowCliPath!);
    const projectRoot = await makeFlowProject();
    const executor = new LocalCliFlowExecutor();
    const result = await executor.start({
      command: flowCliPath!,
      projectId: "project-real-contract",
      taskId: "task-real-contract",
      flowRunId: "flow-run-real-contract",
      workflowRef: join(projectRoot, "workflow.yml"),
      taskText: "prove the real Flow boundary",
      projectRoot,
      inputs: {},
      callerContext: {
        actor: { type: "service", id: "zigma-core" },
        capabilities: ["task:start", "workflow:invoke"],
        constraints: {
          repositoryIds: ["repository-real-contract"],
          workflowRefs: ["core-flow-contract"],
          toolNames: ["node"],
          branchPatterns: ["zigma/*"]
        },
        source: { kind: "system", metadata: { test: "m0-real-cli" } }
      },
      permissionSnapshotId: "permission-real-contract",
      integrityHash: `sha256:${"a".repeat(64)}`,
      operationId: "command-real-contract",
      callbackCorrelationId: "command-real-contract",
      coreCallbackUrl: "http://127.0.0.1:4736/v1",
      timeoutMs: 60_000,
      environment: {},
      dryRun: false
    });

    expect(result.status).toBe("completed");
    const frozen = JSON.parse(await readFile(
      join(projectRoot, ".zigma-flow", "runs", result.externalRunId, "caller-context.json"),
      "utf8"
    )) as { callerContext: Record<string, unknown> };
    expect(frozen.callerContext).toMatchObject({
      contractVersion: 1,
      projectId: "project-real-contract",
      taskId: "task-real-contract",
      flowRunId: "flow-run-real-contract",
      permissionSnapshotId: "permission-real-contract",
      integrityHash: `sha256:${"a".repeat(64)}`,
      constraints: {
        repositoryIds: ["repository-real-contract"],
        workflowRefs: ["core-flow-contract"],
        toolNames: ["node"],
        branchPatterns: ["zigma/*"]
      }
    });
  });

  it("consumes real Workspace patch/snapshot artifacts only after digest verification", async () => {
    await stat(workspaceCliPath!);
    const fixture = await makeGitRepository();
    const adapter = new ZigmaWorkspaceCliAdapter();
    const request = workspaceRequest(workspaceCliPath!, fixture.repository, fixture.stateDir, "flow-real-artifacts");
    const prepared = await adapter.prepare(request);
    try {
      await writeFile(join(prepared.path, "README.md"), "# changed through workspace\n", "utf8");
      git(prepared.path, "config", "user.email", "core-contract@example.test");
      git(prepared.path, "config", "user.name", "Core contract test");
      git(prepared.path, "config", "core.autocrlf", "false");
      git(prepared.path, "add", "README.md");
      git(prepared.path, "commit", "-m", "change through workspace");
      const evidence = await adapter.collectEvidence(prepared.externalId, {
        command: workspaceCliPath!,
        timeoutMs: 60_000,
        environment: request.environment
      });

      expect(evidence.items.length).toBeGreaterThanOrEqual(3);
      for (const item of evidence.items.filter((candidate) => candidate.uri.startsWith("file:"))) {
        const bytes = await readFile(fileURLToPath(item.uri));
        expect(item.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      }
      expect(evidence.items.some((item) => item.kind === "workspace-diff" && item.digest)).toBe(true);
      expect(evidence.items.filter((item) => item.kind === "workspace-snapshot").length).toBeGreaterThanOrEqual(2);
    } finally {
      await adapter.cleanup(prepared.externalId, {
        command: workspaceCliPath!,
        timeoutMs: 60_000,
        environment: request.environment
      });
    }
  });

  it("rejects an unknown handshake version before the provider can create state", async () => {
    const fixture = await makeGitRepository();
    const marker = join(fixture.root, "side-effect-marker");
    const fakeProvider = await makeExecutable(fixture.root, "unknown-contract.mjs", `
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("contract-info")) {
  process.stdout.write(JSON.stringify({ contract_version: 99, ok: true, data: {} }));
} else {
  writeFileSync(${JSON.stringify(marker)}, "called");
}
`);
    const adapter = new ZigmaWorkspaceCliAdapter();

    await expect(adapter.prepare(workspaceRequest(
      fakeProvider,
      fixture.repository,
      fixture.stateDir,
      "flow-unknown-version"
    ))).rejects.toThrow("contract version mismatch: expected 1, got 99");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects bytes tampered after the real Workspace CLI emits its digest", async () => {
    const fixture = await makeGitRepository();
    const proxy = await makeExecutable(fixture.root, "tampering-proxy.mjs", `
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [${JSON.stringify(workspaceCliPath!)}, ...args], {
  encoding: "utf8",
  env: process.env
});
let stdout = result.stdout ?? "";
if (args.includes("diff") && stdout) {
  const envelope = JSON.parse(stdout);
  const uri = envelope.data?.patch_artifact?.uri;
  if (uri) appendFileSync(fileURLToPath(uri), "tampered-after-provider-digest");
}
process.stdout.write(stdout);
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
`);
    const proxyAdapter = new ZigmaWorkspaceCliAdapter();
    const request = workspaceRequest(proxy, fixture.repository, fixture.stateDir, "flow-tampered-artifact");
    const prepared = await proxyAdapter.prepare(request);
    try {
      await writeFile(join(prepared.path, "README.md"), "# changed then tampered\n", "utf8");
      git(prepared.path, "config", "user.email", "core-contract@example.test");
      git(prepared.path, "config", "user.name", "Core contract test");
      git(prepared.path, "config", "core.autocrlf", "false");
      git(prepared.path, "add", "README.md");
      git(prepared.path, "commit", "-m", "change before tampering");
      await expect(proxyAdapter.collectEvidence(prepared.externalId, {
        command: proxy,
        timeoutMs: 60_000,
        environment: request.environment
      })).rejects.toThrow("artifact digest mismatch");
    } finally {
      const cleanupAdapter = new ZigmaWorkspaceCliAdapter();
      await cleanupAdapter.cleanup(prepared.externalId, {
        command: workspaceCliPath!,
        timeoutMs: 60_000,
        environment: request.environment
      });
    }
  });
});
