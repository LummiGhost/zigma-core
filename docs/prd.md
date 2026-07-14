# Zigma Core PRD

文档版本：v0.2

状态：草案

日期：2026-07-14

仓库：`zigma-core`

## 1. 项目定位

Zigma Core 是 Zigma 平台的控制面组件，负责项目、任务、权限、审批、证据汇总和平台级状态管理。它将用户请求转化为可执行的 `zigma-flow` run，并把 `zigma-flow`、`zigma-workspace`、外部 Git/GitHub CLI、未来的 `zigma-code` 组织为一个可审计的开发任务生命周期。

Zigma Core 对应早期设计中的 `zigma-host`。当前版本明确移除 `zigma-runner` 作为独立组件：Core 不再通过 Runner 间接执行任务，而是通过本地进程、服务进程或未来 execution host 直接启动 `zigma-flow`。`git`、`gh`、`pnpm`、`zigma-workspace`、未来 `zigma-code` 等命令由 `zigma-flow` 的 `script` / `check` step 调用并纳入 artifact/evidence 体系。

一句话定义：

Zigma Core 是 Zigma 的平台控制面，负责把外部请求转化为有权限快照、有工作区、有 flow run、有审批记录、有交付证据的 Agent 开发任务。

## 2. 背景

`zigma-flow` 已经演进为本地 Agent Workflow Runtime，负责 Workflow、Job、Step、Artifact、Signal、Gate 和 Engine 状态推进。它适合治理单次 Agent workflow run，但不应承担长期项目状态、组织权限、任务入口、项目配置和平台级 evidence 管理。

此前设计中曾规划 `zigma-runner` 作为执行节点，但其职责与 `zigma-flow` 的 workflow 编排能力、`zigma-workspace` 的工作区能力、以及 Git/GitHub CLI 步骤存在重叠。类比 GitHub Actions，Runner 应只是通用 job 执行器，而当前 Zigma 尚未形成独立的通用 job package 协议，因此暂时剔除 `zigma-runner` 可以降低系统复杂度。

新的 MVP 思路是：

1. Core 管理 Task、Project、Permission Snapshot、Human Gate 和 Evidence Bundle。
2. Core 选择并启动 `zigma-flow` workflow。
3. Workspace 准备可以由 Core 调用 `zigma-workspace` CLI/API，也可以由 `zigma-flow` script step 显式调用。
4. Git、GitHub、CI、PR 等短期能力由 `zigma-flow` script/check step 直接调用 `git`、`gh` 等 CLI。
5. 平台化阶段再由 `zigma-code` 提供自有代码协作平台能力。

## 3. 目标

核心目标包括：

1. 建立 Zigma 平台级任务模型，使一次开发请求可以关联 Project、Workspace、Flow Run、Human Gate、Evidence Bundle、Issue/PR 链接和审计记录。
2. 管理项目配置，包括默认仓库、默认 workflow、workspace policy、Skill Pack profile、execution profile、代码平台策略。
3. 管理组织级权限和 run 级权限快照，将用户能力、项目范围和代码操作边界传递给 `zigma-flow`。
4. 直接启动或恢复 `zigma-flow` run，而不是通过独立 Runner 组件。
5. 支持通过 `zigma-flow` script/check step 调用 `git`、`gh`、`zigma-workspace` CLI、未来 `zigma-code` CLI/API。
6. 接收 human gate 决策，将 Web、邮件、CLI、Issue 评论等外部审批动作转化为 `zigma-flow` 可处理的 decision。
7. 汇总 flow evidence，将 event、artifact、validation、diff、PR、CI、human decision 组织成平台级 Evidence Bundle。
8. 为后续 Web Console、邮件网关、Skill Registry、Zigma Code 和企业部署提供控制面。

## 4. 非目标范围

Zigma Core 不承担以下职责：

1. 不实现 `zigma-flow` 内部 workflow engine，不解释 flow job/step DAG，不修改 flow state。
2. 不直接生成 Agent prompt；prompt 生成属于 `zigma-flow`。
3. 不直接实现代码修改、测试、构建、PR 创建等开发动作；这些应由 `zigma-flow` workflow 的 script/check/agent step 显式执行。
4. 不直接管理底层 Git worktree、依赖缓存、snapshot 和清理细节；这些属于 `zigma-workspace`，MVP 中也可由 flow script 调用 `git` / `zigma-workspace` CLI 完成。
5. 不实现代码托管、Issue、PR、Review 平台；这些属于未来 `zigma-code`。
6. 不在 MVP 中实现独立 Runner、分布式 worker pool 或通用 job package 协议。
7. 不在 MVP 中实现完整 Web UI、邮件系统或多租户计费系统。

## 5. 用户与使用者

第一类使用者是项目维护者。他们希望用 Zigma 管理 DataCat 等复杂项目的持续开发，要求任务可审计、可回放、可审批。

第二类使用者是平台管理员。他们配置项目、权限、仓库、workflow、workspace 策略、execution profile 和代码平台策略。

第三类使用者是 Agent workflow 设计者。他们为不同项目绑定不同 `zigma-flow` workflow、Skill Pack、human gate 和验收策略。

第四类使用者是外部请求者。他们可以通过未来 Web、邮件、Issue 评论或 API 提交任务，但不直接接触底层 flow run。

## 6. 核心概念

### 6.1 Project

Project 是 Zigma 内的长期项目单元。DataCat、Zigma Flow、df-lfs 都可以是 Project。

```ts
interface Project {
  id: string;
  name: string;
  description?: string;
  defaultRepositoryId?: string;
  defaultFlowWorkflowId?: string;
  workspacePolicyId?: string;
  skillProfileId?: string;
  codePlatformProfileId?: string;
  executionProfileId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 6.2 Task

Task 是 Zigma 平台级任务。它可以来自 Web、邮件、Issue、PR 评论、定时任务或人工创建。

Task 不等同于 GitHub Issue，也不等同于 `zigma-flow` run。一个 Task 可以关联多个 flow run、多个 workspace、一个或多个 PR、多个 human decisions。

```ts
interface ZigmaTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  source: TaskSource;
  status: TaskStatus;
  priority?: "low" | "normal" | "high" | "urgent";
  createdBy: ActorRef;
  currentFlowRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 6.3 Flow Execution Profile

Execution Profile 描述 Core 如何启动 `zigma-flow`。MVP 可使用本地 CLI，平台化后可切换为服务 API 或远程执行主机，但不引入独立 `zigma-runner` 组件。

```ts
interface FlowExecutionProfile {
  id: string;
  mode: "local-cli" | "local-service" | "remote-host";
  zigmaFlowCommand?: string;
  workingDirectoryPolicy: "project-root" | "workspace-root" | "control-directory";
  envPolicyId?: string;
  allowedTools: string[];
  timeoutSeconds?: number;
}
```

### 6.4 Flow Run Ref

Flow Run Ref 是 Core 对 `zigma-flow` run 的平台级引用。Core 不读取或修改 flow 内部状态机字段，只保存引用、摘要和状态镜像。

```ts
interface FlowRunRef {
  id: string;
  taskId: string;
  projectId: string;
  workspaceId?: string;
  workflowId: string;
  zigmaFlowRunId: string;
  executionProfileId: string;
  status: "queued" | "running" | "awaiting_human" | "completed" | "failed" | "cancelled";
  evidenceBundleId?: string;
  startedAt?: string;
  completedAt?: string;
}
```

### 6.5 Caller Context

Caller Context 是 Core 下发给 `zigma-flow` 的权限与来源快照。

```ts
interface CallerContext {
  actor: ActorRef;
  source: TaskSource;
  projectScope: {
    projectId: string;
    repositoryIds: string[];
  };
  permissions: {
    canReadCode: boolean;
    canWriteCode: boolean;
    canCreateBranch: boolean;
    canCreatePullRequest: boolean;
    canApproveHumanGate: boolean;
    canMergePullRequest: boolean;
    allowedWorkflows: string[];
    allowedTools: string[];
  };
  expiresAt?: string;
}
```

### 6.6 Human Gate

Human Gate 是 `zigma-flow` human step 在 Core 层的远程审批镜像。Core 负责把审批请求暴露给外部入口，并把审批结果回传给 `zigma-flow`。

```ts
interface HumanGateRequest {
  id: string;
  taskId: string;
  flowRunId: string;
  jobId: string;
  stepId: string;
  prompt: string;
  allowedApprovers: ActorRef[];
  status: "awaiting" | "approved" | "rejected" | "expired";
}
```

### 6.7 Evidence Bundle

Evidence Bundle 是一次任务的可审计证据包。

```ts
interface EvidenceBundle {
  id: string;
  taskId: string;
  flowRunId: string;
  summary: string;
  flowArtifacts: ArtifactRef[];
  validationEvidence: ValidationEvidence[];
  codeChanges: CodeChangeSummary[];
  externalLinks: ExternalLink[];
  humanDecisions: HumanDecision[];
  risks: string[];
  createdAt: string;
}
```

## 7. 功能需求

### FR-001 项目注册与配置

Core 必须支持创建、读取、更新和归档 Project。Project 应能绑定默认仓库、默认 `zigma-flow` workflow、workspace policy、Skill Profile、Execution Profile 和代码平台配置。

### FR-002 任务创建

Core 必须支持创建 Task。Task 来源包括手动 API、未来 Web Console、邮件、代码平台事件和定时任务。

### FR-003 任务状态机

Task 状态至少包括：

```text
created -> queued -> running -> awaiting_human -> completed
                              -> failed
                              -> cancelled
                              -> blocked
```

Task 状态由 Core 管理，flow 内部 job/step 状态由 `zigma-flow` 管理。

### FR-004 Flow Run 启动

Core 必须能根据 Project、Task、Caller Context、Execution Profile 和 Workspace Policy 启动 `zigma-flow` run。

```ts
interface StartFlowRunRequest {
  taskId: string;
  projectId: string;
  workflowId: string;
  taskText: string;
  workspaceId?: string;
  callerContext: CallerContext;
  inputs: Record<string, unknown>;
}
```

MVP 可通过 CLI 启动：

```bash
zigma-flow run-all <workflow> --task-file <task.md>
```

后续可切换为 library API、service API 或远程 execution host，但不恢复 `zigma-runner` 作为默认独立组件。

### FR-005 Workspace 协调

Core 应支持两种 workspace 协调方式：

1. Core 先调用 `zigma-workspace` CLI/API 创建 workspace，再在该 workspace 中启动 `zigma-flow`。
2. Core 启动一个 control workflow，由 `zigma-flow` script step 显式调用 `zigma-workspace create`、`git worktree`、`git diff` 等命令。

两种方式都必须把 workspace id/path/base commit/branch 写入 flow inputs 或 context block，供后续 step 使用。

### FR-006 CLI Tool 权限策略

Core 必须能为一次 flow run 生成 allowed tools 策略，例如允许或禁止：

```text
git
gh
pnpm
npm
docker
zigma-workspace
zigma-code
```

实际命令执行仍由 `zigma-flow` script/check step 完成，但 Core 负责生成权限快照和审计记录。

### FR-007 状态同步

Core 必须接收 flow run 状态、human gate waiting event、completion summary、artifact index 和 validation evidence，并更新 FlowRunRef 与 Task 状态镜像。

### FR-008 Human Gate 处理

Core 必须支持：

1. 接收 `zigma-flow` human gate waiting event。
2. 创建 HumanGateRequest。
3. 校验审批者权限。
4. 接收 approve/reject decision。
5. 将 decision 回传给 `zigma-flow`。
6. 将 decision 写入 Evidence Bundle。

### FR-009 Evidence Bundle 汇总

Core 必须从 `zigma-flow` run 中收集 flow artifacts、event summary、validation evidence、workspace diff、external links 和 human decisions，生成 Evidence Bundle。

### FR-010 代码交付协调

Core 不直接创建 PR。短期由 `zigma-flow` script step 调用 `gh pr create`、`gh pr comment`、`gh run view` 等命令完成 GitHub 交付。平台化阶段可改为调用 `zigma-code` CLI/API。

Core 负责记录交付意图、权限快照、交付结果链接和审计日志。

### FR-011 权限快照

Core 必须为每次 Task 和 Flow Run 生成权限快照，并记录到审计日志。权限快照不得在 run 中途隐式改变。需要变更权限时，应创建新的 revision 或新的 run。

### FR-012 审计日志

Core 必须记录项目变更、任务状态变更、flow 启动、workspace 关联、human gate 决策、证据包生成、代码平台交付动作。

### FR-013 API

Core 应提供最小 API：

```ts
interface ZigmaCoreApi {
  createProject(input: CreateProjectInput): Promise<Project>;
  createTask(input: CreateTaskInput): Promise<ZigmaTask>;
  startTask(taskId: string, options?: StartTaskOptions): Promise<FlowRunRef>;
  getTask(taskId: string): Promise<ZigmaTask>;
  getTaskStatus(taskId: string): Promise<TaskStatusView>;
  approveGate(input: HumanGateDecisionInput): Promise<HumanGateRequest>;
  rejectGate(input: HumanGateDecisionInput): Promise<HumanGateRequest>;
  cancelTask(taskId: string, reason: string): Promise<void>;
  collectEvidence(taskId: string): Promise<EvidenceBundle>;
}
```

## 8. 数据模型

MVP 可以使用 SQLite 或 PostgreSQL。推荐表：

```text
projects
repositories
tasks
flow_run_refs
workspace_refs
human_gate_requests
human_decisions
evidence_bundles
external_links
audit_events
execution_profiles
permission_snapshots
```

## 9. 与其他组件关系

### 9.1 与 zigma-flow

Core 选择并启动 `zigma-flow` workflow，传入 task、inputs、caller context、workspace context 和 allowed tools。Core 不解释 flow DAG，不修改 flow state。

### 9.2 与 zigma-workspace

Core 可直接调用 `zigma-workspace` CLI/API 创建或查询 workspace，也可让 `zigma-flow` script step 调用 workspace CLI。长期 workspace 生命周期仍由 `zigma-workspace` 负责。

### 9.3 与 zigma-code

MVP 阶段不依赖 `zigma-code`。GitHub 操作可由 `zigma-flow` script step 直接调用 `gh`。平台化阶段，`gh` 命令可替换为 `zigma-code` CLI/API。

### 9.4 与 zigma-runner

`zigma-runner` 已从当前架构中移除。未来只有在 Zigma 形成独立通用 job package 协议、需要分布式执行节点或强隔离 worker pool 时，才重新评估是否设计新的 runner。

## 10. MVP 范围

MVP 必须做到：

1. Project CRUD。
2. Task CRUD 与基础状态机。
3. Execution Profile 配置。
4. 通过 CLI 启动 `zigma-flow`。
5. 传递 Caller Context 和 flow inputs。
6. 记录 FlowRunRef。
7. 处理 Human Gate 镜像。
8. 汇总 Evidence Bundle。
9. 支持 workspace ref 和 external link 关联。
10. 记录审计日志。

MVP 可暂不实现：

1. Web Console。
2. 邮件网关。
3. `zigma-code` 集成。
4. 远程 execution host。
5. 分布式 runner pool。
6. 多租户计费。

## 11. DataCat 使用场景

### 11.1 MVP：直接 flow 驱动

1. 用户创建 DataCat Task。
2. Core 校验用户权限，生成 Caller Context。
3. Core 根据 Project 配置选择 `code-change` workflow。
4. Core 启动 `zigma-flow`。
5. `zigma-flow` script step 调用 `git` / `gh` / `pnpm` / `zigma-workspace` 等 CLI。
6. `zigma-flow` agent step 完成计划、实现、测试、审阅、总结。
7. `zigma-flow` script step 可创建 draft PR 或写入 PR comment。
8. Core 收集 flow artifacts、diff、PR link、validation evidence 和 human decisions。
9. Core 生成 Evidence Bundle 并更新 Task 状态。

### 11.2 平台化：workspace/code 服务化

1. Core 调用 `zigma-workspace` 创建 workspace。
2. Core 启动 `zigma-flow` 并传入 workspace context。
3. Flow script/check step 调用 `zigma-workspace` CLI/API 收集 diff、snapshot、cleanup。
4. Flow script/check step 调用 `zigma-code` CLI/API 创建 PR、读取 check status 或写 review comment。
5. Core 继续只负责权限、状态、审批和 evidence。

## 12. 成功标准

1. Core 可以创建 DataCat Task 并启动一次 `zigma-flow` run。
2. Core 不依赖 `zigma-runner`。
3. Flow run 可以通过 script/check step 调用 `git`、`gh` 或 `zigma-workspace`。
4. Core 能记录 FlowRunRef、workspace ref、external PR link 和 Evidence Bundle。
5. Human Gate 可以在 Core 层被审批并回传给 flow。
6. 架构边界清晰：Core 控制面，Flow 流程面，Workspace 工作区面，Code 平台化代码协作面。

## 13. 风险与应对

### 风险一：Core 直接调用 flow 导致执行环境复杂

应对：用 Execution Profile 隔离不同启动方式。MVP 只支持 local-cli，未来再扩展 local-service 或 remote-host。

### 风险二：script step 调用 `gh` 造成平台耦合

应对：短期接受 CLI 依赖，所有输出必须作为 artifact/evidence 记录。平台化阶段替换为 `zigma-code`。

### 风险三：workspace 创建位置不统一

应对：允许 Core-first 和 flow-script 两种模式，但必须统一写入 WorkspaceRef 和 workspace context。

### 风险四：未来仍需要 Runner

应对：只有当出现通用 job package、分布式 worker pool、强隔离沙箱等明确需求时再重新设计，避免过早引入职责模糊组件。

## 14. 开发阶段建议

### P1 Core Skeleton

建立项目、任务、配置、审计日志和本地数据库。

### P2 Flow Invocation

实现通过 CLI 启动 `zigma-flow`，记录 FlowRunRef，收集 summary 和 artifacts。

### P3 Caller Context and Permission Snapshot

定义权限快照 schema，并注入到 flow inputs/context。

### P4 Human Gate Bridge

实现 human gate request、approve/reject 和 evidence 记录。

### P5 Evidence Bundle

汇总 flow artifacts、diff、validation、external links 和 human decisions。

### P6 DataCat Dogfood

使用 DataCat 的真实任务验证无 Runner 架构闭环。