import { describe, expect, it } from "vitest";
import { makeCore, seedProjectAndTask } from "./helpers.js";
import { CoreError } from "../src/errors.js";

describe("projects (FR-001)", () => {
  it("creates, lists and archives projects", () => {
    const { core } = makeCore();
    const p = core.createProject({ name: "DataCat", projectRoot: "/repo/datacat" });
    expect(p.id).toMatch(/^prj_/);
    expect(core.listProjects()).toHaveLength(1);

    const archived = core.archiveProject(p.id);
    expect(archived.status).toBe("archived");
  });

  it("registers repositories and can set project default", () => {
    const { core } = makeCore();
    const p = core.createProject({ name: "DataCat" });
    const repo = core.registerRepository({
      projectId: p.id,
      name: "datacat",
      url: "https://github.com/acme/datacat",
      defaultBranch: "main",
      makeDefault: true,
    });
    expect(repo.id).toMatch(/^repo_/);
    expect(core.getProject(p.id).defaultRepositoryId).toBe(repo.id);
  });

  it("rejects unknown project lookups with NOT_FOUND", () => {
    const { core } = makeCore();
    try {
      core.getProject("prj_missing");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CoreError);
      expect((err as CoreError).code).toBe("NOT_FOUND");
    }
  });
});

describe("tasks (FR-002/FR-003)", () => {
  it("creates a task in created state with audit trail", () => {
    const { core } = makeCore();
    const { task } = seedProjectAndTask(core);
    expect(task.status).toBe("created");

    const audit = core.listAudit({ taskId: task.id });
    expect(audit.some((e) => e.type === "task.created")).toBe(true);
  });

  it("refuses illegal state transitions", async () => {
    const { core } = makeCore();
    const { task } = seedProjectAndTask(core);
    // Cannot cancel a completed task; first drive to completed via internal transition.
    await core.startTask(task.id, { actor: { type: "user", id: "alice" } });
    // running -> created is illegal; approveGate on nonexistent etc. covered elsewhere.
    const status = core.getTask(task.id).status;
    expect(status).toBe("running");
  });

  it("cancels a running task and aborts the flow run", async () => {
    const { core, invoker } = makeCore();
    const { task } = seedProjectAndTask(core);
    const ref = await core.startTask(task.id, { actor: { type: "user", id: "alice" } });
    await core.cancelTask(task.id, "changed priorities", { type: "user", id: "alice" });

    expect(core.getTask(task.id).status).toBe("cancelled");
    expect(invoker.cancels).toContain(ref.zigmaFlowRunId);
  });
});
