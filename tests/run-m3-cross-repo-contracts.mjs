import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execaSync } from "execa";
import { fileURLToPath } from "node:url";

// M3.5 cross-repo evidence: builds zigma-flow and zigma-workspace from source,
// proves both provider handshakes (including the managed-role negotiation),
// then runs the env-gated M3 contract tests against the real built CLIs.
//
// Usage:
//   ZIGMA_FLOW_REPO=<flow checkout> ZIGMA_WORKSPACE_REPO=<workspace checkout> \
//   npm run test:m3-cross-repo

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
  const javascript = /\.[cm]?js$/i.test(command);
  const result = execaSync(javascript ? process.execPath : command, javascript ? [command, ...args] : args, {
    cwd, env, stdio: "inherit", reject: false, windowsHide: true
  });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
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

// Provider handshake smokes: Flow's contract-info, Workspace's contract-info,
// and the managed-role negotiation the Flow bridge relies on. Any failure here
// is a provider-side regression, not a Core one.
run(flowCliPath, ["contract-info", "--json"], flowRoot);
run(workspaceCliPath, ["contract-info", "--json"], workspaceRoot);
run(workspaceCliPath, ["negotiate", "--role", "managed", "--json"], workspaceRoot);

run(process.execPath, [
  resolve(coreRoot, "node_modules", "vitest", "vitest.mjs"),
  "run",
  "tests/adapters/m3-negotiation-agreement.contract.test.ts",
  "tests/adapters/m3-managed-lifecycle.contract.test.ts"
], coreRoot, {
  ...process.env,
  ZIGMA_FLOW_CLI_PATH: flowCliPath,
  ZIGMA_WORKSPACE_CLI_PATH: workspaceCliPath
});
