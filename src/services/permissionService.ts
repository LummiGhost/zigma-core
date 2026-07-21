/**
 * Permission service (FR-006, FR-011).
 *
 * Responsibilities:
 *   - Build an immutable PermissionSnapshot per task/run.
 *   - Project the structured Core grants onto zigma-flow's flat
 *     `permissions: string[]` (host-api CallerContext shape).
 *
 * Permission string mapping (stable contract, see docs/design.md §7):
 *
 *   canReadCode           -> "code:read"
 *   canWriteCode          -> "code:write"
 *   canCreateBranch       -> "branch:create"
 *   canCreatePullRequest  -> "pr:create"
 *   canMergePullRequest   -> "pr:merge"
 *   canApproveHumanGate   -> "gate:approve"  (+ flow "run:decide")
 *   (always for a started run) "workflow:execute", "run:resume", "run:cancel"
 *   allowedTools          -> "tool:<name>" entries
 *   allowedWorkflows      -> "workflow:<name>" entries
 */

import type {
  ActorRef,
  FlowCallerContext,
  PermissionGrants,
  PermissionSnapshot,
  TaskSource,
} from "../types/index.js";
import { PermissionGrantsSchema } from "../types/index.js";
import type { Repos } from "../db/repos.js";

export const CORE_SYSTEM_NAME = "zigma-core";
export const CORE_SYSTEM_VERSION = "0.1.0";

export function grantsToPermissionStrings(grants: PermissionGrants): string[] {
  const perms: string[] = ["workflow:execute", "run:resume", "run:cancel"];
  if (grants.canReadCode) perms.push("code:read");
  if (grants.canWriteCode) perms.push("code:write");
  if (grants.canCreateBranch) perms.push("branch:create");
  if (grants.canCreatePullRequest) perms.push("pr:create");
  if (grants.canMergePullRequest) perms.push("pr:merge");
  if (grants.canApproveHumanGate) {
    perms.push("gate:approve");
    perms.push("run:decide");
  }
  for (const tool of grants.allowedTools) perms.push(`tool:${tool}`);
  for (const wf of grants.allowedWorkflows) perms.push(`workflow:${wf}`);
  return perms;
}

export class PermissionService {
  constructor(private repos: Repos) {}

  createSnapshot(input: {
    taskId: string;
    actor: ActorRef;
    source: TaskSource;
    projectId: string;
    repositoryIds: string[];
    grants: Partial<PermissionGrants>;
    expiresAt?: string;
  }): PermissionSnapshot {
    const grants = PermissionGrantsSchema.parse(input.grants ?? {});
    const revision = this.repos.snapshots.latestRevision(input.taskId) + 1;
    const snapshot = this.repos.snapshots.insert({
      taskId: input.taskId,
      revision,
      actor: input.actor,
      source: input.source,
      projectScope: { projectId: input.projectId, repositoryIds: input.repositoryIds },
      grants,
      expiresAt: input.expiresAt,
    });
    this.repos.audit.append({
      type: "permission_snapshot.created",
      actor: input.actor,
      projectId: input.projectId,
      taskId: input.taskId,
      detail: { snapshotId: snapshot.id, revision, grants },
    });
    return snapshot;
  }

  /** Build the CallerContext in the exact shape zigma-flow host-api expects. */
  toFlowCallerContext(snapshot: PermissionSnapshot): FlowCallerContext {
    const actor = snapshot.actor;
    return {
      user: {
        id: actor.id,
        name: actor.name ?? actor.id,
        email: actor.email ?? "",
      },
      actor: { type: actor.type, id: actor.id, name: actor.name },
      source: { system: CORE_SYSTEM_NAME, version: CORE_SYSTEM_VERSION },
      permissions: grantsToPermissionStrings(snapshot.grants),
      project: {
        id: snapshot.projectScope.projectId,
        scope: snapshot.projectScope.repositoryIds.join(","),
      },
    };
  }

  /** Is this actor allowed to decide the given gate under this snapshot? */
  canApprove(snapshot: PermissionSnapshot, actor: ActorRef, allowedApprovers: ActorRef[]): boolean {
    if (allowedApprovers.length > 0) {
      return allowedApprovers.some((a) => a.id === actor.id || a.email === actor.email);
    }
    // Fall back to the run's permission snapshot: only the snapshot's own actor
    // may decide, and only when the snapshot grants gate approval. Other actors
    // must be listed in allowedApprovers explicitly.
    return snapshot.actor.id === actor.id && snapshot.grants.canApproveHumanGate;
  }
}
