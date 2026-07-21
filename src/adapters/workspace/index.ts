/**
 * WorkspaceClient — Core-side contract with zigma-workspace.
 *
 * zigma-workspace v0.1 already exposes `--json` on all commands, so the
 * local CLI adapter parses `{ ok, data | error }` envelopes directly.
 */

import { execa } from "execa";
import { CoreError } from "../../errors.js";

export interface CreateWorkspaceRequest {
  repositoryUrl: string;
  baseRef: string;
  branch: string;
  mode?: "writable" | "read-only";
  projectId?: string;
  taskId?: string;
  flowRunId?: string;
}

export interface WorkspaceInfo {
  workspaceId: string;
  path: string;
  branch?: string;
  baseRef?: string;
  baseCommit?: string;
  mode?: string;
  status?: string;
}

export interface WorkspaceDiff {
  workspaceId: string;
  baseCommit?: string;
  headCommit?: string;
  changedFiles: string[];
  untrackedFiles: string[];
  patchPath?: string;
}

export interface WorkspaceClient {
  create(req: CreateWorkspaceRequest): Promise<WorkspaceInfo>;
  bindRun(workspaceId: string, opts: { taskId?: string; flowRunId?: string }): Promise<void>;
  diff(workspaceId: string, patchOut?: string): Promise<WorkspaceDiff>;
}

export class LocalCliWorkspaceClient implements WorkspaceClient {
  constructor(private readonly command = "zigma-workspace") {}

  private async run(args: string[]): Promise<any> {
    const result = await execa(this.command, [...args, "--json"], { reject: false });
    let parsed: any;
    try {
      parsed = JSON.parse(String(result.stdout));
    } catch {
      throw new CoreError("WORKSPACE_FAILED", "zigma-workspace did not return JSON", {
        args,
        stderr: String(result.stderr ?? "").slice(-1000),
      });
    }
    if (parsed.ok === false || result.failed) {
      throw new CoreError("WORKSPACE_FAILED", parsed.error ?? "zigma-workspace command failed", { args });
    }
    return parsed.data ?? parsed;
  }

  async create(req: CreateWorkspaceRequest): Promise<WorkspaceInfo> {
    const args = [
      "create",
      "--repo",
      req.repositoryUrl,
      "--base",
      req.baseRef,
      "--branch",
      req.branch,
      "--mode",
      req.mode ?? "writable",
    ];
    if (req.projectId) args.push("--project", req.projectId);
    if (req.taskId) args.push("--task", req.taskId);
    if (req.flowRunId) args.push("--flow-run", req.flowRunId);
    const data = await this.run(args);
    return {
      workspaceId: data.workspace_id ?? data.id,
      path: data.path,
      branch: data.branch,
      baseRef: data.base_ref,
      baseCommit: data.base_commit,
      mode: data.mode,
      status: data.status,
    };
  }

  async bindRun(workspaceId: string, opts: { taskId?: string; flowRunId?: string }): Promise<void> {
    const args = ["bind-run", "--workspace", workspaceId];
    if (opts.taskId) args.push("--task", opts.taskId);
    if (opts.flowRunId) args.push("--flow-run", opts.flowRunId);
    await this.run(args);
  }

  async diff(workspaceId: string, patchOut?: string): Promise<WorkspaceDiff> {
    const args = ["diff", "--workspace", workspaceId];
    if (patchOut) args.push("--patch-out", patchOut);
    const data = await this.run(args);
    return {
      workspaceId: data.workspaceId ?? data.workspace_id ?? workspaceId,
      baseCommit: data.baseCommit ?? data.base_commit,
      headCommit: data.headCommit ?? data.head_commit,
      changedFiles: data.changedFiles ?? data.changed_files ?? [],
      untrackedFiles: data.untrackedFiles ?? data.untracked_files ?? [],
      patchPath: patchOut,
    };
  }
}
