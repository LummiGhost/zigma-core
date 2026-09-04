import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const flowCliPath = resolve(flowRoot, "dist", "cli.js");
const workspaceCliPath = resolve(workspaceRoot, "dist", "cli", "index.js");

// Source builds do not promise executable mode for emitted JavaScript. The
// installed npm bins do, and Core invokes the CLI path directly, so mirror that
// installation boundary before injecting absolute paths into the real gate.
chmodSync(flowCliPath, 0o755);
chmodSync(workspaceCliPath, 0o755);
run(flowCliPath, ["contract-info", "--json"], flowRoot);
run(workspaceCliPath, ["contract-info", "--json"], workspaceRoot);

run(process.execPath, [
  resolve(coreRoot, "node_modules", "vitest", "vitest.mjs"),
  "run",
  "tests/adapters/m0-real-cli.contract.test.ts"
], coreRoot, {
  ...process.env,
  ZIGMA_FLOW_CLI_PATH: flowCliPath,
  ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath
});
