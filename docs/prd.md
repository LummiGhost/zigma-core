# Zigma Core PRD

文档版本：v0.3

状态：MVP 实现候选

日期：2026-07-20

仓库：`zigma-core`

## 1. 组件定义

Zigma Core 是 Zigma 平台的控制面组件。它负责把外部请求组织为长期存在、权限受控、状态可恢复、过程可审计的任务，并协调 `zigma-flow`、`zigma-workspace`、未来 `zigma-code` 与其他平台服务。

Core 管理平台级事实：项目、任务、权限快照、Flow Run 引用、Workspace 引用、Human Gate、Evidence Bundle 和审计事件。

`zigma-flow` 继续管理 Workflow、Job、Step、Signal、Artifact 和 Engine 状态。`zigma-workspace` 继续管理 Git worktree、缓存、锁、快照与清理。Core 仅保存这些组件产生的稳定引用和状态投影。

## 2. 设计目标

1. 建立稳定的 Zigma 平台领域模型和 API 契约。
2. 让一次 Task 可以关联多个执行尝试、Workspace、Flow Run、Human Gate 与证据项。
3. 在执行开始时生成不可变 Permission Snapshot，防止运行过程中的权限漂移。
4. 将外部组件隔离在 Port 和 Adapter 后方，允许 CLI、Library API、Service API 和远程 Host 并存。
5. 维护严格的平台状态机，避免 Core 与 Flow 同时控制同一层状态。
6. 建立 Evidence Bundle，将执行结果、验证、代码差异、审批和外部链接组织为可审计交付物。
7. 为 WebUI、Mail、Skill Registry、Code 平台与企业权限系统提供统一控制面。

## 3. 设计原则

### 3.1 Contract First

`src/contracts` 是公开契约源。类型、Zod Schema、HTTP DTO 和组件 Port 应保持一致。其他组件可以调整内部实现，只要满足契约。

### 3.2 Aggregate Ownership

每类状态只能有一个所有者。Core 管理 Task 状态，Flow 管理 Job 和 Step 状态，Workspace 管理工作目录状态。

### 3.3 Immutable Authorization

每次执行尝试创建新的 Permission Snapshot。已有快照不会原地修改。

### 3.4 Evidence by Reference

Core 保存 URI、摘要、摘要哈希和元数据。大型 Artifact 内容由产生组件或对象存储保存。

### 3.5 Idempotent Integration

外部事件采用稳定 Event ID。重复事件不会重复推进状态。

### 3.6 Replaceable Adapters

MVP 提供本地 CLI Adapter。后续可加入 Library Adapter、HTTP Adapter 和 Remote Host Adapter，应用层无需改写。

## 4. 范围

### 4.1 MVP 范围

- Execution Profile
- Project 与 Repository Binding
- Task 生命周期
- Permission Snapshot
- Workspace Ref
- Flow Run Ref
- Human Gate 与 Human Decision
- Evidence Bundle 与 Evidence Item
- Audit Event
- SQLite 持久化
- HTTP API
- 管理 CLI
- `zigma-flow` CLI Adapter
- `zigma-workspace` CLI Adapter
- 单元测试和 API 测试

### 4.2 后续范围

- Organization、Team、Membership 与 Service Account
- RBAC、ABAC 和策略语言
- 异步 Outbox 与执行 Host
- PostgreSQL
- WebUI
- Mail 入口
- Skill Registry
- `zigma-code`
- 多租户配额与计费
- 高可用部署

### 4.3 排除范围

- Workflow DAG 解释
- Agent Prompt 生成
- Job 和 Step 状态推进
- Git worktree 细节
- 代码修改、构建和测试动作
- 自有 Git 托管、Issue、PR 与 CI
- 大型 Artifact 二进制存储

## 5. 领域模型

## 5.1 ActorRef

ActorRef 表示触发或批准平台操作的主体。

```ts
interface ActorRef {
  type: "user" | "agent" | "service" | "system";
  id: string;
  displayName?: string;
  provider?: string;
  externalId?: string;
}
```

规则：

- `type + id` 构成 Core 内的主体引用。
- `provider + externalId` 保存外部身份映射。
- ActorRef 是快照，不要求外部身份记录永久存在。

## 5.2 TaskSource

TaskSource 描述任务入口与外部关联。

```ts
interface TaskSource {
  kind: "api" | "web" | "mail" | "code-platform" | "schedule" | "cli" | "system";
  provider?: string;
  externalId?: string;
  url?: string;
  metadata: Record<string, unknown>;
}
```

Task Source 影响审计和回复路由，不直接授予权限。

## 5.3 ExecutionProfile

Execution Profile 描述 Core 如何调用执行组件。

```ts
interface ExecutionProfile {
  id: string;
  name: string;
  mode: "local-cli" | "local-service" | "remote-host";
  flowCommand: string;
  workspaceCommand: string;
  timeoutMs: number;
  environment: Record<string, string>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

MVP 实现 `local-cli`。其余模式保留为契约扩展点。

## 5.4 RepositoryBinding

Repository Binding 描述 Project 可使用的代码仓库。

```ts
interface RepositoryBinding {
  id: string;
  provider: "github" | "gitlab" | "gitea" | "generic-git";
  url: string;
  defaultRef: string;
  writable: boolean;
  metadata: Record<string, unknown>;
}
```

`id` 是 Project 内稳定标识。URL 可以迁移，权限快照引用 `id`。

## 5.5 WorkspacePolicy

```ts
interface WorkspacePolicy {
  provider: "zigma-workspace-cli" | "existing-directory" | "none";
  mode: "writable" | "read-only";
  branchTemplate: string;
  cleanup: "always" | "on-success" | "manual";
  snapshotOnTerminal: boolean;
}
```

Branch Template 支持 `{taskId}` 与 `{projectKey}`。

## 5.6 Project

Project 是长期配置聚合。

```ts
interface Project {
  id: string;
  key: string;
  displayName: string;
  description?: string;
  status: "active" | "archived";
  repositories: RepositoryBinding[];
  defaultRepositoryId: string;
  defaultWorkflowRef: string;
  executionProfileId: string;
  workspacePolicy: WorkspacePolicy;
  skillProfileRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

约束：

- `key` 全局唯一。
- `defaultRepositoryId` 必须指向嵌入的 Repository Binding。
- archived Project 不接受新 Task。
- Project 更新不会改变已有 Permission Snapshot 与 Flow Run。

## 5.7 Task

Task 是平台级工作单元。

```ts
interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  source: TaskSource;
  createdBy: ActorRef;
  status: TaskStatus;
  labels: string[];
  metadata: Record<string, unknown>;
  activeFlowRunId?: string;
  revision: number;
  failure?: TaskFailure;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

Task 与 Issue、PR、Flow Run 彼此独立。一个 Task 可以有多个 Flow Run 尝试。

TaskStatus：

```text
created
queued
provisioning
running
awaiting_human
blocked
completed
failed
cancelled
```

状态迁移：

```text
created -> queued -> provisioning -> running -> completed
   |          |             |          |-> awaiting_human -> running
   |          |             |          |-> blocked -> running
   |          |             |          |-> failed
   |          |             |          |-> cancelled
   |          |             |-> failed
   |          |-> failed
   |-> cancelled

failed -> queued
blocked -> queued | running
```

`revision` 在每次状态更新时递增，SQLite 更新必须匹配旧 revision。

## 5.8 PermissionSnapshot

```ts
interface PermissionSnapshot {
  id: string;
  taskId: string;
  actor: ActorRef;
  capabilities: Capability[];
  constraints: {
    repositoryIds: string[];
    workflowRefs: string[];
    toolNames: string[];
    branchPatterns: string[];
    maxRunDurationMs?: number;
    expiresAt?: string;
  };
  source: TaskSource;
  hash: string;
  createdAt: string;
  expiresAt?: string;
}
```

Capability 命名采用 `resource:action`：

- `task:start`
- `task:cancel`
- `workflow:invoke`
- `workspace:create`
- `workspace:write`
- `gate:approve`
- `gate:reject`
- `evidence:write`
- `code:read`
- `code:write`
- `code:pull-request:create`
- `code:pull-request:merge`

MVP 在 Core 层校验任务、Workflow、Repository、Workspace 与 Gate 能力。工具与分支约束通过契约传递给执行侧。

## 5.9 WorkspaceRef

```ts
interface WorkspaceRef {
  id: string;
  taskId: string;
  flowRunId: string;
  provider: string;
  externalId: string;
  path: string;
  repositoryUrl: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  mode: "writable" | "read-only";
  status: "preparing" | "ready" | "active" | "released" | "failed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
}
```

Core 不扫描工作目录。Diff 与 Snapshot 通过 Workspace Provider 获取并写入 Evidence Bundle。

## 5.10 FlowRun

```ts
interface FlowRun {
  id: string;
  taskId: string;
  workflowRef: string;
  executionProfileId: string;
  permissionSnapshotId: string;
  workspaceId?: string;
  externalRunId?: string;
  status: FlowRunStatus;
  attempt: number;
  inputs: Record<string, string>;
  context: Record<string, unknown>;
  exitCode?: number;
  error?: TaskFailure;
  startedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

FlowRunStatus：

```text
created -> starting -> running -> completed
                    |        |-> awaiting_human -> running
                    |        |-> failed
                    |        |-> cancelled
                    |-> completed
                    |-> failed
                    |-> cancelled
```

`externalRunId` 由 `zigma-flow` 生成。Core 内部先创建 `FlowRun.id`，使 Workspace、权限快照和回调在外部 Run ID 产生前即可建立关联。

## 5.11 HumanGate

```ts
interface HumanGate {
  id: string;
  externalGateId: string;
  taskId: string;
  flowRunId: string;
  jobId: string;
  stepId: string;
  prompt: string;
  inputSchema: Record<string, unknown>;
  allowedApprovers: ActorRef[];
  status: "awaiting" | "approved" | "rejected" | "expired" | "cancelled";
  dueAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

同一 Flow Run 内 `externalGateId` 唯一。Gate 进入终态后不可重新决定。

## 5.12 HumanDecision

```ts
interface HumanDecision {
  id: string;
  gateId: string;
  actor: ActorRef;
  decision: "approve" | "reject";
  comment?: string;
  input: Record<string, unknown>;
  createdAt: string;
}
```

Decision 是不可变审计记录，同时生成 `human-decision` Evidence Item。

## 5.13 EvidenceBundle

```ts
interface EvidenceBundle {
  id: string;
  taskId: string;
  flowRunId: string;
  status: "open" | "finalized";
  summary?: string;
  risks: string[];
  conclusions: string[];
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
}
```

每个 Flow Run 创建一个 Bundle。Finalized Bundle 不接受新增 Item。

## 5.14 EvidenceItem

```ts
interface EvidenceItem {
  id: string;
  bundleId: string;
  kind:
    | "flow-artifact"
    | "flow-event-log"
    | "validation"
    | "workspace-diff"
    | "workspace-snapshot"
    | "code-change"
    | "pull-request"
    | "ci-result"
    | "human-decision"
    | "summary"
    | "external-link"
    | "other";
  name: string;
  uri: string;
  mediaType?: string;
  digest?: string;
  sizeBytes?: number;
  summary?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
```

URI 支持 `file:`、`https:`、未来对象存储 URI 和 Zigma 内部 URI。

## 5.15 AuditEvent

```ts
interface AuditEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  action: string;
  actor: ActorRef;
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  createdAt: string;
}
```

Audit Event 采用追加写入。`correlationId` 通常使用 Task ID，`causationId` 可引用外部 Event ID。

## 6. 应用服务

CoreService 提供以下用例：

```ts
createExecutionProfile(input)
getExecutionProfile(id)
createProject(input)
getProject(id)
createTask(input)
getTask(id)
getTaskView(id)
startTask(taskId, input)
recordFlowEvent(flowRunId, event)
createHumanGate(input)
decideHumanGate(gateId, input)
addEvidenceItem(flowRunId, input)
finalizeEvidence(flowRunId, input)
getEvidence(flowRunId)
cancelTask(taskId, reason)
listTaskAudit(taskId)
```

## 7. 执行流程

### 7.1 Task 启动

1. 读取 Task、Project 与 Execution Profile。
2. 校验 Task 当前状态。
3. 校验 `task:start` 与 `workflow:invoke`。
4. 校验 Workflow 与 Repository Scope。
5. 创建 Permission Snapshot。
6. 创建 Flow Run 与 Evidence Bundle。
7. Task 进入 queued。
8. Task 进入 provisioning。
9. Workspace Provider 创建 Workspace。
10. 保存 Workspace Ref 并绑定 Flow Run。
11. Flow Run 进入 starting，Task 进入 running。
12. Flow Executor 启动 `zigma-flow`。
13. 保存外部 Run ID、状态和退出码。
14. 同步 Task 平台状态。
15. 收集 Workspace Diff 与 Snapshot。
16. 写入 Evidence Item 和 Audit Event。

### 7.2 Human Gate

1. Flow 或执行 Host 上报 Gate。
2. Core 创建 HumanGate。
3. Flow Run 与 Task 进入 awaiting_human。
4. 外部入口提交决定。
5. Core 校验 Capability 与 allowedApprovers。
6. 保存 HumanDecision。
7. 写入 Evidence Item。
8. 调用 Flow Executor 恢复 Run。
9. approve 后 Task 回到 running。
10. reject 后 Task 进入 blocked。

### 7.3 Flow 事件

事件使用稳定 Event ID。Core 先插入事件记录。重复 Event ID 返回当前 Task View，不再次推进状态。

## 8. 持久化模型

MVP 使用 SQLite，表包括：

```text
execution_profiles
projects
tasks
permission_snapshots
flow_runs
workspaces
flow_events
human_gates
human_decisions
evidence_bundles
evidence_items
audit_events
```

关键唯一约束：

- `execution_profiles.name`
- `projects.key`
- `workspaces(provider, external_id)`
- `human_gates(flow_run_id, external_gate_id)`
- `evidence_bundles(task_id, flow_run_id)`
- `flow_events.id`

## 9. API

MVP 提供 `/v1` HTTP API，详细内容见 `docs/api-contracts.md`。

核心端点：

```text
POST /v1/execution-profiles
POST /v1/projects
POST /v1/tasks
GET  /v1/tasks/:id
POST /v1/tasks/:id/start
POST /v1/tasks/:id/cancel
POST /v1/flow-runs/:id/events
POST /v1/human-gates
POST /v1/human-gates/:id/decisions
POST /v1/flow-runs/:id/evidence
GET  /v1/flow-runs/:id/evidence
POST /v1/flow-runs/:id/evidence/finalize
GET  /v1/tasks/:id/audit-events
```

## 10. 组件契约

### 10.1 zigma-flow

MVP 通过 CLI 调用 `invoke`、`resume` 和 `abort`。当前兼容层解析文本输出。目标契约要求 `invoke --json`、稳定 Run Result、结构化 Gate、事件回调和 Context File。

### 10.2 zigma-workspace

MVP 使用现有 `--json` Envelope，并调用 create、bind-run、diff、snapshot 与 cleanup。目标契约增加 contract version、operation ID、稳定错误码和 state directory override。

详细内容见 `docs/integration-contracts.md`。

## 11. 安全要求

1. Caller Context 必须在 Core 中完成 Schema 校验。
2. Permission Snapshot 必须持久化并生成完整性哈希。
3. Source 不得自动映射为权限。
4. Gate 决策必须同时校验 Capability 与 Approver List。
5. Core 不在 Audit Payload 中保存密钥。
6. CLI Environment 仅来自 Execution Profile，生产实现应改用 Secret Reference。
7. Artifact URI 需要在 WebUI 层按权限解析，不能直接暴露宿主文件路径。
8. 外部回调在生产实现中必须使用签名或双向认证。

## 12. 可观测性

MVP 使用 Fastify 日志和 Audit Event。后续应增加：

- OpenTelemetry Trace
- Task 与 Flow Run Correlation ID
- Adapter Duration
- State Transition Counter
- Integration Failure Counter
- Gate Waiting Duration
- Evidence Collection Lag

## 13. MVP 验收标准

1. 可创建 Execution Profile、Project 和 Task。
2. 可在权限约束下启动 Task。
3. 可创建 Workspace 并保存稳定引用。
4. 可启动 Flow，保存外部 Run ID 与平台状态。
5. 可处理 Human Gate 和审批决定。
6. 可接收幂等 Flow Event。
7. 可汇总 Workspace Diff、Snapshot、Flow Summary 和 Human Decision。
8. 可查询 Task View 与审计事件。
9. TypeScript 类型检查、单元测试和构建全部通过。

## 14. 演化计划

### P1 MVP Control Plane

当前实现范围。

### P2 Async Execution

增加 Outbox、Execution Command、Background Reconciler 和进程恢复。HTTP Start API 在此阶段实现真正异步。

### P3 Policy and Identity

增加 Organization、Membership、Role、Policy、Credential Reference 与签名回调。

### P4 Platform Integrations

接入 WebUI、Mail、Skill Registry 和代码平台。

### P5 Distributed Control Plane

迁移 PostgreSQL，引入远程 Execution Host、租约、心跳、调度和高可用部署。
