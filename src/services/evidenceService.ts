/**
 * Evidence service (FR-009).
 *
 * Assembles a platform-level EvidenceBundle from:
 *   - zigma-flow status mirror (jobs, artifacts, events, validation-ish data)
 *   - zigma-workspace diff (when a workspace is bound)
 *   - Core-side records: human decisions, external links, permission snapshot
 *
 * When zigma-flow ships a machine-readable `evidence <run-id> --json`
 * command (upstream issue), the flow-derived section can be replaced with a
 * direct call and the rest of this service stays unchanged.
 */

import type { Repos } from "../db/repos.js";
import { invalidState, notFound } from "../errors.js";
import type { EvidenceBundle, ValidationEvidence } from "../types/index.js";
import type { FlowInvoker, FlowRunStatusMirror } from "../adapters/flow/types.js";
import type { WorkspaceClient } from "../adapters/workspace/index.js";

export class EvidenceService {
  constructor(
    private repos: Repos,
    private invoker: FlowInvoker,
    private workspaceClient?: WorkspaceClient
  ) {}

  async collect(taskId: string, flowRunRefId?: string): Promise<EvidenceBundle> {
    const task = this.repos.tasks.get(taskId);
    if (!task) throw notFound("Task", taskId);

    const runs = this.repos.flowRuns.listByTask(taskId);
    const run = flowRunRefId
      ? runs.find((r) => r.id === flowRunRefId)
      : runs.at(-1);
    if (!run) throw invalidState(`Task ${taskId} has no flow runs to collect evidence from`);

    let mirror: FlowRunStatusMirror | undefined;
    if (run.zigmaFlowRunId) {
      try {
        mirror = await this.invoker.getStatus(run.invocationCwd, run.zigmaFlowRunId);
      } catch {
        mirror = undefined; // degrade gracefully; core-side evidence still recorded
      }
    }

    const validation: ValidationEvidence[] = [];
    if (mirror) {
      for (const ev of mirror.events) {
        const type = String((ev as any).type ?? (ev as any).event ?? "");
        if (type.includes("check")) {
          const payload = (ev as any).payload ?? {};
          validation.push({
            jobId: (ev as any).jobId ?? (ev as any).job_id ?? payload.jobId,
            stepId: (ev as any).stepId ?? (ev as any).step_id ?? payload.stepId,
            name: typeof payload.name === "string" ? payload.name : type,
            passed:
              typeof payload.ok === "boolean"
                ? payload.ok
                : type.includes("passed")
                  ? true
                  : type.includes("failed")
                    ? false
                    : undefined,
            detail: typeof (ev as any).detail === "string" ? (ev as any).detail : undefined,
          });
        }
      }
    }

    // Workspace diff -> code change summary.
    const codeChanges = [] as EvidenceBundle["codeChanges"];
    const workspaces = this.repos.workspaces.listByTask(taskId);
    for (const ws of workspaces) {
      if (!this.workspaceClient) {
        codeChanges.push({
          workspaceId: ws.zigmaWorkspaceId,
          baseCommit: ws.baseCommit,
          changedFiles: [],
          untrackedFiles: [],
        });
        continue;
      }
      try {
        const diff = await this.workspaceClient.diff(ws.zigmaWorkspaceId);
        codeChanges.push({
          workspaceId: ws.zigmaWorkspaceId,
          baseCommit: diff.baseCommit ?? ws.baseCommit,
          headCommit: diff.headCommit,
          changedFiles: diff.changedFiles,
          untrackedFiles: diff.untrackedFiles,
          patchPath: diff.patchPath,
        });
      } catch {
        codeChanges.push({
          workspaceId: ws.zigmaWorkspaceId,
          baseCommit: ws.baseCommit,
          changedFiles: [],
          untrackedFiles: [],
        });
      }
    }

    const humanDecisions = this.repos.decisions.listByTask(taskId);
    const externalLinks = this.repos.links.listByTask(taskId);

    const risks: string[] = [];
    if (!mirror) risks.push("flow status mirror unavailable at collection time");
    if (mirror?.status === "failed") risks.push("flow run ended in failed status");
    if (run.errorMessage) risks.push(`run error: ${run.errorMessage}`);

    const summaryParts = [
      `Task "${task.title}" (${task.status})`,
      mirror ? `flow run ${mirror.runId} status=${mirror.status}` : `flow run status unknown`,
      `${mirror?.artifacts.length ?? 0} artifacts`,
      `${humanDecisions.length} human decisions`,
      `${externalLinks.length} external links`,
    ];

    const bundle = this.repos.evidence.insert({
      taskId,
      flowRunId: run.id,
      summary: summaryParts.join("; "),
      flowSummary: mirror
        ? {
            runId: mirror.runId,
            workflow: mirror.workflow,
            status: mirror.status,
            jobs: mirror.jobs,
            eventCount: mirror.events.length,
          }
        : undefined,
      flowArtifacts: mirror?.artifacts ?? [],
      validationEvidence: validation,
      codeChanges,
      externalLinks,
      humanDecisions,
      risks,
      permissionSnapshotId: run.permissionSnapshotId,
    });

    this.repos.flowRuns.update(run.id, { evidenceBundleId: bundle.id });
    this.repos.audit.append({
      type: "evidence.collected",
      taskId,
      projectId: task.projectId,
      flowRunId: run.id,
      detail: { evidenceBundleId: bundle.id, risks },
    });

    return bundle;
  }
}
