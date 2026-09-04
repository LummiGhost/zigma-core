import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExeca = vi.fn();

vi.mock("execa", () => ({
  execa: mockExeca
}));

const { ZigmaWorkspaceCliAdapter } = await import("../../src/adapters/zigma-workspace-cli.js");

function contractInfo(overrides: Record<string, unknown> = {}) {
  return {
    stdout: okEnvelope({
      provider: "zigma-workspace",
      package_version: "0.1.5",
      contract_version: 1,
      capabilities: [
        "workspace-create-v1",
        "workspace-bind-run-v1",
        "workspace-diff-artifact-v1",
        "workspace-snapshot-artifacts-v1",
        "workspace-cleanup-v1"
      ],
      ...overrides
    }),
    exitCode: 0
  };
}

let adapter: InstanceType<typeof ZigmaWorkspaceCliAdapter>;
const tempDirs: string[] = [];

beforeEach(() => {
  mockExeca.mockReset();
  adapter = new ZigmaWorkspaceCliAdapter();
  mockExeca.mockResolvedValueOnce(contractInfo());
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function okEnvelope(data: Record<string, unknown>): string {
  return JSON.stringify({ contract_version: 1, ok: true, data });
}

function workspaceData(): Record<string, unknown> {
  return {
    workspace_id: "ws-1",
    path: "/tmp/workspaces/ws-1",
    branch: "task/1",
    base_ref: "main",
    base_commit: "abc123",
    mode: "writable",
    status: "READY",
    manifest_path: "/tmp/workspaces/ws-1/.zigma-workspace.json",
    created_at: "2026-09-01T00:00:00.000Z"
  };
}

function preparationRequest() {
  return {
    projectId: "project-1",
    taskId: "task-1",
    flowRunId: "flow-run-1",
    repository: {
      id: "repository-1",
      provider: "github" as const,
      url: "https://example.test/repository.git",
      defaultRef: "main",
      writable: true,
      metadata: {}
    },
    baseRef: "main",
    branch: "task/1",
    policy: {
      provider: "zigma-workspace-cli" as const,
      mode: "writable" as const,
      branchTemplate: "zigma/{taskId}",
      cleanup: "on-success" as const,
      snapshotOnTerminal: true
    },
    command: "zigma-workspace",
    timeoutMs: 60_000,
    environment: {}
  };
}

describe("ZigmaWorkspaceCliAdapter", () => {
  it("accepts contract version 1 and maps create output", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope(workspaceData()),
      exitCode: 0
    });

    const result = await adapter.prepare(preparationRequest());

    expect(result.externalId).toBe("ws-1");
    expect(result.path).toBe("/tmp/workspaces/ws-1");
    expect(result.baseCommit).toBe("abc123");
  });

  it("passes a stable create operation id derived from the flow run", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope(workspaceData()),
      exitCode: 0
    });

    await adapter.prepare(preparationRequest());

    const args = mockExeca.mock.lastCall?.[1] as string[];
    expect(args).toContain("--json");
    expect(args).toContain("--operation-id");
    expect(args).toContain("core:workspace:create:flow-run-1");
  });

  it("performs and caches a provider handshake before workspace commands", async () => {
    mockExeca.mockResolvedValueOnce({ stdout: okEnvelope(workspaceData()), exitCode: 0 });
    mockExeca.mockResolvedValueOnce({ stdout: okEnvelope(workspaceData()), exitCode: 0 });

    await adapter.prepare(preparationRequest());
    await adapter.prepare({ ...preparationRequest(), flowRunId: "flow-run-2" });

    expect(mockExeca).toHaveBeenCalledTimes(3);
    expect(mockExeca.mock.calls[0]?.[1]).toEqual(["contract-info", "--json"]);
    expect(mockExeca.mock.calls[1]?.[1]).toContain("create");
    expect(mockExeca.mock.calls[2]?.[1]).toContain("create");
  });

  it("fails closed on an unknown provider version before create", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ contract_version: 99, ok: true, data: {} }),
      exitCode: 0
    });

    await expect(adapter.prepare(preparationRequest())).rejects.toThrow(
      "zigma-workspace contract version mismatch: expected 1, got 99"
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a required provider capability is absent", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ capabilities: ["workspace-create-v1"] }));

    await expect(adapter.prepare(preparationRequest())).rejects.toThrow(
      "zigma-workspace is missing required provider capabilities"
    );
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it("accepts a compatible provider release with a different diagnostic package_version", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ package_version: "0.1.6" }));
    mockExeca.mockResolvedValueOnce({ stdout: okEnvelope(workspaceData()), exitCode: 0 });

    await expect(adapter.prepare(preparationRequest())).resolves.toMatchObject({ externalId: "ws-1" });
  });

  it("rejects a missing diagnostic package_version", async () => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValueOnce(contractInfo({ package_version: "" }));

    await expect(adapter.prepare(preparationRequest())).rejects.toThrow(
      "zigma-workspace contract-info package_version must be a non-empty string"
    );
  });

  it("rejects an unsupported contract version", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ contract_version: 2, ok: true, data: workspaceData() }),
      exitCode: 0
    });

    await expect(adapter.prepare(preparationRequest())).rejects.toThrow(
      "zigma-workspace contract version mismatch: expected 1, got 2"
    );
  });

  it("preserves structured provider failures", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        contract_version: 1,
        ok: false,
        error: {
          code: "WORKSPACE_LOCK_CONFLICT",
          message: "workspace is locked",
          details: { owner: "flow-2" }
        }
      }),
      exitCode: 1
    });

    await expect(adapter.prepare(preparationRequest())).rejects.toMatchObject({
      message: "workspace is locked",
      details: expect.objectContaining({
        providerCode: "WORKSPACE_LOCK_CONFLICT",
        details: { owner: "flow-2" }
      })
    });
  });

  it("rejects a malformed stdout error envelope", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ contract_version: 1, ok: false, error: { code: "BROKEN" } }),
      exitCode: 1
    });

    await expect(adapter.prepare(preparationRequest())).rejects.toThrow(
      "zigma-workspace error envelope is malformed"
    );
  });

  it("rejects cleanup when the provider does not confirm removal", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope({
        workspace_id: "ws-1",
        path: "/tmp/workspaces/ws-1",
        removed: false,
        message: "Failed to remove workspace directory: file is busy"
      }),
      exitCode: 0
    });

    await expect(
      adapter.cleanup("ws-1", {
        command: "zigma-workspace",
        timeoutMs: 60_000,
        environment: {}
      })
    ).rejects.toThrow("zigma-workspace did not confirm physical cleanup");
  });

  it("accepts cleanup only when physical removal is confirmed", async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope({
        workspace_id: "ws-1",
        path: "/tmp/workspaces/ws-1",
        removed: true,
        message: "Worktree removed from mirror and filesystem"
      }),
      exitCode: 0
    });

    await expect(
      adapter.cleanup("ws-1", {
        command: "zigma-workspace",
        timeoutMs: 60_000,
        environment: {}
      })
    ).resolves.toBeUndefined();
  });

  it("maps verified diff.patch_artifact and snapshot.artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "core-workspace-artifacts-"));
    tempDirs.push(directory);
    const patchPath = join(directory, "change.patch");
    const metadataPath = join(directory, "snapshot.json");
    await writeFile(patchPath, "diff --git a/a b/a\n", "utf8");
    await writeFile(metadataPath, "{\"snapshot\":true}\n", "utf8");
    const digest = async (path: string) => `sha256:${createHash("sha256").update(await import("node:fs/promises").then((fs) => fs.readFile(path))).digest("hex")}`;
    const patchDigest = await digest(patchPath);
    const metadataDigest = await digest(metadataPath);
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope({
        workspace_id: "ws-1",
        base_commit: "abc123",
        head_commit: "def456",
        changed_files: ["a"],
        untracked_files: [],
        status_text: "M a",
        patch_artifact: { uri: pathToFileURL(patchPath).href, media_type: "text/x-diff", digest: patchDigest },
        summary: "one changed file"
      }),
      exitCode: 0
    });
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope({
        snapshot_id: "snap-1",
        workspace_id: "ws-1",
        kind: "git",
        artifacts: [{
          id: "artifact-1",
          kind: "metadata",
          uri: pathToFileURL(metadataPath).href,
          media_type: "application/json",
          digest: metadataDigest
        }],
        created_at: "2026-09-01T00:00:00.000Z"
      }),
      exitCode: 0
    });

    const evidence = await adapter.collectEvidence("ws-1", {
      command: "zigma-workspace",
      timeoutMs: 60_000,
      environment: {}
    });

    expect(evidence.items).toHaveLength(2);
    expect(evidence.items[0]).toMatchObject({ uri: pathToFileURL(patchPath).href, digest: patchDigest });
    expect(evidence.items[1]).toMatchObject({ uri: pathToFileURL(metadataPath).href, digest: metadataDigest });
  });

  it("rejects a tampered artifact before returning or snapshotting evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "core-workspace-tampered-"));
    tempDirs.push(directory);
    const patchPath = join(directory, "change.patch");
    await writeFile(patchPath, "tampered bytes", "utf8");
    mockExeca.mockResolvedValueOnce({
      stdout: okEnvelope({
        workspace_id: "ws-1",
        base_commit: "abc123",
        head_commit: null,
        changed_files: ["a"],
        untracked_files: [],
        status_text: "M a",
        patch_artifact: {
          uri: pathToFileURL(patchPath).href,
          media_type: "text/x-diff",
          digest: `sha256:${"0".repeat(64)}`
        },
        summary: "tampered"
      }),
      exitCode: 0
    });

    await expect(adapter.collectEvidence("ws-1", {
      command: "zigma-workspace",
      timeoutMs: 60_000,
      environment: {}
    })).rejects.toThrow("artifact digest mismatch");
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });
});
