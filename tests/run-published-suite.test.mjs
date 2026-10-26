import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { M4_FILES, parseOptions, runPublishedSuite, verifyIntegrity, verifyM4Report } from "./run-published-suite.mjs";

const owned = [];
const digest = (bytes) => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const versions = { "zigma-core": "0.1.3", "zigma-flow": "0.8.18", "zigma-workspace": "0.1.6" };
const payload = (short) => Buffer.from(short + " immutable test tarball");
const packageInfo = (short) => ({ name: "@zigma-ai/" + short, version: versions[short],
  dist: { integrity: digest(payload(short)), tarball: "https://registry.npmjs.org/@zigma-ai/" + short + "/-/package.tgz" } });

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "zigma-published-test-"));
  owned.push(root);
  for (const name of [...M4_FILES, 'tests/m4/helpers.ts']) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), '// synthetic test source identity fixture\n');
  }
  return root;
}

afterEach(async () => {
  for (const root of owned.splice(0)) {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("zigma-published-test-")) {
      throw new Error("Refusing cleanup outside an owned test prefix");
    }
    await rm(target, { recursive: true, force: true });
  }
});

function m4Report(root, status = "passed") {
  return { success: true, testResults: M4_FILES.map((file) => ({
    name: join(root, file), assertionResults: [{ title: file, status }]
  })) };
}

function fakeCommands(scenario = "pass", candidateVersion) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], ...options });
    await writeFile(options.logPath, "fake subprocess boundary: " + args.join(" "));
    let stdout = "", code = 0;
    if (args[0] === "fake-npm-cli.js") {
      const operation = args[1];
      if (operation === "view" || operation === "pack") {
        const short = args[2].match(/^@zigma-ai\/([^@]+)@/)[1];
        if (scenario === "registry-error" && operation === "view") return { code: 1, stdout: "", stderr: "registry unavailable" };
        if (operation === "view") stdout = JSON.stringify(packageInfo(short));
        else {
          const directory = args[args.indexOf("--pack-destination") + 1];
          const filename = short + "-" + versions[short] + ".tgz";
          await writeFile(join(directory, filename), scenario === "corrupt-tarball" ? "corrupt" : payload(short));
          stdout = JSON.stringify([{ name: scenario === "wrong-pack-name" ? "wrong" : "@zigma-ai/" + short,
            version: versions[short], filename, integrity: digest(payload(short)),
            files: [{ path: "package.json", size: 1 }, { path: "dist/cli.js", size: 1 }] }]);
        }
      } else if (operation === "install") {
        const runtime = args[args.indexOf("--prefix") + 1];
        const lock = { packages: {} };
        for (const short of Object.keys(versions)) {
          const name = "@zigma-ai/" + short;
          if (!args.some((arg) => arg.endsWith(short + "-" + versions[short] + ".tgz"))) continue;
          const root = join(runtime, "node_modules", name);
          await mkdir(join(root, "dist"), { recursive: true });
          await writeFile(join(root, "dist/cli.js"), "// installed fixture\n");
          await writeFile(join(root, "package.json"), JSON.stringify({ name, version: versions[short], bin: { [short]: "dist/cli.js" } }));
          lock.packages["node_modules/" + name] = { integrity: scenario === "wrong-lock" ? "sha512-wrong" : digest(payload(short)) };
        }
        await writeFile(join(runtime, "package-lock.json"), JSON.stringify(lock));
      } else throw new Error("Unexpected fake npm operation " + operation);
    } else if (command === "git") stdout = args[0] === "rev-parse" ? "fixture-revision\n" : " M tests/example\n";
    else if (args.includes("--version")) stdout = (candidateVersion ?? versions["zigma-core"]) + "\n";
    else if (args.includes("contract-info")) {
      stdout = args[0].includes("zigma-flow") ? JSON.stringify({ contractVersion: 1, provider: "zigma-flow",
        packageVersion: scenario === "bad-handshake" ? "0.0.0" : versions["zigma-flow"],
        capabilities: ["run-inspect-v1", "callback-http-delivery-v1"] }) : JSON.stringify({ ok: true,
        data: { contract_version: 1, provider: "zigma-workspace", package_version: versions["zigma-workspace"], managed_supported: true } });
    } else if (args[0].endsWith("vitest.mjs")) {
      const reportPath = args.find((arg) => arg.startsWith("--outputFile=")).slice("--outputFile=".length);
      await writeFile(reportPath, JSON.stringify(m4Report(options.cwd, scenario === "skip-m4" ? "pending" : "passed")));
      if (scenario === "failed-m4") code = 1;
    } else throw new Error("Unexpected fake child " + command + " " + args.join(" "));
    return { code, stdout, stderr: "", timedOut: false };
  };
  return { calls, run };
}

describe("published-suite orchestration (fake subprocesses, not real M4 proof)", () => {
  it("accepts only explicit supported CLI options", () => {
    expect(parseOptions([])).toEqual({});
    expect(parseOptions(["--core-cli", "dist/cli.js"]).coreCli).toBe(resolve("dist/cli.js"));
    for (const args of [["--unknown"], ["--core-cli"], ["--core-cli", "x", "--core-cli", "y"]]) {
      expect(() => parseOptions(args)).toThrow("Usage:");
    }
  });

  it("verifies actual tarball bytes against registry integrity", () => {
    verifyIntegrity(payload("zigma-core"), digest(payload("zigma-core")));
    expect(() => verifyIntegrity(Buffer.from("changed"), digest(payload("zigma-core")))).toThrow("integrity mismatch");
    expect(() => verifyIntegrity(Buffer.from("x"), "sha1-old")).toThrow("SHA-512");
  });

  it("requires all six files and every assertion to run and pass", () => {
    expect(verifyM4Report(m4Report("/repo"))).toEqual({ files: 6, passed: 6, failed: 0, skipped: 0 });
    expect(() => verifyM4Report(m4Report("/repo", "pending"))).toThrow("skipped");
    const missing = m4Report("/repo");
    missing.testResults.pop();
    expect(() => verifyM4Report(missing)).toThrow("missing required");
    const duplicate = m4Report("/repo");
    duplicate.testResults.push(duplicate.testResults[0]);
    expect(() => verifyM4Report(duplicate)).toThrow("missing required");
  });

  it("resolves latest once, installs verified exact tarballs, injects every CLI, and emits immutable identities", async () => {
    const root = await fixtureRoot(), fake = fakeCommands();
    const originalPath = process.env.PATH;
    const result = await runPublishedSuite({ root, artifactsDir: root }, { npmCli: "fake-npm-cli.js", runCommand: fake.run });
    expect(result.status).toBe("passed");
    expect(result.testStatus).toBe("passed");
    expect(result.mode).toBe("latest-published-suite");
    expect(result.packages.map((pkg) => pkg.version)).toEqual(Object.values(versions));
    expect(result.packages.every((pkg) => pkg.integrity && pkg.packManifestSha256 && pkg.cliSha256)).toBe(true);
    expect(fake.calls.filter((call) => call.args[1] === "view")).toHaveLength(3);
    expect(fake.calls.filter((call) => call.args[1] === "pack").every((call) => !call.args[2].includes("@latest"))).toBe(true);
    const install = fake.calls.find((call) => call.args[1] === "install");
    expect(install.args).toContain(result.cache);
    expect(install.args).not.toContain("--global");
    const test = fake.calls.find((call) => call.args[0].endsWith("vitest.mjs"));
    expect(test.args).toEqual(expect.arrayContaining(M4_FILES));
    for (const name of ["CORE", "FLOW", "WORKSPACE"]) expect(test.env["ZIGMA_" + name + "_CLI_PATH"]).toContain(result.artifactRoot);
    expect(test.env.PATH).toBe(originalPath);
    expect(process.env.PATH).toBe(originalPath);
    const saved = JSON.parse(await readFile(join(result.artifactRoot, "receipt.json"), "utf8"));
    expect(saved.finishedAt).toBeTruthy();
    expect(saved.runtimeLock.sha256).toBeTruthy();
    expect(Object.keys(saved.testSourceHashes)).toEqual([...M4_FILES, 'tests/m4/helpers.ts']);
    expect(Object.values(saved.testSourceHashes).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(JSON.parse(await readFile(result.suiteLock.path, "utf8")).packages).toHaveLength(3);
  });

  it("labels a local candidate Core honestly while keeping both providers published and pinned", async () => {
    const root = await fixtureRoot(), candidate = join(root, "candidate"), cli = join(candidate, "dist/cli.js");
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(cli, "// independently identified candidate\n");
    await writeFile(join(candidate, "package.json"), JSON.stringify({ name: "@zigma-ai/zigma-core", version: "9.0.0", bin: { "zigma-core": "dist/cli.js" } }));
    const fake = fakeCommands("pass", "9.0.0");
    const result = await runPublishedSuite({ root, artifactsDir: root, coreCli: cli }, { npmCli: "fake-npm-cli.js", runCommand: fake.run });
    expect(result.mode).toBe("candidate-core-with-published-providers");
    expect(result.packages[0]).toMatchObject({ source: "candidate-local-cli", integrity: null, revision: "fixture-revision", version: "9.0.0" });
    expect(result.packages[0].sourceBuildAttestation).toContain("not established");
    expect(fake.calls.filter((call) => call.args[1] === "view")).toHaveLength(2);
    expect(fake.calls.some((call) => call.args.includes("@zigma-ai/zigma-core@latest"))).toBe(false);
  });

  it.each(["registry-error", "corrupt-tarball", "wrong-pack-name", "wrong-lock", "bad-handshake"])("fails closed and retains its receipt before M4 for %s", async (scenario) => {
    const root = await fixtureRoot(), fake = fakeCommands(scenario);
    let failure;
    try { await runPublishedSuite({ root, artifactsDir: root }, { npmCli: "fake-npm-cli.js", runCommand: fake.run }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const receipt = JSON.parse(await readFile(failure.receiptPath, "utf8"));
    expect(receipt.status).toBe("failed");
    expect(receipt.testStatus).toBe("not_run");
    expect(fake.calls.some((call) => call.args[0].endsWith("vitest.mjs"))).toBe(false);
  });

  it.each(["skip-m4", "failed-m4"])("cannot report success for %s, even if the test launcher exits zero", async (scenario) => {
    const root = await fixtureRoot(), fake = fakeCommands(scenario);
    let failure;
    try { await runPublishedSuite({ root, artifactsDir: root }, { npmCli: "fake-npm-cli.js", runCommand: fake.run }); }
    catch (error) { failure = error; }
    const receipt = JSON.parse(await readFile(failure.receiptPath, "utf8"));
    expect(receipt.status).toBe("failed");
    expect(receipt.testStatus).toBe("failed");
  });
});
