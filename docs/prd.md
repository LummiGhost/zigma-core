# Zigma Core PRD

文档版本：v0.1

状态：草案

日期：2026-07-13

仓库：`zigma-core`

## 1. 项目定位

Zigma Core 是 Zigma 平台的任务中枢、项目中枢和权限中枢。它负责把用户请求、项目配置、代码仓库、工作区、runner、workflow run、人类审批和交付证据组织成统一的开发任务生命周期。

Zigma Core 对应早期设计中的 `zigma-host`，但命名调整为 `zigma-core`。它是完整 Zigma 平台的主控组件，不直接执行 workflow，不直接操作 Git 工作区，也不直接实现代码托管平台。它通过调用 `zigma-runner`、`zigma-workspace`、`zigma-code` 和 `zigma-flow` 完成复杂项目开发流程。

一句话定义：

Zigma Core 是 Zigma 的平台控制平面，负责把一个外部请求转化为可审计、可审批、可恢复、可交付的 Agent 开发任务。

## 2. 背景

`zigma-flow` 已经演进为本地 Agent Workflow Runtime，负责 Workflow、Job、Step、Artifact、Signal、Gate 和 Engine 状态推进。它适合治理单次 workflow run，但根据其 PRD，代码平台集成、复杂权限、工作区管理、邮件入口、PR 创建、Issue 管理、Web UI、远程 runner、长期项目状态都不属于 `zigma-flow` 的职责。

DataCat 这类复杂项目的开发流程需要跨越多个系统：需求入口、Issue、PR、CI、代码仓库、临时工作区、人工审批、运行证据、开发总结、任务回溯。Zigma Core 需要承担这些系统之间的编排职责。

## 3. 目标

核心目标包括：

1. 建立 Zigma 平台级任务模型，使一次开发请求可以关联 Issue、PR、workspace、flow run、runner、artifact 和 human gate。
2. 管理项目配置，包括默认仓库、默认 workflow、runner pool、工作区策略、代码平台配置和 Skill Pack profile。
3. 管理组织级权限和 run 级权限快照，将用户能力、项目范围和代码操作边界传递给 runner 与 flow。
4. 调度 `zigma-runner` 执行 `zigma-flow` run，并持续跟踪状态。
5. 接收 human gate 决策，将 Web、邮件、CLI、代码平台评论等外部审批动作转化为 runner 或 flow 可处理的 decision。
6. 汇总 flow evidence，将 event、artifact、validation、diff、PR、CI、human decision 组织成平台级 evidence bundle。
7. 为后续 Web Console、邮件网关、代码平台和 Skill Registry 提供统一控制面。

## 4. 非目标范围

Zigma Core 不承担以下职责：

1. 不直接执行 Agent workflow。执行由 `zigma-flow` 和 `zigma-runner` 负责。
2. 不直接管理 Git worktree、依赖缓存、沙箱和文件系统隔离。这些由 `zigma-workspace` 或 `zigma-runner` 的本地 workspace 兼容层负责。
3. 不直接实现代码托管、Issue、PR、CI 和代码 review 平台。这些由 `zigma-code` 在平台化阶段提供。
4. 不直接调用 GitHub API。平台化前可由 `zigma-runner` 的 `gh` 兼容组件完成基础 GitHub 操作。
5. 不直接生成 Agent prompt，不解释 workflow DAG，不修改 `zigma-flow` 内部状态。
6. 不直接存储大型构建产物。大型 artifact 由 workspace、runner 或对象存储保存，Core 只保存索引和摘要。
7. 不在 MVP 中实现完整 Web UI、邮件系统或多租户计费系统。

## 5. 用户与使用者

第一类使用者是项目维护者。他们希望用 Zigma 管理 DataCat 等复杂项目的持续开发，要求任务可审计、可回放、可审批。

第二类使用者是平台管理员。他们配置项目、runner、权限、仓库、workflow、workspace 策略和代码平台集成。

第三类使用者是 Agent workflow 设计者。他们需要为不同项目绑定不同 workflow、Skill Pack、human gate 和验收策略。

第四类使用者是外部请求者。他们可以通过未来的邮件、Web、Issue 评论或 API 提交任务，但不直接接触 `zigma-flow`。

## 6. 核心概念

### 6.1 Project

Project 是 Zigma 内的长期项目单元。DataCat、Zigma Flow、df-lfs 都可以是 Project。

Project 记录：

```ts
interface Project {
  id: string;
  name: string;
  description?: string;
  defaultRepositoryId?: string;
  defaultWorkflowId?: string;
  defaultRunnerPoolId?: string;
  workspacePolicyId?: string;
  skillProfileId?: string;
  codePlatformProfileId?: string;
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
  assignedRunnerId?: string;
  currentFlowRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 6.3 Flow Run Ref

Flow Run Ref 是 Core 对 `zigma-flow` run 的平台级引用。Core 不读取 flow 内部状态机细节，只保存引用、摘要和状态镜像。

```ts
interface FlowRunRef {
  id: string;
  taskId: string;
  projectId: string;
  runnerId: string;
  workspaceId: string;
  workflowId: string;
  zigmaFlowRunId: string;
  status: "queued" | "running" | "awaiting_human" | "completed" | "failed" | "cancelled";
  evidenceBundleId?: string;
  startedAt?: string;
  completedAt?: string;
}
```

### 6.4 Caller Context

Caller Context 是 Core 下发给 runner 和 flow 的权限与来源快照。

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
    allowedRunnerPools: string[];
  };
  expiresAt?: string;
}
```

### 6.5 Human Gate

Human Gate 是 `zigma-flow` human step 在 Core 层的远程审批镜像。Core 负责把审批请求暴露给外部入口，并把审批结果回传给 runner 或 flow。

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

### 6.6 Evidence Bundle

Evidence Bundle 是一次任务的可审计证据包。

```ts
interface EvidenceBundle {
  id: string;
  taskId: string;
  flowRunId: string;
  summary: string;
  eventIndex: ArtifactRef[];
  validationEvidence: ValidationEvidence[];
  codeChanges: CodeChangeSummary[];
  humanDecisions: HumanDecision[];
  risks: string[];
  createdAt: string;
}
```

## 7. 功能需求

### FR-001 项目注册与配置

Core 必须支持创建、读取、更新和归档 Project。Project 应能绑定默认仓库、默认 workflow、runner pool、workspace policy、Skill Profile 和代码平台配置。

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

### FR-004 Runner 调度

Core 必须根据项目、任务类型、workspace 策略和 runner capability 选择 runner。

调度输入包括：

1. Project 配置。
2. Workflow 要求。
3. Repository 访问要求。
4. 是否需要 GUI、Playwright、Docker、GPU 或特殊工具。
5. Runner 当前负载。

### FR-005 Flow Run 创建

Core 必须能向 runner 发送 Flow Run Request。

```ts
interface FlowRunRequest {
  taskId: string;
  projectId: string;
  workflowId: string;
  taskText: string;
  workspaceRequest: WorkspaceRequest;
  callerContext: CallerContext;
  inputs: Record<string, unknown>;
}
```

### FR-006 状态同步

Core 必须接收 runner 上报的 run 状态，并更新 FlowRunRef 与 Task 状态镜像。

### FR-007 Human Gate 处理

Core 必须支持：

1. 接收 runner 上报的 human gate waiting event。
2. 创建 HumanGateRequest。
3. 校验审批者权限。
4. 接收 approve/reject decision。
5. 将 decision 回传给 runner。
6. 将 decision 写入 Evidence Bundle。

### FR-008 Evidence Bundle 汇总

Core 必须从 runner 收集 flow artifacts、event summary、validation evidence、workspace diff、code platform links 和 human decisions，生成 Evidence Bundle。

### FR-009 代码交付协调

Core 不直接创建 PR，但必须能请求 `zigma-code` 或 `zigma-runner` 的兼容 code component 创建 draft PR、更新 PR 描述或读取 CI 状态。

MVP 阶段可以由 runner 内置 `gh` 组件完成 GitHub 操作。平台化阶段切换到 `zigma-code`。

### FR-010 权限快照

Core 必须为每次 Task 和 Flow Run 生成权限快照，并记录到审计日志。权限快照不得在 run 中途隐式改变。需要变更权限时，应创建新的 revision 或新的 run。

### FR-011 审计日志

Core 必须记录项目变更、任务状态变更、runner 分配、human gate 决策、证据包生成、代码平台交付动作。

### FR-012 API

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
runner_pools
runners
tasks
flow_runs
workspace_refs
human_gate_requests
human_decisions
evidence_bundles
evidence_items
audit_events
permission_snapshots
code_delivery_refs
```

## 9. 与其他组件的关系

### 9.1 与 zigma-flow

Core 调用 runner，runner 调用 `zigma-flow`。Core 不直接写 `.zigma-flow/runs/*/state.json`。Core 只接收 flow run 状态、artifact index 和 evidence summary。

### 9.2 与 zigma-runner

Runner 是 Core 的执行代理。Core 下发 FlowRunRequest，Runner 返回状态、日志、artifact 和结果。

### 9.3 与 zigma-workspace

平台化阶段，Core 请求 Workspace 创建、锁定、快照和清理工作区。MVP 阶段，这些能力可由 Runner 内置 workspace 兼容层提供。

### 9.4 与 zigma-code

平台化阶段，Core 请求 Code 创建仓库、Issue、PR、review、CI 和代码托管对象。MVP 阶段，GitHub 操作可由 Runner 内置 `gh` 组件提供。

## 10. MVP 范围

MVP 应聚焦最小任务中枢：

1. Project 注册。
2. Task 创建。
3. Runner 注册。
4. FlowRunRequest 下发。
5. Runner 状态回报。
6. Human gate approve/reject API。
7. Evidence bundle 基础汇总。
8. SQLite 本地持久化。

MVP 可暂不实现：

1. Web UI。
2. 邮件入口。
3. 多租户组织管理。
4. 完整 zigma-code 平台集成。
5. 完整 zigma-workspace 服务化集成。
6. 复杂权限策略语言。

## 11. DataCat 开发流程示例

1. 用户创建任务：修改 DataCat 获取数据向导。
2. Core 根据 Project 配置选择 `code-change` workflow。
3. Core 生成 Caller Context，确认用户拥有 DataCat 写权限。
4. Core 选择 Runner。
5. Runner 使用内置 worktree 能力准备 workspace。
6. Runner 调用 `zigma-flow run-all`。
7. Flow 产出 plan、implementation、validation、review、summary。
8. Runner 收集 diff 和 artifacts。
9. Runner 通过内置 `gh` 组件创建 draft PR。
10. Core 记录 PR link 和 Evidence Bundle。
11. CI 完成后 Runner 或未来 Code 组件回传状态。
12. Core 根据 human gate 决策完成任务。

## 12. 成功标准

1. Core 可以管理至少一个 DataCat 项目。
2. Core 可以创建任务并调度 Runner 执行。
3. Core 可以记录 flow run、workspace、PR 和 evidence 的关联。
4. Core 可以处理 human gate 审批。
5. Core 可以在不读取 flow 内部状态文件的情况下展示任务状态。
6. Core 可以为一次任务生成可审计 Evidence Bundle。

## 13. 风险与应对

### 风险一：Core 职责膨胀

应对：Core 只保留控制面职责。代码平台、工作区、执行、prompt、workflow 状态推进均交给对应组件。

### 风险二：MVP 过早依赖完整组件

应对：允许 Runner 内置基础 workspace 和 `gh` 能力，Core 先面向 Runner API 开发。

### 风险三：权限边界模糊

应对：Core 生成权限快照，Runner 和 Flow 消费快照。所有跨系统动作写入审计日志。

### 风险四：证据链分散

应对：Core 建立 Evidence Bundle，统一索引 flow artifacts、workspace diff、code delivery、human decisions 和 validation results。

## 14. 开发阶段建议

### P1 Core Skeleton

建立项目结构、配置、数据库、基础 API 和测试框架。

### P2 Project and Task Model

实现 Project、Task、状态机、审计日志。

### P3 Runner Coordination

实现 Runner 注册、FlowRunRequest、状态回报、取消。

### P4 Human Gate Bridge

实现远程 approve/reject API 和 decision audit。

### P5 Evidence Bundle

实现证据包汇总和查询。

### P6 DataCat Dogfood

以 DataCat 真实任务验证 Core、Runner、Flow 的最小闭环。
