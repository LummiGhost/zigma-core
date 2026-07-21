# Zigma-Core 详细设计文档

版本：v0.1（对应 PRD v0.2 草案）
仓库：`zigma-core`
状态：MVP 实现完成，等待评审

---

## 1. 定位与边界

Zigma-Core 是 Zigma 平台的**控制面（Control Plane）**：

> 把一次外部开发请求，转化为「有权限快照、有工作区、有 flow run、有审批记录、有交付证据」的可审计 Agent 开发任务。

### 1.1 四层边界（与实际仓库对齐）

| 层 | 组件 | 职责 | Core 的关系 |
|---|---|---|---|
| 控制面 | **zigma-core**（本仓库） | Project / Task / 权限快照 / Human Gate 镜像 / Evidence Bundle / 审计 | — |
| 流程面 | zigma-flow v0.7.x | Workflow / Job / Step / Artifact / Signal / Gate 状态机 | Core 通过适配器**启动、观察、审批、取消** flow run，绝不读写 flow 内部状态机字段 |
| 工作区面 | zigma-workspace v0.1.x | Git worktree、快照、锁、生命周期 | Core 可直接调用其 CLI（`--json`），或让 flow script step 调用；两种模式都必须回写 `WorkspaceRef` |
| 代码平台面 | GitHub（短期，经 `gh`）→ zigma-code（未来） | PR / Issue / Review / CI | Core 只记录 `ExternalLink` 与审计，不直接创建 PR |

### 1.2 明确的非目标（对实现的约束）

1. Core 不解释 flow 的 job/step DAG，不 patch `state.json`。状态获取只走 `zigma-flow inspect <runId> --json`。
2. Core 不生成 Agent prompt。
3. Core 不执行 `git`/`gh`/`pnpm`——这些是 flow script/check step 的事；Core 只负责生成 `allowedTools` 权限快照并审计。
4. **不存在 zigma-runner**。执行方式的差异被收敛进 `FlowExecutionProfile.mode`（MVP 只实现 `local-cli`）。

---

## 2. 与 zigma-flow 的契约（调研结论）

以 zigma-flow v0.7.1 的 `docs/host-integration.md` 与 `src/host-api.ts` 为准：

### 2.1 Host API（未来直调目标）

```
createRun / resumeRun / getRunStatus / approveHumanGate / cancelRun / collectRunEvidence
```

RunStatus：`running | blocked | failed | completed | cancelled`。
错误信封：`HostApiError { code, message, details?, suggestion? }`。

### 2.2 CallerContext（**逐字段对齐**，Core 侧类型 `FlowCallerContext`）

```ts
{
  user: { id: string; name?: string; email?: string };
  actor: { type: "user" | "system" | "service"; id: string; name?: string };
  source: { system: string; version: string };   // Core 固定填 "zigma-core" / 包版本
  permissions: string[];                          // 见 §5 权限映射
  project: { id: string; scope: string[] };
}
```

### 2.3 MVP 实际使用的 CLI 表面

| 目的 | 命令 | 说明 |
|---|---|---|
| 启动 | `zigma-flow invoke <workflow> --task <text> --input k=v ...` | **无 `--json`，不回显 runId** → 采用运行目录 diff 发现（§6.2），已提上游 ISSUE |
| 恢复 | `zigma-flow invoke <workflow> --resume <runId>` | Gate approve 后自动续跑 |
| 状态 | `zigma-flow inspect <runId> --jobs --events --artifacts --json` | Core 唯一的状态来源 |
| 审批 | `zigma-flow approve/reject --run <id> --job <j> --step <s> --comment <c>` | 无 `--actor` → 审批人身份仅记录在 Core 侧，已提 ISSUE |
| 取消 | `zigma-flow abort --run <id> --reason <r>` | |
| 证据 | *(无 CLI)* | Host API 有 `collectRunEvidence` 但 CLI 未暴露 → Core 自行从 inspect 镜像与本地记录合成，已提 ISSUE |

运行目录：`.zigma-flow/runs/<runId>/{state.json, events.jsonl, artifacts.jsonl, caller-context.json}`。
Core 唯一允许的目录级操作：**读目录名**（发现 runId）＋ **best-effort 写入 `caller-context.json`**（invoke 缺 `--caller-context` 标志前的过渡方案，同样已提 ISSUE）。

---

## 3. 领域模型

所有模型定义在 `src/types/index.ts`，用 zod schema 承载校验，TypeScript 类型由 schema 推导。

### 3.1 ER 总览

```
Project 1──n Repository
Project 1──n ZigmaTask
ZigmaTask 1──n FlowRunRef ──1 PermissionSnapshot
ZigmaTask 1──n WorkspaceRef
ZigmaTask 1──n HumanGateRequest 1──0..1 HumanDecision
ZigmaTask 1──n ExternalLink
ZigmaTask 1──n EvidenceBundle（通常取 latest）
*          n  AuditEvent（挂 project/task/flowRun 任意组合）
FlowExecutionProfile 1──n FlowRunRef
```

对应 SQLite 12 表：`projects, repositories, execution_profiles, tasks, permission_snapshots, flow_run_refs, workspace_refs, human_gate_requests, human_decisions, evidence_bundles, external_links, audit_events`（WAL 模式）。

### 3.2 Project

```ts
interface Project {
  id: string;                    // prj_*
  name: string;
  description?: string;
  status: "active" | "archived";
  defaultRepositoryId?: string;
  defaultFlowWorkflowId?: string; // 启动 Task 时的默认 workflow
  projectRoot?: string;           // 含 .zigma-flow/ 的目录；local-cli 模式下的默认 cwd
  workspacePolicyId?: string;
  skillProfileId?: string;
  codePlatformProfileId?: string;
  executionProfileId?: string;    // 缺省用内置 default-local-cli
  createdAt: string; updatedAt: string;
}
```

相较 PRD 增补 `status` 与 `projectRoot`：归档是软删除；`projectRoot` 是 local-cli 模式必需的执行锚点（PRD 的 `workingDirectoryPolicy: "project-root"` 需要它才能落地）。

### 3.3 ZigmaTask 与状态机（FR-003）

```
created ─→ queued ─→ running ─→ completed
              │         │ ├────→ failed ─→ queued（允许重试）
              │         │ ├────→ cancelled
              │         │ ├────→ awaiting_human ─→ running/completed/failed/cancelled
              │         │ └────→ blocked ─→ running/failed/cancelled
              └────────→ cancelled（排队中取消）
created ────────────────→ cancelled
```

转移表以 `TASK_TRANSITIONS` 常量固化在代码中，`TaskService.transition()` 是**唯一**修改任务状态的入口，非法转移抛 `INVALID_STATE`，每次转移写审计（`task.status_changed`，detail 含 from/to/reason/actor）。

关键语义区分：

* `awaiting_human`：flow `blocked` 且**存在**待决 human gate → 需要人。
* `blocked`：flow `blocked` 但**没有**镜像出待决 gate（如信号等待、外部依赖）→ 需要运维关注，不产生审批项。

### 3.4 FlowExecutionProfile（FR-004 前置）

```ts
interface FlowExecutionProfile {
  id: string; name: string;
  mode: "local-cli" | "local-service" | "remote-host";  // MVP 仅 local-cli 有实现
  zigmaFlowCommand?: string;        // 默认 "zigma-flow"
  workingDirectoryPolicy: "project-root" | "workspace-root" | "control-directory";
  envPolicyId?: string;
  allowedTools: string[];           // 写入权限快照，flow 侧执行
  timeoutSeconds?: number;
  createdAt: string;
}
```

内置 `default-local-cli`：`allowedTools = [git, gh, pnpm, npm, zigma-workspace]`。`local-service` / `remote-host` 仅保留枚举位，选择即抛 `VALIDATION_FAILED`，防止误配置静默降级。

### 3.5 PermissionSnapshot（FR-011，不可变）

```ts
interface PermissionSnapshot {
  id: string;               // psnap_*
  taskId: string; flowRunId?: string;
  revision: number;         // 同一 task 内单调递增；变更=新 revision，绝不 UPDATE
  actor: ActorRef; source: TaskSource;
  projectScope: { projectId: string; repositoryIds: string[] };
  grants: PermissionGrants; // 8 个布尔/列表能力位，见 §5
  expiresAt?: string; createdAt: string;
}
```

仓储层只有 `insert/get/listByTask/latestRevision`，**没有 update/delete**——不可变性由 API 表面保证。

### 3.6 FlowRunRef / WorkspaceRef / HumanGateRequest / HumanDecision / EvidenceBundle

`FlowRunRef` 是 Core 对一次 flow run 的平台级引用与状态镜像（`queued|running|awaiting_human|completed|failed|cancelled`），存 `zigmaFlowRunId`、`invocationCwd`、`permissionSnapshotId`、`evidenceBundleId`、错误信息与起止时间。

`HumanGateRequest` 上有 `UNIQUE(flow_run_ref_id, job_id, step_id)`：同一 gate 在多次 sync 中**幂等镜像**为一行；状态 `awaiting → approved|rejected|expired`；run 到终态时自动把遗留 awaiting gate 置为 `expired`。

`EvidenceBundle`（FR-009）：

```ts
{
  id, taskId, flowRunId, summary,
  flowArtifacts: ArtifactRef[],          // inspect 镜像
  validationEvidence: ValidationEvidence[], // events 中 check.* 提炼（name/ok 取 payload 优先）
  codeChanges: CodeChangeSummary[],      // zigma-workspace diff --json
  externalLinks: ExternalLink[],         // PR/Issue/CI 链接
  humanDecisions: HumanDecision[],
  risks: string[],                       // 降级/失败自动生成
  permissionSnapshotId: string,          // 证据锚定当次授权
  createdAt
}
```

flow 状态不可达时**优雅降级**：Core 侧记录仍然汇总，`risks` 写入 `"flow status mirror unavailable at collection time"`。

---

## 4. 架构与代码组织

```
src/
├── types/index.ts        # 全部领域模型（zod）+ TASK_TRANSITIONS
├── errors.ts             # CoreError{code,message,details?,suggestion?}（形状对齐 HostApiError）
├── ids.ts                # 前缀 ID：prj_/repo_/task_/frun_/ws_/gate_/hdec_/evb_/psnap_/xprof_/lnk_/aud_
├── db/
│   ├── database.ts       # SQLite schema（12 表，WAL）
│   └── repos.ts          # 仓储层（行↔模型映射，无业务逻辑）
├── adapters/
│   ├── flow/
│   │   ├── types.ts      # FlowInvoker 接口 + FlowRunStatusMirror（Core 内部稳定形状）
│   │   └── localCli.ts   # LocalCliFlowInvoker：execa 调 zigma-flow
│   └── workspace/index.ts# WorkspaceClient 接口 + LocalCliWorkspaceClient
├── services/
│   ├── permissionService.ts  # grants→permissions 映射、CallerContext 构造、canApprove
│   ├── taskService.ts        # 状态机 transition()（唯一状态修改入口）
│   ├── executionService.ts   # startTask / syncRun / cancelTask
│   ├── gateService.ts        # approve / reject / autoResume
│   └── evidenceService.ts    # collect
├── api/core.ts           # ZigmaCore 门面（FR-013 全方法）
├── http/server.ts        # node:http REST（无框架依赖）
└── cli/index.ts          # commander CLI（project/task/gate/evidence/audit/serve）
```

依赖方向严格单向：`cli/http → api → services → (adapters, db) → types`。

**可替换性**：`ZigmaCore` 构造函数接受注入的 `FlowInvoker` / `WorkspaceClient`。测试用 `FakeFlowInvoker`；未来 `local-service` 模式只需新增一个实现 `FlowInvoker` 的 HostApi 客户端，服务层零改动。

---

## 5. 权限映射（Core grants → flow permissions）

`PermissionGrants`（Core 侧能力位）到 flow `CallerContext.permissions[]`（字符串）的**确定性映射**，定义于 `permissionService.ts`：

| Core grant | flow permission |
|---|---|
| *（启动即有）* | `workflow:execute`, `run:resume`, `run:cancel` |
| `canReadCode` | `code:read` |
| `canWriteCode` | `code:write` |
| `canCreateBranch` | `branch:create` |
| `canCreatePullRequest` | `pr:create` |
| `canMergePullRequest` | `pr:merge` |
| `canApproveHumanGate` | `gate:approve`, `run:decide` |
| `allowedTools: [t...]` | `tool:<t>` |
| `allowedWorkflows: [w...]` | `workflow:<w>` |

审批权判定 `canApprove(snapshot, actor, allowedApprovers)`：

1. gate 显式列出 `allowedApprovers` → 只认名单（按 id 或 email 匹配）；
2. 否则回退到快照：**仅快照对应 actor 本人**且快照含 `canApproveHumanGate` 才可决——快照授权不外溢给任意用户。

---

## 6. 关键流程

### 6.1 startTask（FR-004/005/011）

```
校验 task ∈ {created, failed}（failed 走重试语义先回 queued）
→ 解析 Project / ExecutionProfile / cwd（workingDirectoryPolicy）
→ 生成 PermissionSnapshot(revision = latest+1)，写审计
→ task → queued
→ 插入 FlowRunRef(queued)
→ FlowInvoker.invoke（构造 CallerContext；见 §6.2 runId 发现）
→ FlowRunRef ← zigmaFlowRunId, running；task → running；currentFlowRunId 指向本 run
→ 立即 syncRun 一次（拿首个状态镜像）
失败路径：invoke 抛错 → FlowRunRef=failed(errorMessage)，task → failed，审计 flow.invoke_failed
```

Workspace 双模式（FR-005）：`createWorkspaceForTask()` 走 Core-first（调 workspace CLI、写 `WorkspaceRef`、把 workspace id/path/branch/baseCommit 注入 flow inputs）；flow-script 模式则由 workflow 自己调 `zigma-workspace create`，Core 事后经 `bind-run` 对账回写 Ref。两种模式的落库形状一致。

### 6.2 runId 发现（local-cli 过渡方案）

`invoke` 不回显 runId，因此：invoke 前快照 `.zigma-flow/runs/` 目录名集合 → 启动进程 → 轮询（15s 上限）取**新增**目录名即 runId。只读目录名，不读内部文件。单进程串行 invoke 下无歧义；上游补 `--json` 后此逻辑整体删除（ISSUE 已备）。

### 6.3 状态同步 syncRun（FR-007）

```
inspect --json → normalize 为 FlowRunStatusMirror
flow completed/failed/cancelled → run/task 同名终态；expire 遗留 awaiting gates
flow blocked + pendingHumanGates>0 → run/task awaiting_human；幂等镜像 gate 行
flow blocked + 无 gate → run running / task blocked
flow running → running
```

`pendingHumanGates` 由 inspect 的 jobs 里 `awaiting_human` 的 step 派生（防御性解析，字段缺失时不崩溃）。

### 6.4 Human Gate（FR-008）

```
approve/reject(gateId, actor, comment)
→ gate 必须 awaiting（否则 INVALID_STATE，防双决）
→ canApprove 校验（否则 PERMISSION_DENIED）
→ 中继 zigma-flow approve/reject --run --job --step --comment
→ gate → approved/rejected；写 HumanDecision + 审计 gate.decided
→ approve 且 autoResume（默认 true）→ invoke --resume 续跑 → 再 sync
```

审批人身份在 flow CLI 侧暂无处安放（无 `--actor`），因此**权威审批记录在 Core**（HumanDecision + 审计 + EvidenceBundle 三处留痕）。

### 6.5 Evidence（FR-009）

`collectEvidence(taskId, runId?)`：取指定或最新 run → inspect 镜像（可降级）→ artifacts、check 事件提炼 validation、workspace diff 提炼 codeChanges、合并 humanDecisions/externalLinks/risks → 落 `EvidenceBundle` 并回写 `flowRuns.evidenceBundleId`，审计 `evidence.collected`。

---

## 7. API 契约（FR-013）

`ZigmaCore` 门面即库 API；HTTP 与 CLI 是其薄投影。

| PRD 方法 | 实现 | HTTP |
|---|---|---|
| createProject | ✅ | `POST /projects` |
| createTask | ✅ | `POST /tasks` |
| startTask | ✅ | `POST /tasks/:id/start` |
| getTask / getTaskStatus | ✅ | `GET /tasks/:id`, `GET /tasks/:id/status` |
| approveGate / rejectGate | ✅ | `POST /gates/:id/approve|reject` |
| cancelTask | ✅ | `POST /tasks/:id/cancel` |
| collectEvidence | ✅ | `POST /tasks/:id/evidence`，`GET /evidence/:id` |
| *(增补)* syncTask/syncRun、createWorkspaceForTask、addExternalLink、listAudit、registerRepository、createExecutionProfile | ✅ | 对应路由 |

错误信封统一 `CoreError { code, message, details?, suggestion? }`；HTTP 映射：`NOT_FOUND→404, PERMISSION_DENIED→403, INVALID_STATE|CONFLICT→409, VALIDATION_FAILED→400, 其余→500`。

---

## 8. 上游依赖缺口（已备 ISSUE 草稿，见 docs/issues/）

**zigma-flow**（4 项）：
1. `invoke --json` 回显 runId（移除目录 diff 发现）；
2. `invoke --caller-context <file>`（移除 Core 直写 run 目录）;
3. CLI 暴露 `evidence <runId> --json`（对齐 Host API `collectRunEvidence`）；
4. `approve/reject --actor <id>`（flow 侧留审批人痕）。

**zigma-workspace**（1 项）：确认 `diff --json` 的 `changed_files/untracked_files` 与 `--patch-out` 为稳定契约，并在 `create --json` 中固定 `base_commit` 字段（Core 的 `WorkspaceRef.baseCommit` 依赖它）。

---

## 9. 测试与质量

* vitest 17 例全绿：状态机合法/非法转移、startTask 快照与 CallerContext 形状、权限映射确定性、sync 幂等（gate 不重复镜像）、终态 expire、审批权限拒绝、双决拒绝、reject 不 resume、evidence 全量与降级路径。
* `tsc --noEmit` 零错误；`FakeFlowInvoker`/`FakeWorkspaceClient` 使服务层测试不依赖真实二进制。
* 真实 CLI + SQLite 冒烟通过（project/task/audit 链路）。

## 10. 后续路线

P1 落地（本 MVP）→ P2 引入 flow Host API 直调（`local-service`）→ P3 Web Console/邮件网关接 HTTP API → P4 `zigma-code` 替换 `gh`、ExternalLink 升级为强类型交付对象 → P5 多租户与组织级权限（PermissionSnapshot 的 grants 位扩展为策略引擎）。
