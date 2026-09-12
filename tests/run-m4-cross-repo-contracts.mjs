import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// M4 cross-repo evidence: builds zigma-flow, zigma-workspace, and zigma-core
// from source, proves both provider handshakes, then runs the env-gated M4
// tests against the real built CLIs (a real Core serve process driving real
// Flow and Workspace processes through the full managed lifecycle).
//
// Usage:
//   ZIGMA_FLOW_REPO=<flow checkout> ZIGMA_WORKSPACE_REPO=<workspace checkout> \
//   npm run test:m4-cross-repo

const coreRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const flowRoot = process.env.ZIGMA_FLOW_REPO;
const workspaceRoot = process.env.ZIGMA_WORKSPACE_REPO;

if (!flowRoot || !workspaceRoot) {
  console.error("ZIGMA_FLOW_REPO and ZIGMA_WORKSPACE_REPO must point to source checkouts");
  process.exit(2);
}

function packageName(root) {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name;
}

if (packageName(flowRoot) !== "@zigma-ai/zigma-flow") throw new Error("ZIGMA_FLOW_REPO is not zigma-flow");
if (packageName(workspaceRoot) !== "@zigma-ai/zigma-workspace") throw new Error("ZIGMA_WORKSPACE_REPO is not zigma-workspace");

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["run", "build"], flowRoot);
run("npm", ["run", "build"], workspaceRoot);
run("npm", ["run", "build"], coreRoot);

const flowCliPath = resolve(flowRoot, "dist", "cli.js");
const workspaceCliPath = resolve(workspaceRoot, "dist", "cli", "index.js");
const coreCliPath = resolve(coreRoot, "dist", "cli.js");

// Source builds do not promise executable mode for emitted JavaScript. The
// installed npm bins do, and Core invokes the CLI paths directly, so mirror
// that installation boundary before injecting absolute paths into the gate.
chmodSync(flowCliPath, 0o755);
chmodSync(workspaceCliPath, 0o755);
chmodSync(coreCliPath, 0o755);

// Provider handshake smokes: any failure here is a provider-side regression,
// not a Core one.
run(flowCliPath, ["contract-info", "--json"], flowRoot);
run(workspaceCliPath, ["contract-info", "--json"], workspaceRoot);

run(process.execPath, [
  resolve(coreRoot, "node_modules", "vitest", "vitest.mjs"),
  "run",
  "tests/m4/m4-managed-parallel.test.ts",
  "tests/m4/m4-conflict-rollback.test.ts",
  "tests/m4/m4-cancel-and-rollback.test.ts",
  "tests/m4/m4-restart-recovery.test.ts",
  "tests/m4/m4-worker-kill.test.ts",
  "tests/m4/m4-invariants.test.ts"
], coreRoot, {
  ...process.env,
  ZIGMA_FLOW_CLI_PATH: flowCliPath,
  ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath,
  ZIGMA_CORE_CLI_PATH: coreCliPath
});
