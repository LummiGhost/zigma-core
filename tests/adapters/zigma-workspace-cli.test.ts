import { describe, expect, it, vi } from "vitest";

const mockExeca = vi.fn();

vi.mock("execa", () => ({
  execa: mockExeca
}));

const { ZigmaWorkspaceCliAdapter } = await import("../../src/adapters/zigma-workspace-cli.js");

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
  const adapter = new ZigmaWorkspaceCliAdapter();

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
});
