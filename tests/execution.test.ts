import { describe, expect, it } from "vitest";
import { makeCore, seedProjectAndTask } from "./helpers.js";
import { grantsToPermissionStrings } from "../src/services/permissionService.js";
import { CoreError } from "../src/errors.js";

describe("startTask (FR-004/FR-011)", () => {
  it("starts a flow run, records FlowRunRef and immutable permission snapshot", async () => {
    const { core, invoker } = makeCore();
    const { task, project } = seedProjectAndTask(core);

    const ref = await core.startTask(task.id, {
      actor: { type: "user", id: "alice", name: "Alice" },
      grants: { canWriteCode: true, canCreatePullRequest: true, canCreateBranch: true },
    });

    expect(ref.zigmaFlowRunId).toMatch(/^2026-run-/);
    expect(ref.status).toBe("running");
    expect(core.getTask(task.id).status).toBe("running");
    expect(core.getTask(task.id).currentFlowRunId).toBe(ref.id);

    // Caller context passed to flow follows the host-api shape.
    const req = invoker.invocations[0];
    expect(req.workflow).toBe(project.defaultFlowWorkflowId);
    expect(req.callerContext.source.system).toBe("zigma-core");
    expect(req.callerContext.permissions).toContain("code:write");
    expect(req.callerContext.permissions).toContain("pr:create");
    expect(req.callerContext.permissions).toContain("workflow:execute");

    const view = core.getTaskStatus(task.id);
    expect(view.permissionSnapshots).toHaveLength(1);
    expect(view.permissionSnapshots[0].revision).toBe(1);
  });

  it("maps grants to flow permission strings deterministically", () => {
    const perms = grantsToPermissionStrings({
      canReadCode: true,
      canWriteCode: true,
      canCreateBranch: false,
      canCreatePullRequest: false,
      canApproveHumanGate: true,
      canMergePullRequest: false,
      allowedWorkflows: ["code-change"],
      allowedTools: ["git", "gh"],
    });
    expect(perms).toContain("code:read");
    expect(perms).toContain("code:write");
    expect(perms).toContain("gate:approve");
    expect(perms).toContain("tool:git");
    expect(perms).toContain("workflow:code-change");
    expect(perms).not.toContain("pr:create");
  });

  it("refuses to start a task without a resolvable workflow", async () => {
    const { core } = makeCore();
    const p = core.createProject({ name: "NoWorkflow", projectRoot: "/repo/x" });
    const t = core.createTask({
      projectId: p.id,
      title: "t",
      description: "",
      source: { channel: "api" },
      createdBy: { type: "user", id: "alice" },
    });
    await expect(core.startTask(t.id, { actor: { type: "user", id: "alice" } })).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });
});

describe("status sync (FR-007)", () => {
  it("mirrors awaiting_human flow state into gates and task status", async () => {
    const { core, invoker } = makeCore();
    const { task } = seedProjectAndTask(core);
    const ref = await core.startTask(task.id, { actor: { type: "user", id: "alice" } });

    invoker.setMirror(ref.zigmaFlowRunId, {
      status: "blocked",
      pendingHumanGates: [
        { jobId: "review", stepId: "human-approval", prompt: "Approve the plan?" },
      ],
    });
    await core.syncTask(task.id);

    expect(core.getTask(task.id).status).toBe("awaiting_human");
    const gates = core.listGates({ status: "awaiting", taskId: task.id });
    expect(gates).toHaveLength(1);
    expect(gates[0].prompt).toBe("Approve the plan?");

    // Sync is idempotent — no duplicate gate rows.
    await core.syncTask(task.id);
    expect(core.listGates({ status: "awaiting", taskId: task.id })).toHaveLength(1);
  });

  it("maps completed flow runs to completed tasks and expires stale gates", async () => {
    const { core, invoker } = makeCore();
    const { task } = seedProjectAndTask(core);
    const ref = await core.startTask(task.id, { actor: { type: "user", id: "alice" } });

    invoker.setMirror(ref.zigmaFlowRunId, {
      status: "blocked",
      pendingHumanGates: [{ jobId: "j", stepId: "s", prompt: "?" }],
    });
    await core.syncTask(task.id);
    invoker.setMirror(ref.zigmaFlowRunId, { status: "completed", pendingHumanGates: [] });
    await core.syncTask(task.id);

    expect(core.getTask(task.id).status).toBe("completed");
    expect(core.listGates({ status: "awaiting", taskId: task.id })).toHaveLength(0);
    expect(core.listGates({ status: "expired", taskId: task.id })).toHaveLength(1);
  });
});

describe("human gates (FR-008)", () => {
  async function gateSetup() {
    const ctx = makeCore();
    const { task } = seedProjectAndTask(ctx.core);
    const ref = await ctx.core.startTask(task.id, {
      actor: { type: "user", id: "alice" },
      grants: { canApproveHumanGate: true },
    });
    ctx.invoker.setMirror(ref.zigmaFlowRunId, {
      status: "blocked",
      pendingHumanGates: [{ jobId: "review", stepId: "gate", prompt: "Ship it?" }],
    });
    await ctx.core.syncTask(task.id);
    const [gate] = ctx.core.listGates({ status: "awaiting", taskId: task.id });
    return { ...ctx, task, ref, gate };
  }

  it("relays approval to flow, records decision, auto-resumes", async () => {
    const { core, invoker, gate, ref } = await gateSetup();
    const resolved = await core.approveGate({
      gateRequestId: gate.id,
      actor: { type: "user", id: "alice" },
      comment: "LGTM",
    });
    expect(resolved.status).toBe("approved");
    expect(invoker.decisions[0]).toMatchObject({
      decision: "approve",
      zigmaFlowRunId: ref.zigmaFlowRunId,
      jobId: "review",
      stepId: "gate",
    });
    expect(invoker.resumes).toContain(ref.zigmaFlowRunId);
  });

  it("rejects approval from actors without gate permission", async () => {
    const { core, gate } = await gateSetup();
    await expect(
      core.approveGate({ gateRequestId: gate.id, actor: { type: "user", id: "mallory" } })
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("rejecting a gate does not resume the run", async () => {
    const { core, invoker, gate } = await gateSetup();
    const resolved = await core.rejectGate({
      gateRequestId: gate.id,
      actor: { type: "user", id: "alice" },
      comment: "needs rework",
    });
    expect(resolved.status).toBe("rejected");
    expect(invoker.resumes).toHaveLength(0);
  });

  it("refuses double decisions on the same gate", async () => {
    const { core, gate } = await gateSetup();
    await core.approveGate({ gateRequestId: gate.id, actor: { type: "user", id: "alice" } });
    await expect(
      core.approveGate({ gateRequestId: gate.id, actor: { type: "user", id: "alice" } })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("evidence (FR-009)", () => {
  it("collects a bundle with flow mirror, workspace diff, decisions and links", async () => {
    const { core, invoker } = makeCore();
    const { task } = seedProjectAndTask(core);
    const ref = await core.startTask(task.id, {
      actor: { type: "user", id: "alice" },
      grants: { canApproveHumanGate: true },
    });

    const ws = await core.createWorkspaceForTask(task.id, {
      repositoryUrl: "https://github.com/acme/datacat",
      baseRef: "main",
      branch: "feat/csv-export",
    });
    expect(ws.zigmaWorkspaceId).toMatch(/^ws_fake_/);

    invoker.setMirror(ref.zigmaFlowRunId, {
      status: "blocked",
      pendingHumanGates: [{ jobId: "review", stepId: "gate", prompt: "?" }],
      artifacts: [{ id: "a1", kind: "summary", path: "artifacts/summary.md" }],
      events: [
        { type: "check.passed", payload: { name: "unit-tests", ok: true } },
        { type: "step.completed", payload: {} },
      ],
    });
    await core.syncTask(task.id);
    const [gate] = core.listGates({ status: "awaiting", taskId: task.id });
    await core.approveGate({ gateRequestId: gate.id, actor: { type: "user", id: "alice" } });

    core.addExternalLink({
      taskId: task.id,
      kind: "pull_request",
      url: "https://github.com/acme/datacat/pull/42",
      title: "Add CSV export",
    });

    const bundle = await core.collectEvidence(task.id);
    expect(bundle.taskId).toBe(task.id);
    expect(bundle.flowArtifacts).toHaveLength(1);
    expect(bundle.validationEvidence.some((v) => v.name === "unit-tests")).toBe(true);
    expect(bundle.codeChanges[0]?.changedFiles).toContain("src/app.ts");
    expect(bundle.humanDecisions).toHaveLength(1);
    expect(bundle.externalLinks[0]?.url).toContain("/pull/42");
    expect(bundle.permissionSnapshotId).toMatch(/^psnap_/);
  });

  it("degrades gracefully when flow status is unavailable", async () => {
    const { core, invoker } = makeCore();
    const { task } = seedProjectAndTask(core);
    const ref = await core.startTask(task.id, { actor: { type: "user", id: "alice" } });
    invoker.mirrors.delete(ref.zigmaFlowRunId);

    const bundle = await core.collectEvidence(task.id);
    expect(bundle.risks.some((r) => r.includes("flow status mirror unavailable"))).toBe(true);
  });
});
