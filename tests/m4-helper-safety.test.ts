import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { killProcessTree, processTreeKillOrder, rmWithRetry } from "./m4/helpers.js";

// A failing boundary regression must never actually delete a user directory
// or kill a process; mocks stay confined to this isolated test module.
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), rm: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn()
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("M4 harness cleanup boundaries", () => {
  it("allows only direct temporary roots created under the M4 prefix", async () => {
    const root = resolve(join(tmpdir(), "zigma-core-m4-owned-fixture"));
    await rmWithRetry(root);
    expect(rm).toHaveBeenCalledExactlyOnceWith(root, { recursive: true, force: true });
  });

  it("rejects parent, unrelated and nested directories before recursive removal", async () => {
    for (const target of [tmpdir(), join(tmpdir(), "unrelated"),
      join(tmpdir(), "zigma-core-m4-owned-fixture", "child"), resolve(".")]) {
      await expect(rmWithRetry(target)).rejects.toThrow("Refusing recursive cleanup");
    }
    expect(rm).not.toHaveBeenCalled();
  });

  it("keeps a failed cleanup nonzero after bounded retries", async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error("locked fixture"));
    await expect(rmWithRetry(join(tmpdir(), "zigma-core-m4-locked-fixture"), 0)).rejects.toThrow("locked fixture");
  });

  it("snapshots the entire owned subtree and orders descendants before their parent", () => {
    const table = "900001 1\n900002 900001\n900003 900002\n900004 900001\n990001 1\n";
    expect(processTreeKillOrder(900001, table)).toEqual([900003, 900002, 900004, 900001]);
    expect(processTreeKillOrder(900001, "900001 900002\n900002 900001\n")).toEqual([900002, 900001]);
  });

  it("rejects self, init and malformed process identifiers", () => {
    for (const pid of [process.pid, 1, 0, -1, 1.5, Number.NaN]) {
      expect(() => processTreeKillOrder(pid, "")).toThrow("Unsafe provider process id");
      expect(() => killProcessTree(pid)).toThrow("Unsafe provider process id");
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("collects Linux descendants before sending any kill", () => {
    vi.mocked(execFileSync).mockReturnValue("900001 1\n900002 900001\n900003 900002\n");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    killProcessTree(900001);
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
    });
    expect(kill.mock.calls).toEqual([[900003, "SIGKILL"], [900002, "SIGKILL"], [900001, "SIGKILL"]]);
  });
});
