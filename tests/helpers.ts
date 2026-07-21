import { ZigmaCore } from "../src/api/core.js";
import type {
  FlowGateDecision,
  FlowInvokeHandle,
  FlowInvokeRequest,
  FlowInvoker,
  FlowRunStatusMirror,
} from "../src/adapters/flow/types.js";
import type { WorkspaceClient } from "../src/adapters/workspace/index.js";

/** In-memory fake of zigma-flow used across service tests. */
export class FakeFlowInvoker implements FlowInvoker {
  runCounter = 0;
  invocations: FlowInvokeRequest[] = [];
  decisions: FlowGateDecision[] = [];
  resumes: string[] = [];
  cancels: string[] = [];
  mirrors = new Map<string, FlowRunStatusMirror>();

  setMirror(runId: string, partial: Partial<FlowRunStatusMirror>): void {
    this.mirrors.set(runId, {
      runId,
      status: "running",
      jobs: [],
      pendingHumanGates: [],
      artifacts: [],
      events: [],
      raw: {},
      ...partial,
    });
  }

  async invoke(req: FlowInvokeRequest): Promise<FlowInvokeHandle> {
    this.invocations.push(req);
    const runId = `2026-run-${String(++this.runCounter).padStart(4, "0")}`;
    if (!this.mirrors.has(runId)) this.setMirror(runId, {});
    return { zigmaFlowRunId: runId, pid: 4242 };
  }

  async resume(_cwd: string, zigmaFlowRunId: string): Promise<FlowInvokeHandle> {
    this.resumes.push(zigmaFlowRunId);
    return { zigmaFlowRunId };
  }

  async getStatus(_cwd: string, zigmaFlowRunId: string): Promise<FlowRunStatusMirror> {
    const mirror = this.mirrors.get(zigmaFlowRunId);
    if (!mirror) throw new Error(`no mirror for ${zigmaFlowRunId}`);
    return mirror;
  }

  async decideGate(input: FlowGateDecision): Promise<void> {
    this.decisions.push(input);
  }

  async cancel(_cwd: string, zigmaFlowRunId: string): Promise<void> {
    this.cancels.push(zigmaFlowRunId);
  }

  async listRunIds(): Promise<string[]> {
    return [...this.mirrors.keys()];
  }
}

export class FakeWorkspaceClient implements WorkspaceClient {
  counter = 0;
  async create(req: any) {
    return {
      workspaceId: `ws_fake_${++this.counter}`,
      path: `/tmp/ws/${this.counter}`,
      branch: req.branch,
      baseRef: req.baseRef,
      baseCommit: "abc123",
      mode: req.mode ?? "writable",
      status: "prepared",
    };
  }
  async bindRun(): Promise<void> {}
  async diff(workspaceId: string) {
    return {
      workspaceId,
      baseCommit: "abc123",
      headCommit: "def456",
      changedFiles: ["src/app.ts"],
      untrackedFiles: [],
    };
  }
}

export function makeCore(): { core: ZigmaCore; invoker: FakeFlowInvoker; ws: FakeWorkspaceClient } {
  const invoker = new FakeFlowInvoker();
  const ws = new FakeWorkspaceClient();
  const core = new ZigmaCore({ dbPath: ":memory:", flowInvoker: invoker, workspaceClient: ws });
  return { core, invoker, ws };
}

export function seedProjectAndTask(core: ZigmaCore) {
  const project = core.createProject({
    name: "DataCat",
    projectRoot: "/repo/datacat",
    defaultFlowWorkflowId: "code-change",
  });
  const task = core.createTask({
    projectId: project.id,
    title: "Add CSV export",
    description: "Export query results as CSV",
    source: { channel: "api" },
    priority: "normal",
    createdBy: { type: "user", id: "alice", name: "Alice", email: "alice@example.com" },
  });
  return { project, task };
}
