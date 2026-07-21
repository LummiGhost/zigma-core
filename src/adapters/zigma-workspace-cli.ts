import { execa } from "execa";
import type {
  PreparedWorkspace,
  WorkspaceEvidence,
  WorkspaceInvocationContext,
  WorkspacePreparationRequest,
  WorkspaceProvider
} from "../contracts/ports.js";
import { IntegrationError } from "../domain/errors.js";

interface WorkspaceEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

async function invoke<T>(context: WorkspaceInvocationContext, args: string[]): Promise<T> {
  const result = await execa(context.command, [...args, "--json"], {
    env: { ...process.env, ...context.environment },
    timeout: context.timeoutMs,
    reject: false,
    all: true
  });
  const output = result.stdout ?? result.all ?? "";
  let envelope: WorkspaceEnvelope<T>;
  try {
    envelope = JSON.parse(output) as WorkspaceEnvelope<T>;
  } catch {
    throw new IntegrationError("zigma-workspace returned invalid JSON", {
      command: context.command,
      args,
      exitCode: result.exitCode,
      output: output.slice(-4_000)
    });
  }
  if ((result.exitCode ?? 1) !== 0 || !envelope.ok || !envelope.data) {
    throw new IntegrationError(envelope.error ?? "zigma-workspace command failed", {
      command: context.command,
      args,
      exitCode: result.exitCode,
      details: envelope.details
    });
  }
  return envelope.data;
}

export class ZigmaWorkspaceCliAdapter implements WorkspaceProvider {
  async prepare(request: WorkspacePreparationRequest): Promise<PreparedWorkspace> {
    const data = await invoke<{
      workspace_id: string;
      path: string;
      branch: string;
      base_ref: string;
      base_commit: string;
      mode: "writable" | "read-only";
      status: string;
      manifest_path: string;
      created_at: string;
    }>({ command: request.command, timeoutMs: request.timeoutMs, environment: request.environment }, [
      "create",
      "--repo",
      request.repository.url,
      "--base",
      request.baseRef,
      "--branch",
      request.branch,
      "--mode",
      request.policy.mode,
      "--project",
      request.projectId,
      "--task",
      request.taskId,
      "--flow-run",
      request.flowRunId
    ]);
    return {
      provider: "zigma-workspace-cli",
      externalId: data.workspace_id,
      path: data.path,
      repositoryUrl: request.repository.url,
      baseRef: data.base_ref,
      baseCommit: data.base_commit,
      branch: data.branch,
      mode: data.mode,
      metadata: {
        manifestPath: data.manifest_path,
        providerStatus: data.status,
        providerCreatedAt: data.created_at
      }
    };
  }

  async bindRun(externalWorkspaceId: string, taskId: string, flowRunId: string, context: WorkspaceInvocationContext): Promise<void> {
    await invoke(context, [
      "bind-run",
      "--workspace",
      externalWorkspaceId,
      "--task",
      taskId,
      "--flow-run",
      flowRunId
    ]);
  }

  async collectEvidence(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<WorkspaceEvidence> {
    const diff = await invoke<{
      workspace_id: string;
      base_commit: string;
      head_commit: string | null;
      changed_files: string[];
      untracked_files: string[];
      status_text: string;
      patch_path: string | null;
      summary: string;
    }>(context, ["diff", "--workspace", externalWorkspaceId]);

    const snapshot = await invoke<{
      snapshot_id: string;
      workspace_id: string;
      kind: string;
      path: string | null;
      checksum: string | null;
      created_at: string;
    }>(context, ["snapshot", "--workspace", externalWorkspaceId]);

    return {
      items: [
        {
          kind: "workspace-diff",
          name: "workspace-diff",
          uri: diff.patch_path ?? `zigma-workspace://${externalWorkspaceId}/diff`,
          summary: diff.summary,
          metadata: {
            baseCommit: diff.base_commit,
            headCommit: diff.head_commit,
            changedFiles: diff.changed_files,
            untrackedFiles: diff.untracked_files,
            statusText: diff.status_text
          }
        },
        {
          kind: "workspace-snapshot",
          name: "workspace-snapshot",
          uri: snapshot.path ?? `zigma-workspace://${externalWorkspaceId}/snapshots/${snapshot.snapshot_id}`,
          ...(snapshot.checksum ? { digest: `sha256:${snapshot.checksum}` } : {}),
          metadata: {
            snapshotId: snapshot.snapshot_id,
            snapshotKind: snapshot.kind,
            createdAt: snapshot.created_at
          }
        }
      ]
    };
  }

  async cleanup(externalWorkspaceId: string, context: WorkspaceInvocationContext): Promise<void> {
    await invoke(context, ["cleanup", "--workspace", externalWorkspaceId]);
  }
}
