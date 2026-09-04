# Zigma 跨仓兼容矩阵与契约测试计划

- 基线名称：`core-durable-v1`
- 状态：M2 接受基线（保留 `m0-sync-v1` 回滚模式）
- 日期：2026-09-03
- 所有者：Zigma Core
- 父里程碑：[zigma-core#9](https://github.com/LummiGhost/zigma-core/issues/9)

## 1. 兼容基线

`m0-sync-v1` 是开始 M1–M4 前唯一受支持的三仓组合。它只承诺当前同步
Core adapter 可使用的能力，不提前声称 durable execution、可靠事件投递或
强制 workspace 沙箱已经完成。

| 组件 | 最低包版本 | 契约版本 | 精确源代码基线 | M0 必需能力 |
| --- | --- | --- | --- | --- |
| `@zigma-ai/zigma-core` | `0.1.0` | Execution Policy `contractVersion: 1` | `48c6290` 及本矩阵 PR | 有限容量配置、同步 Flow/Workspace adapters、版本拒绝 |
| `@zigma-ai/zigma-flow` | `0.8.12` | Invoke/command `contractVersion: 1` | tag `v0.8.12` | `invoke --json --context-file`、`resume --json`、`abort --json` |
| `@zigma-ai/zigma-workspace` | `0.1.5` | CLI `contract_version: 1` | tag `v0.1.5` | `create`、`bind-run`、`status`、`diff`、`snapshot`、基础 `cleanup` JSON |

版本解释：

- `zigma-flow` main 的 platform event envelope 在 `ddeef6a` 增加了
  `producer` 和 `contractVersion`；它不是 `v0.8.12` 的 M0 同步必需能力。M2
  启用可靠事件消费前，必须引用包含该提交的正式发布版本，不能只判断
  `>=0.8.12`。
- `zigma-workspace` 的 M0 合同文档在 `330b34c`，但表中的 CLI 行为已经存在于
  `v0.1.5`。M3 新增 stable reconcile/strict-cleanup CLI 后必须提高 capability
  level，并记录首个包含它的发布版本。
- Core 当前尚无 Git release tag。`0.1.0` 是 source/package baseline；对外发布
  前，release job 必须把最终 M0 merge commit 与包版本绑定。
- 表中的 package version 是已验证的发布基线和诊断信息，不是 Core admission 的
  精确或范围比较。进程响应的 provider identity、契约版本和请求所需 capability
  必须同时匹配，否则在任何外部副作用前失败。

### 1.1 Runtime 下限

| 组件 | Node.js | 包管理器/安装约束 |
| --- | --- | --- |
| Core | `>=22.5.0` | npm lockfile；CI 使用 `npm ci` |
| Flow | `>=20.11.0` | pnpm lockfile |
| Workspace | `>=18` | 原生 `better-sqlite3` install scripts 不得被禁用 |

同一宿主运行三者时，取最高下限，因此 M0 推荐 Node.js 22。

## 2. Capability levels

| Level | 解锁条件 | 所属里程碑 | 当前状态 |
| --- | --- | --- | --- |
| `m0-sync-v1` | 本文的同步命令、版本校验和消费方测试 | M0 | 接受 |
| `flow-reliable-v1` | 取消后子进程/写入器静默、确定性并行、可靠终态 | [Flow M1 #297](https://github.com/LummiGhost/zigma-flow/issues/297) | 已接受（PR #304–#306） |
| `core-durable-v1` | durable command/outbox、容量 lease、at-least-once callback/reconcile | [Core M2 #10](https://github.com/LummiGhost/zigma-core/issues/10) | 已接受（PR #22–本 PR） |
| `workspace-isolated-v1` | 强制路径边界、stable lease/reconcile/strict cleanup CLI | [Workspace M3 #27](https://github.com/LummiGhost/zigma-workspace/issues/27) | 未实现 |
| `parallel-e2e-v1` | 多任务 golden/failure/soak 全部通过 | [Core M4 #11](https://github.com/LummiGhost/zigma-core/issues/11) | 未实现 |

Execution Profile 只能选择已被当前组合证明的 level。未知 level 或缺少任一
必需能力时，Core 拒绝 admission；不得静默降级到不安全行为。

## 3. Flow 跨进程契约

### 3.1 Invoke

```text
zigma-flow --cwd <workspace-path> invoke <workflow-ref> \
  --task <task-text> \
  --context-file <absolute-json-path> \
  --input <key=value> ... \
  [--backend <name>] [--parallelism <n>] [--dry-run] --json
```

Core 接受的结果字段：

```ts
interface FlowInvokeResultV1 {
  contractVersion: 1;
  runId: string;
  status:
    | "created"
    | "starting"
    | "running"
    | "awaiting_human"
    | "completed"
    | "failed"
    | "cancelled";
  exitCode: number;
  pausedGate?: unknown;
  artifacts?: unknown[];
  eventLogUri?: string;
}
```

Core 必须验证 version、runId 和 status。M0 中 process exit code 与 JSON terminal
status 可能不完全一致；adapter 以结构化状态为主，并把非零进程退出且非
`awaiting_human` 映射为失败。stdout 必须只包含 JSON；诊断输出走 stderr。

### 3.2 Resume

```text
zigma-flow --cwd <workspace-path> resume <run-id> \
  --job <job-id> [--step <step-id>] \
  --input decision=<approve|reject> [--input <key=value> ...] --json
```

### 3.3 Abort

```text
zigma-flow --cwd <workspace-path> abort \
  --run <run-id> --reason <text> --json
```

Abort 成功只证明取消状态已记录。它不证明另一个 `invoke` 进程及其子进程已
退出。M1/M2 的 execution host 必须终止、等待并回收自己拥有的进程树，然后
Core 才能释放容量或请求 Workspace cleanup。

### 3.4 Flow event capability

Flow main 已定义：

```ts
interface FlowPlatformEventV1 {
  contractVersion: 1;
  producer: "zigma-flow";
  eventId: string;
  runId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}
```

`--event-file` 当前是 best-effort projection，不属于 `m0-sync-v1` 的可靠终态
通道。M2 只能在 M1 提供 flush/重试证据后把它或新的 delivery adapter 用作
at-least-once 输入。

## 4. Workspace 跨进程契约

### 4.1 Envelope

```ts
type WorkspaceEnvelopeV1<T> =
  | { contract_version: 1; ok: true; data: T }
  | {
      contract_version: 1;
      ok: false;
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
```

Core 必须拒绝缺失或未知 `contract_version`，按 `error.code` 分类，并忽略未知
可选字段。不得解析 message 决定状态。

### 4.2 M0 commands

| 操作 | 命令/必需 flags | Core 使用方式 |
| --- | --- | --- |
| create | `create --repo --base --branch --mode --project --task --flow-run --operation-id --json` | operation id 为 `core:workspace:create:<flowRunId>` |
| bind | `bind-run --workspace --task --flow-run --operation-id --json` | operation id 为 `core:workspace:bind:<flowRunId>` |
| status | `status --workspace --json` | 对账 registry projection |
| diff | `diff --workspace --json` | 读取 changed/untracked files 和 patch artifact |
| snapshot | `snapshot --workspace [--operation-id] --json` | 收集内容寻址证据 |
| cleanup | `cleanup --workspace [--operation-id] --json` | 只有 `removed: true` 才在 Core 视为确认清理 |

当前 adapter 对 create/bind 使用稳定 operation id。snapshot/cleanup 的 durable
重试需要 M2 提供每次逻辑操作的 command id；在此之前不得把超时后的新调用
假定为同一操作。

### 4.3 M3-only APIs

heartbeat、integration lock、reconcile、strict cleanup 和 commit/integrate/publish
现在存在于 Workspace TypeScript API，但还没有 stable CLI 表面，因此不属于
`m0-sync-v1`。Core 不得通过数据库或内部模块路径直接调用它们。

基础 cleanup 返回 `ok: true` 但 `removed: false` 时，Core adapter 必须 fail
closed。重复清理已清理 workspace 也可能得到该结果；M0 宁可要求 reconcile，
也不能错误声称物理目录已移除。M3 用 strict cleanup 的结构化 status/blockers
消除这个歧义。

## 5. Provider/consumer contract-test matrix

| 契约 | Provider owner 与当前测试 | Consumer owner 与当前测试 | 缺口/去向 |
| --- | --- | --- | --- |
| Flow invoke v1 envelope | Flow `tests/commands/invoke-json.test.ts` | Core `tests/adapters/local-cli-flow.test.ts` | process exit/JSON 对齐：M1 `invoke-terminal-contract.test.ts` |
| Flow context file | Flow `tests/commands/context-file.test.ts` | Core `buildContextFilePayload` and `m0-real-cli.contract.test.ts` | real CLI gate proves canonical context is accepted and frozen; secrets/large payload remain M4 coverage |
| Flow resume/abort command | Flow `tests/commands/resume-json.test.ts`, `abort-json.test.ts` | Core `LocalCliFlowExecutor command contracts` | out-of-process termination ack：M1/M2 `abort-process-tree.contract.test.ts` |
| Flow platform events | Flow `tests/events/platformEvent.test.ts` | Core `tests/core-service.test.ts` correlated callback/dedupe cases | M4 增加真实跨进程投递 soak |
| Workspace envelope/create/bind | Workspace types plus `tests/core/workspace-dogfood.test.ts` real Git behavior | Core `tests/adapters/zigma-workspace-cli.test.ts` | CLI black-box provider：M3 `tests/cli/platform-contract.test.ts` |
| Workspace diff/snapshot | Workspace `tests/core/diff.test.ts`, `workspace-dogfood.test.ts` | Core adapter fixtures and `m0-real-cli.contract.test.ts` | dedicated Core gate rebuilds sibling source and verifies emitted artifact digests; M3 adds provider-owned CLI matrix |
| Workspace lock/lease/reconcile | Workspace `tests/core/contracts.test.ts`, `contracts-windows.test.ts` | 无 M0 consumer；M0 不启用 | M3 `workspace-lease-adapter.contract.test.ts` |
| Workspace factual cleanup | Workspace `contracts.test.ts`, `contracts-windows.test.ts` | Core cleanup `removed` fail-closed tests | stable strict CLI：M3 `workspace-cleanup.contract.test.ts` |
| Core profile policy v1 | Core `tests/execution-profile-policy.test.ts`, `tests/api.test.ts` | Core API/CLI clients | Core 20-command admission、fencing、restart/retry tests |

M2 测试入口目前集中在 `tests/core-service.test.ts`，覆盖 durable transaction
rollback、幂等冲突、20-command/capacity-4、stale fencing、异步返回、重启拾取、
排队取消、有限安全重试、callback 冲突/乱序和 Job-attempt workspace evidence
投影。M4 再把同一组断言提升为三仓真实 CLI golden/soak。

“当前测试”必须在 owning repository CI 中运行。计划测试名是验收入口，不得在
实现时改成无法追踪的泛化测试而不更新本矩阵。

## 6. M1–M4 CI gates

### M1 — Flow reliability

- `invoke-terminal-contract.test.ts`: JSON terminal status、process exit 和 state 一致。
- `abort-process-tree.contract.test.ts`: 外部 abort + host signal 后所有 child/writer
  静默，覆盖 Windows。
- `parallel-cancel-soak.test.ts`: 并行 job、timeout、fail-fast、cancel 混合重复运行。
- 现有 `runAll-events` 和 `run-all-parallel` 必须在 full suite 中无共享目录/时序 race。

### M2 — Core durable execution（已通过）

- `capacity-admission.integration.test.ts`: global/project/repository/backend 原子预留。
- `command-idempotency.crashpoints.test.ts`: persistence/invoke/ack 每个 crash point。
- `flow-event-consumer.contract.test.ts`: duplicate event id 只产生一次 projection/audit。
- `tests/adapters/m0-real-cli.contract.test.ts`: 真实 Flow CLI accepts/freezes
  `CallerContextV1`，真实 Workspace CLI diff/snapshot artifacts are digest-verified，
  unknown version and post-emission tamper fail closed. `npm run test:m0-cross-repo`
  rebuilds source checkouts first; CI pins Flow `b46701c` and Workspace `a5e2d8c`.

### M3 — Workspace isolation

- `tests/cli/platform-contract.test.ts`: 每个 stable CLI command 的 v1 envelope/error。
- `workspace-lease-adapter.contract.test.ts`: duplicate、concurrent、expired lease、owner
  mismatch、takeover。
- `workspace-cleanup.contract.test.ts`: partial removal、open handle、retry、reconcile。
- `workspace-path-boundary.contract.test.ts`: Windows/POSIX root、symlink/junction、大小写。
- `operation-pending.contract.test.ts`: 并发相同 operation id 不泄漏内部 sentinel。

### M4 — End-to-end proof

- `parallel-development.golden.test.ts`: 至少两个独立 writable tasks 并行完成并集成。
- `parallel-development.conflict.test.ts`: 同线冲突保留双方 evidence，可恢复重试。
- `parallel-development.cancel-restart.test.ts`: Core/host restart + cancel 无重复执行。
- `parallel-development.windows-soak.test.ts`: 8 小时混合负载后无 orphan child、worktree
  或未解释 handle 增长。

## 7. Golden path 和 failure path

### Golden path

1. Core 校验三组件版本和 `m0-sync-v1` capabilities。
2. Core 按 Execution Policy 原子 admission 一个 task attempt。
3. Core 使用稳定 create operation id 获取独立 writable workspace。
4. Core bind run，然后在该 path 调用 Flow invoke v1。
5. Flow 返回结构化 terminal result；Core 校验 version/status。
6. Core 收集 diff/snapshot，校验 artifact digest 并登记 evidence。
7. Core 只在 Flow/host 已 quiescent 后请求 cleanup。
8. Workspace 确认 `removed: true`；Core 释放容量并完成 task projection。

### Required failure paths

| 故障 | 验收结果 |
| --- | --- |
| 未知契约版本 | side effect 前拒绝，记录兼容错误 |
| create response 丢失 | 使用同一 operation id 查询/重试，不创建第二 worktree |
| 相同 operation id 不同输入 | provider 返回 conflict，Core 不换 id 自动重试 |
| Flow abort 已记录但进程仍活跃 | 不释放容量、不 cleanup，进入 reconciliation-required |
| lease 在写入时过期 | 写入方停止；刷新状态后显式接管或人工处理 |
| 同线 Git conflict | target 恢复可诊断状态，双方 commit/evidence 保留 |
| cleanup 目录部分删除或句柄占用 | 非 cleaned；保留 blockers 和 retry path |
| Core 在 invoke 前后崩溃 | M2 由 durable command/outbox 恢复，最多一次逻辑副作用 |

## 8. Upgrade、downgrade 和 rollback

升级顺序：

1. 先发布向后兼容的 provider（Flow/Workspace）和 provider tests。
2. 在 staging 运行旧 Core + 新 provider 的 `m0-sync-v1` 套件。
3. 再发布能协商新 capability 的 Core；capability 默认关闭。
4. 运行 consumer tests 和 M4 canary 后按 Execution Profile 逐项目启用。

降级/rollback 规则：

- patch/minor 版本不能假定兼容，仍需匹配 contract version/capability。
- 关闭新 admission，等待或取消并 reconcile active work，再切换 provider 版本。
- 不能在同一 task/command 上同时运行新旧 dispatch mode。
- 数据库 migration 必须保持旧字段，并在读路径提供已记录的默认值。
- 如果 downgrade 不理解已启用 capability，Core 必须保持任务暂停并要求 operator，
  不能把状态重写为 queued/completed。
- Workspace downgrade 前保留所有未确认清理的目录和 registry；Flow downgrade 前
  保留 authoritative run state/events。

不支持的组合包括：

- Flow 不声明 `zigma-flow` provider、contract version `1` 或 M0 capabilities；
- Workspace 不声明 `zigma-workspace` provider、`contract_version: 1`、完整 M0
  capabilities，或返回非 envelope pending 数据；
- 要求 reliable events 却只配置 best-effort `--event-file`；
- 要求强隔离却只依赖 manifest/read-only Git 标记；
- 未实现 M2 durable command 却把自动重试当作 exactly-once；
- 任一 writable invocation 没有独立 Workspace path。

## 9. M0 关闭证据

- 架构 ADR：[zigma-core#15](https://github.com/LummiGhost/zigma-core/pull/15)
- Core capacity policy：[zigma-core#16](https://github.com/LummiGhost/zigma-core/pull/16)
- Flow provider contract：[zigma-flow#299](https://github.com/LummiGhost/zigma-flow/pull/299)
- Workspace provider contract：[zigma-workspace#29](https://github.com/LummiGhost/zigma-workspace/pull/29)
- 本矩阵及 Core consumer contract tests：M0.5 PR

M0 关闭只表示契约、最低组合、测试所有权和后续 gates 已明确。真正的多任务
并行开发能力仍需 M1–M4 全部完成。

## 10. M2 关闭证据

- Durable command/outbox 与 idempotency：Core PR #22。
- 原子多级容量与 fencing lease：Core PR #23。
- 异步 worker、重启恢复、有限安全重试与取消：Core PR #24。
- Correlated callback、workspace handle/evidence projection：本 PR。

`core-durable-v1` 只解锁 Core 的可靠调度能力。强 workspace 隔离仍必须等待
`workspace-isolated-v1`；完整并行开发承诺仍必须等待 `parallel-e2e-v1`。
