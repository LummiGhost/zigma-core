# Zigma 组件集成契约

版本：1.0

本文记录 Core 侧的集成边界。精确最低版本、命令、envelope、capability、
provider/consumer tests 和 rollout 规则见
[跨仓兼容矩阵](compatibility-matrix.md)。组件所有者的完整语义分别记录在：

- Core：[ADR-0001](adr/0001-parallel-development-execution-contract.md)
- Flow：`zigma-flow/docs/platform-integration-contract.md`
- Workspace：`zigma-workspace/docs/platform-integration-contract.md`

## 1. 契约优先级

1. 组件所有者定义其状态机和 side-effect truth。
2. 版本化 machine envelope 是跨进程事实；人类可读日志不是协议。
3. Core adapter 是 anti-corruption layer，负责版本拒绝、字段校验和投影。
4. Core 的兼容矩阵决定一个组件组合是否可 admission。
5. 未通过 provider/consumer contract tests 的能力不能仅凭包版本启用。

## 2. 所有权

| 能力 | 权威所有者 | Core 中的记录 |
| --- | --- | --- |
| Workflow DAG、job/step/attempt/run state | Zigma Flow | Flow Run projection |
| Flow event log 和 runtime artifact | Zigma Flow | Evidence URI 和 audit projection |
| Git worktree、workspace path、lock/lease、cleanup | Zigma Workspace | Workspace Ref 和 cleanup projection |
| Task、admission、capacity、permission、human decision | Zigma Core | 对应 Core aggregate |
| Artifact bytes | 生产组件或 artifact store | content-addressed Evidence Item |

Core 不修改 Flow runtime state，不通过目录扫描替代 Workspace 对账，也不从
provider process exit code 单独推断 terminal/cleaned 状态。

## 3. 当前 adapter 表面

### Flow

`LocalCliFlowExecutor` 使用：

- 在每个 mutating command 前调用并缓存只读
  `contract-info --json` handshake；只接受 provider `zigma-flow`、contract
  version `1` 以及 `caller-context-v1`、`invoke-json-v1` 和
  `context-freeze-v1`。`packageVersion` 必须是非空诊断字段，但不参与兼容性拒绝；
- `invoke --json --context-file`，校验 `contractVersion: 1`、run ID 和 status；
- `resume ... --json` 提交 human gate decision；
- `abort --run ... --reason ... --json` 记录取消请求。

context file 是 Flow 的 canonical `CallerContextV1`：它保留 actor、capabilities、
constraints、source、task/flow-run/project identity，以及 Core permission snapshot
ID 和 integrity hash。Core 不会把缺失的 permission evidence 降级为 `null`；Flow
接受后将该 record 冻结到每个 run 的 `caller-context.json`。

Abort 响应不是进程终止证明。M2 execution lease 只在 dispatch 调用返回后释放；
超时或结果不确定的 invocation 进入 `reconciling`，不盲目重跑或提前 cleanup。

Flow 的 `callback-envelope-v1` 必须带 `contractVersion: 1`、`producer: "zigma-flow"`、
`callbackVersion: 1`、`flowRunId`、
`operationId`、`callbackCorrelationId`、`externalRunId` 和单调递增正整数 `sequence`，
也可带 managed Run/Job-attempt workspace handle 和 evidence。Core 校验冻结的
command identity、route/body Flow run 一致性、外部 run 一次绑定和连续顺序；Flow
按 authoritative event log 顺序投影全部事件，因此下一个序号必须严格为 `last + 1`；仅完全
相同的 envelope 可重放，然后投影 handle/evidence。Flow 仍是 Job/attempt 状态权威，
Workspace 仍是 worktree、快照、reconcile 和 cleanup 权威。

### Workspace

`ZigmaWorkspaceCliAdapter` 使用：

- 在任何 create/bind/diff/snapshot/cleanup side effect 前调用并缓存只读
  `contract-info --json` handshake；只接受 provider `zigma-workspace`、contract
  version `1` 和完整 M0 capability 集。`package_version` 必须是非空诊断字段，但
  不参与兼容性拒绝；
- `create`、`bind-run`、`diff`、`snapshot` 和基础 `cleanup`；
- 对所有 stdout success/error envelope 校验 `contract_version: 1`；
- create/bind 使用由 Core flow run 派生的稳定 operation id；
- cleanup 只有在 `removed: true` 时返回成功。

证据收集把 `diff.patch_artifact` 和 `snapshot.artifacts` 视为不受信任的 provider
metadata：每个 artifact 必须有 `file:` URI、lowercase `sha256:<64 hex>` digest 和
可读本地 bytes，Core 重算 digest 后才登记 evidence。未知 handshake version 或
篡改的 artifact bytes 都在后续 side effect/evidence 写入前 fail closed。

自 M3.5 起，reconcile 与 strict cleanup 已是 stable CLI（`reconcile --workspace`、
`cleanup --workspace --operation-id --strict`），Core 的 M3 生命周期证据测试直接
跨进程使用它们（见下方 managed bridge 小节）；heartbeat 与 integration lock 仍
只在 workspace 内部使用，不作为 Core 依赖。

### Managed workspace bridge (M3.5)

zigma-flow 在 `ZIGMA_WORKSPACE_CLI_PATH` 指向 workspace CLI 构建产物时激活
managed bridge：provider 必须通过 `contract-info` 自报 `contract_version === 1`、
`provider === "zigma-workspace"` 且 `managed_supported === true`，缺失或为 `false`
一律 fail closed，绝不静默回退到 external-directory 执行。Flow 侧不硬编码任何
capability 列表；workspace 的 `negotiate --role managed` 提供同语义的单次校验。

Core 通过 provider profile 的 `environment` 注入以下变量（经
`core-service.ts` → `LocalCliFlowExecutor` 的环境透传）：

- `ZIGMA_WORKSPACE_CLI_PATH` — 已构建 workspace CLI（`dist/cli/index.js`）的
  绝对路径；未设置时 managed workflow 在 Flow Engine 端口按既有
  ValidationError fail closed；
- `ZIGMA_WORKSPACE_STATE_DIR` — 可选；透传为每次 CLI spawn 的全局
  `--state-dir`，把 registry/journal/锁收敛到 Core 可见的位置。

Bridge 最初只实现 `prepare-run`/`prepare-job`；自 M4 起覆盖完整生命周期：
`commit` / `integrate` / `publish` / `reconcile` / `cleanup`（operation-id
命名空间 `run:<runId>[:job:<jobId>:attempt:<n>]`）。integrate 的
`WORKSPACE_INTEGRATION_CONFLICT` 错误 envelope 被投影为类型化 `conflicted`
结果（job 以 `workspace_merge_conflict` 失败、Run 保留、attempt 保留、不
发布），cleanup 失败以 `cleanup_failed` 状态返回而不是抛出。清理遵循
workspace 侧的 per-workspace retention（`success|failure|blocked`，缺省回落
全局 `retainFailedDays`），job 级默认 success→cleanup。

run 取消或崩溃后，未收敛的 job attempt 与 run workspace 会留在 workspace
registry 中（status RUNNING）。Core 的 M3 生命周期证据测试证明宿主可以对此
恢复：abort 到 quiescence 后，用 workspace CLI 逐个 `reconcile` 并按
job→run 顺序 `cleanup --strict`，registry 收敛为 CLEANED。M4 证据测试
（`npm run test:m4-cross-repo`）进一步覆盖并行完成、外部提交冲突、取消回滚、
两个重启窗口、worker 被杀与 single-writable 不变量，证据记录见
[`docs/m4-results.md`](m4-results.md)（跨仓库兼容矩阵见 zigma-workspace
`docs/compatibility-matrix.md`）。

## 4. 共同规则

- 相同 operation/command id 与相同输入表示同一逻辑操作；不同输入必须冲突。
- timeout 表示结果未知，触发 reconciliation，不表示失败或取消已完成。
- unknown contract version/capability 必须在 side effect 前 fail closed。
- stdout 只承载 JSON/NDJSON；诊断日志走 stderr。
- `file:` artifact URI 仅在同一宿主有效；跨宿主传递必须进入 artifact store。
- writable attempt 必须拥有独立 Workspace path；manifest 不是 OS sandbox。
- cleanup 只有在目录与 Git registration 都确认移除后才是事实终态。

## 5. 演进规则

新增可选字段和错误码可以保持主契约版本；删除字段、改变语义、幂等边界或
状态含义需要提高主版本。Provider 先发布向后兼容能力，Core 再通过 capability
协商启用。Rollback 先停止新 admission，等待/取消并 reconcile active work，
不得让新旧 dispatch mode 同时处理同一 command。

## Windows CLI ownership and startup diagnostics

Core starts Flow through a detached Node owner on Windows. That owner invokes the configured CLI with inherited pipe handles and without detaching a command shim. This preserves stdout from npm-style `.cmd` wrappers while allowing an in-flight Flow invocation to outlive a Core restart. CLI commands and arguments are passed separately; the owner does not build shell command strings. Cross-repository gate scripts likewise invoke built JavaScript through Node.

A pre-run `(error)` sentinel is rejected as startup failure, never stored as an external run ID. Unknown provider truth remains blocked without redispatch or cleanup. When no run ID is available, reconciliation preserves the dispatch cause and does not append duplicate unchanged reconciliation-required audit events. The runtime limits reconciliation checks to once per five seconds per command; a restarted runtime may check immediately. This does not release capacity or bypass provider quiescence requirements.
