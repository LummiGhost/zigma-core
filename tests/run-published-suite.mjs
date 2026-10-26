import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org/";
const PREFIX = "zigma-published-suite-";
export const M4_FILES = [
  "tests/m4/m4-managed-parallel.test.ts",
  "tests/m4/m4-conflict-rollback.test.ts",
  "tests/m4/m4-cancel-and-rollback.test.ts",
  "tests/m4/m4-restart-recovery.test.ts",
  "tests/m4/m4-worker-kill.test.ts",
  "tests/m4/m4-invariants.test.ts"
];
const PACKAGES = ["zigma-core", "zigma-flow", "zigma-workspace"];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = { "--core-cli": "coreCli", "--artifacts-dir": "artifactsDir" }[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--") || options[key]) {
      throw new Error("Usage: node tests/run-published-suite.mjs [--core-cli PATH] [--artifacts-dir PARENT]");
    }
    options[key] = resolve(args[++i]);
  }
  return options;
}

export function verifyIntegrity(bytes, integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-") || integrity.includes(" ")) {
    throw new Error("Expected one registry SHA-512 integrity digest");
  }
  if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== integrity) {
    throw new Error("Package tarball integrity mismatch");
  }
}

export function verifyM4Report(report) {
  if (report.success !== true || !Array.isArray(report.testResults)) throw new Error("M4 report did not succeed");
  let passed = 0;
  for (const file of M4_FILES) {
    const rows = report.testResults.filter((row) => String(row.name).replaceAll("\\", "/").endsWith("/" + file));
    if (rows.length !== 1 || !Array.isArray(rows[0].assertionResults) || rows[0].assertionResults.length === 0) {
      throw new Error("M4 report missing required test file: " + file);
    }
    if (rows[0].assertionResults.some((test) => test.status !== "passed")) {
      throw new Error("M4 contains failed/skipped/unexecuted tests: " + file);
    }
    passed += rows[0].assertionResults.length;
  }
  return { files: M4_FILES.length, passed, failed: 0, skipped: 0 };
}

function npmCliPath() {
  const candidates = [process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  const path = candidates.find((value) => value && /npm-cli\.[cm]?js$/.test(value) && existsSync(value));
  if (!path) throw new Error("Cannot locate npm's JavaScript CLI; invoke this through npm run test:published-suite");
  return resolve(path);
}

/** Every child is owned by this command; timeout kills only that child's tree. */
export async function runCommand(command, args, options) {
  const log = createWriteStream(options.logPath);
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env,
      windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const capture = (stream, key) => stream?.on("data", (chunk) => {
      log.write(chunk);
      if (key === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    });
    capture(child.stdout, "stdout");
    capture(child.stderr, "stderr");
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else process.kill(-child.pid, "SIGKILL");
      } catch { child.kill("SIGKILL"); }
    }, options.timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); log.end(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      log.end(() => resolveResult({ code: code ?? 1, signal, timedOut, stdout, stderr }));
    });
  });
}

async function localCoreIdentity(path, execute) {
  const cliPath = resolve(path);
  if (!(await stat(cliPath)).isFile() || !/\.[cm]?js$/.test(cliPath)) throw new Error("Candidate Core CLI must be an existing JavaScript file");
  let directory = dirname(cliPath);
  let manifest, packageRoot;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) {
      const candidate = await json(join(directory, "package.json"));
      if (candidate.name === "@zigma-ai/zigma-core") { manifest = candidate; packageRoot = directory; break; }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Candidate CLI has no enclosing @zigma-ai/zigma-core package");
    directory = parent;
  }
  const expectedBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["zigma-core"];
  if (!expectedBin || resolve(packageRoot, expectedBin) !== cliPath) throw new Error("Candidate CLI differs from its package bin declaration");
  const revision = await execute("git", ["rev-parse", "HEAD"], "candidate-revision", packageRoot, true);
  const dirty = await execute("git", ["status", "--porcelain"], "candidate-status", packageRoot, true);
  const artifactFiles = {};
  const artifactDir = dirname(cliPath);
  const inventory = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Candidate artifact contains a symlink: " + file);
      if (entry.isDirectory()) await inventory(file);
      else if (entry.isFile()) artifactFiles[relative(artifactDir, file).replaceAll("\\", "/")] = sha256(await readFile(file));
    }
  };
  await inventory(artifactDir);
  const dependencyLock = join(packageRoot, "package-lock.json");
  return { name: manifest.name, version: manifest.version, source: "candidate-local-cli", integrity: null,
    cliPath, cliSha256: sha256(await readFile(cliPath)), packageRoot,
    artifactDir, artifactFiles, artifactInventorySha256: sha256(Buffer.from(JSON.stringify(artifactFiles))),
    dependencyLockSha256: existsSync(dependencyLock) ? sha256(await readFile(dependencyLock)) : null,
    manifestSha256: sha256(await readFile(join(packageRoot, "package.json"))),
    revision: revision.code === 0 ? revision.stdout.trim() : null,
    workingTreeStatus: dirty.code === 0 ? dirty.stdout.trim() : null,
    sourceBuildAttestation: "not established; candidate identity is the actual CLI hash and enclosing manifest" };
}

/** Install immutable tarballs in a new owned prefix; never build provider source. */
export async function runPublishedSuite(options = {}, dependencies = {}) {
  const run = dependencies.runCommand ?? runCommand;
  const root = resolve(options.root ?? ROOT);
  const parent = resolve(options.artifactsDir ?? tmpdir());
  await mkdir(parent, { recursive: true });
  const artifactRoot = await mkdtemp(join(parent, PREFIX));
  const runtime = join(artifactRoot, "runtime"), packs = join(artifactRoot, "packs"), cache = join(artifactRoot, "npm-cache");
  await Promise.all([runtime, packs, cache].map((path) => mkdir(path)));
  const receiptPath = join(artifactRoot, "receipt.json");
  const receipt = { schema: "zigma.published-suite/1", status: "running", startedAt: new Date().toISOString(),
    mode: options.coreCli ? "candidate-core-with-published-providers" : "latest-published-suite",
    artifactRoot, registry: REGISTRY, platform: process.platform, node: process.version, packages: [],
    testStatus: "not_run", tests: M4_FILES, commands: [], cache,
    installLifecycleScripts: "enabled inside the isolated prefix for native better-sqlite3" };
  await save(receiptPath, receipt);
  let step = 0;
  const execute = async (command, args, label, cwd = artifactRoot, allowFailure = false, env = process.env, timeoutMs = 120_000) => {
    const logPath = join(artifactRoot, `${String(++step).padStart(2, "0")}-${label}.log`);
    const result = await run(command, args, { cwd, env: { ...env }, logPath, timeoutMs });
    receipt.commands.push({ label, command, args, logPath, exitCode: result.code, timedOut: Boolean(result.timedOut) });
    await save(receiptPath, receipt);
    if (!allowFailure && (result.code !== 0 || result.timedOut)) throw new Error(label + " failed; inspect " + logPath);
    return result;
  };
  try {
    receipt.testSourceHashes = {};
    for (const file of [...M4_FILES, 'tests/m4/helpers.ts']) {
      receipt.testSourceHashes[file] = sha256(await readFile(join(root, file)));
    }
    await save(receiptPath, receipt);
    const npm = dependencies.npmCli ?? npmCliPath();
    const npmrc = join(artifactRoot, "npmrc");
    await writeFile(npmrc, `registry=${REGISTRY}\n@zigma-ai:registry=${REGISTRY}\n`);
    const installEnvironment = { ...process.env, npm_config_devdir: join(artifactRoot, "node-gyp-cache"),
      npm_package_config_node_gyp_devdir: join(artifactRoot, "node-gyp-cache") };
    const npmRun = (args, label, cwd = artifactRoot, timeout = 120_000) => execute(process.execPath,
      [npm, ...args, "--cache", cache, "--registry", REGISTRY, "--userconfig", npmrc], label, cwd, false, installEnvironment, timeout);
    const manifests = [], tarballs = [];
    const names = options.coreCli ? PACKAGES.slice(1) : PACKAGES;
    for (const short of names) {
      const name = "@zigma-ai/" + short;
      const metadata = JSON.parse((await npmRun(["view", name + "@latest", "--json"], "resolve-" + short)).stdout);
      if (metadata.name !== name || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version ?? "") ||
          typeof metadata.dist?.tarball !== "string" || !metadata.dist.tarball.startsWith(REGISTRY)) {
        throw new Error("Invalid registry identity for " + name);
      }
      const identity = { name, version: metadata.version, integrity: metadata.dist.integrity,
        tarball: metadata.dist.tarball, source: "npm-registry-latest-resolved", resolvedAt: new Date().toISOString() };
      receipt.packages.push(identity);
      await save(receiptPath, receipt);
      const packed = JSON.parse((await npmRun(["pack", name + "@" + metadata.version, "--json", "--ignore-scripts",
        "--pack-destination", packs], "pack-" + short)).stdout);
      const manifest = Array.isArray(packed) && packed.length === 1 ? packed[0] : null;
      if (!manifest || manifest.name !== name || manifest.version !== metadata.version ||
          typeof manifest.filename !== "string" || basename(manifest.filename) !== manifest.filename ||
          manifest.integrity !== identity.integrity || !Array.isArray(manifest.files)) {
        throw new Error("npm pack identity/manifest mismatch for " + name);
      }
      const tarball = join(packs, manifest.filename);
      verifyIntegrity(await readFile(tarball), identity.integrity);
      identity.packManifestSha256 = sha256(Buffer.from(JSON.stringify(manifest)));
      manifests.push(manifest);
      tarballs.push(tarball);
    }
    await save(join(artifactRoot, "npm-pack-manifests.json"), manifests);
    await save(join(artifactRoot, "suite-lock.json"), { registry: REGISTRY, packages: receipt.packages });
    await save(join(runtime, "package.json"), { name: "zigma-published-regression", private: true, version: "0.0.0" });
    // Workspace's native SQLite dependency needs its install lifecycle. npm's
    // prefix/cache and every generated file stay within this newly owned root.
    await npmRun(["install", "--prefix", runtime, "--save-exact", "--no-audit", "--no-fund", ...tarballs], "install-suite", runtime, 240_000);
    const lockPath = join(runtime, "package-lock.json"), lock = await json(lockPath);
    receipt.runtimeLock = { path: lockPath, sha256: sha256(await readFile(lockPath)) };
    for (const identity of receipt.packages) {
      const packageRoot = join(runtime, "node_modules", identity.name);
      const manifest = await json(join(packageRoot, "package.json"));
      const short = identity.name.slice("@zigma-ai/".length);
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[short];
      if (manifest.name !== identity.name || manifest.version !== identity.version || !bin ||
          lock.packages?.["node_modules/" + identity.name]?.integrity !== identity.integrity) {
        throw new Error("Installed identity differs from frozen registry tarball: " + identity.name);
      }
      identity.cliPath = resolve(packageRoot, bin);
      const binRelative = relative(packageRoot, identity.cliPath);
      if (isAbsolute(binRelative) || binRelative.startsWith("..")) throw new Error("Package CLI escapes installed prefix");
      identity.cliSha256 = sha256(await readFile(identity.cliPath));
      await chmod(identity.cliPath, 0o755);
    }
    if (options.coreCli) receipt.packages.unshift(await localCoreIdentity(options.coreCli, execute));
    const suiteLockPath = join(artifactRoot, "suite-lock.json");
    await save(suiteLockPath, { registry: REGISTRY, packages: receipt.packages });
    receipt.suiteLock = { path: suiteLockPath, sha256: sha256(await readFile(suiteLockPath)) };
    const byName = Object.fromEntries(receipt.packages.map((identity) => [identity.name, identity]));
    const core = byName["@zigma-ai/zigma-core"], flow = byName["@zigma-ai/zigma-flow"], workspace = byName["@zigma-ai/zigma-workspace"];
    const coreVersion = await execute(process.execPath, [core.cliPath, "--version"], "core-version");
    if (coreVersion.stdout.trim() !== core.version) throw new Error("Core CLI version differs from its locked identity");
    const flowInfo = JSON.parse((await execute(process.execPath, [flow.cliPath, "contract-info", "--json"], "flow-handshake")).stdout);
    const workspaceEnvelope = JSON.parse((await execute(process.execPath, [workspace.cliPath, "contract-info", "--json"], "workspace-handshake")).stdout);
    const workspaceInfo = workspaceEnvelope.data;
    if (flowInfo.contractVersion !== 1 || flowInfo.provider !== "zigma-flow" || flowInfo.packageVersion !== flow.version ||
        !Array.isArray(flowInfo.capabilities) || !["run-inspect-v1", "callback-http-delivery-v1"].every((capability) => flowInfo.capabilities.includes(capability))) {
      throw new Error("Published Flow lacks required real-platform handshake");
    }
    if (workspaceEnvelope.ok !== true || workspaceInfo?.contract_version !== 1 || workspaceInfo.provider !== "zigma-workspace" ||
        workspaceInfo.package_version !== workspace.version || workspaceInfo.managed_supported !== true) {
      throw new Error("Published Workspace lacks required managed handshake");
    }
    receipt.handshakes = { flow: flowInfo, workspace: workspaceInfo };
    receipt.testStatus = "running";
    await save(receiptPath, receipt);
    const reportPath = join(artifactRoot, "m4-report.json");
    const test = await execute(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", ...M4_FILES,
      "--reporter=json", "--outputFile=" + reportPath], "m4", root, true, {
      ...process.env, ZIGMA_CORE_CLI_PATH: core.cliPath, ZIGMA_FLOW_CLI_PATH: flow.cliPath,
      ZIGMA_WORKSPACE_CLI_PATH: workspace.cliPath
    }, 600_000);
    if (test.code !== 0 || test.timedOut) throw new Error("Published-suite M4 failed; inspect test log/report");
    receipt.testSummary = verifyM4Report(await json(reportPath));
    for (const [file, digest] of Object.entries(receipt.testSourceHashes)) {
      if (sha256(await readFile(join(root, file))) !== digest) throw new Error('M4 test source changed during execution: ' + file);
    }
    receipt.testStatus = "passed";
    receipt.status = "passed";
    receipt.testReport = reportPath;
    return receipt;
  } catch (error) {
    receipt.status = "failed";
    if (receipt.testStatus === "running") receipt.testStatus = "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    const failure = new Error(receipt.error, { cause: error });
    failure.receiptPath = receiptPath;
    throw failure;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await save(receiptPath, receipt);
    console.log("Published-suite receipt: " + receiptPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPublishedSuite(parseOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
