# M4 验收证据：跨 Core/Flow/Workspace 的并行开发生命周期

日期：2026-09-12

验收入口：`npm run test:m4-cross-repo`；CI job `m4-cross-repo-contracts` 以固定
provider pin（Flow `eb48a5f`（PR #322）、Workspace `edac5df`（PR #44/#45））复现
同一命令，从源码构建三个仓库后注入真实 CLI 路径，绝不接受 PATH 上的陈旧产物。

## 目标

证明 Core 通过真实 `core serve` 进程驱动真实 Flow 与 Workspace CLI，完成完整
受管生命周期的并行执行：任务准入 → Flow run + 受管 workspace → commit /
integrate / publish / reconcile / cleanup —— 外加冲突、取消回滚、两个重启
窗口、worker 被杀与 single-writable 不变量，每个 run 都有可量化的执行指标。

## 证明方式

`tests/m4/` 六个 env-gated 测试文件，各自启动真实 `core serve`（HTTP + 文件型
SQLite，经 execution profile 的 `environment` 注入
`ZIGMA_FLOW_CLI_PATH` / `ZIGMA_WORKSPACE_CLI_PATH`），断言跨进程可观察事实
（workspace registry 行、Git ref、Flow run 目录、持久化 metrics），而不是组件
内部状态。

### m4-managed-parallel

16 个任务跨 2 个项目/仓库，经 `serve --workers 4` 真实并发完成：每个 run 均
commit + integrate、发布 `flow/<runId>` 分支、success retention 清理 run 与
attempt workspace；metrics 为 dispatched/started/completed=1、
workspace_conflicts=0、reconcile_restarts=0，`start_to_terminal` 在 300s 内，
总墙钟 < 420s。

### m4-conflict-rollback

job attempt 打开期间外部 commit 进入 Run workspace；integrate 输出类型化
merge conflict → job 以 `workspace_merge_conflict` 失败、Run workspace 完整保留
（外部 commit 为 head、无 merge 残留）、失败 attempt workspace 保留、不发布、
`main` 与初始 commit 一致。metrics：workspace_conflicts=1。

### m4-cancel-and-rollback

持有中任务经 Core cancel API 标记（task blocked），对 live owner 投递 abort；
quiescence 确认（ownerStatus cancelled）后才按 failure retention 严格清理
run workspace，未完成的 attempt workspace 保留，repository 无任何提交或发布。
metrics：dispatched=1、started=1、cancelled=1、completed/failed=0、
reconcile_restarts=0、worker_kills=0。

### m4-restart-recovery

两个崩溃窗口：

- A（dispatch 标记前）：serve 进程在 `before-dispatch-marker` 故障注入相位（lease
  已激活、provider 边界尚未持久化）暂停，测试在此精确杀死 Core；重启后
  command 重置并重新 dispatch —— dispatched 恰好计 1 次、worker_kills=1（foreign
  lease takeover）、reconcile_restarts=0、只有一个 Flow run 目录，正常 publish +
  cleanup。
- B（持有中）：只杀 Core，Flow owner 存活；重启后 sweep 接管 foreign lease
  并持续 reconcile 活着的 invocation（interim reconciling），释放后幸存 owner
  完成 finalize/publish/teardown（retention success:retain 保留 run workspace、
  清理 attempt），terminal 重建记录 reconcile_restarts=1 与
  start_to_terminal=1。

### m4-worker-kill

持有中杀死 Flow owner（及其 step 子树）：command 收敛到 reconciling 且不再
redispatch（fail-safe），task blocked / run running，run 与 job workspace 均
保留、无发布、repository 未动。metrics：dispatched=1、started=1，无 terminal
计数。

### m4-invariants

三任务单仓库：A 持有 single-writable 槽位时 B/C 均不得进展（started=0、
admission_denied=0 —— 忙碌 runtime 不轮询）；A 完成后恰好一个 sibling 赢得
slot、另一个被拒一次（总计 admission_denied=1）；每 run 的 step cwd 等于
registry 中的 job workspace 路径；冻结的 `caller-context.json` 恰为启动时传入
的 6 个 capability；registry 对每个外部 run 恰有 1 run 行 + 1 job 行且全部
CLEANED；三个 run 各自发布分支，`main` 不变。

## 指标表面

`GET /v1/flow-runs/:id/metrics` 与 CLI 暴露每个 run 的持久化快照：

- counters：`dispatched`, `started`, `completed`, `failed`, `cancelled`,
  `awaiting_human`, `workspace_conflicts`, `lease_fences`,
  `reconcile_restarts`, `worker_kills`, `admission_denied`
- durations（count/min/max）：`queue_to_dispatch`, `dispatch_to_start`,
  `start_to_terminal`, `quiescence`

语义：terminal 快照在首次 terminal 转换时持久化；`dispatched`/`started` 为
进程内 live 计数，跨重启丢失（per-process-window），terminal 重建会补记
`reconcile_restarts` 与 `start_to_terminal`。

## 局限

- 并行吞吐上界基于单机真实并发（clone/commit/integrate/publish/cleanup 每 run
  一次），不代表网络远端性能。
- worker kill 后的 run 无自动恢复路径：Core 停在 reconciling 是设计上的
  fail-safe（不盲目重跑），需宿主按 M3 恢复流程 reconcile/cleanup。
- 指标无 histograms/导出器；快照粒度为 run 级。

## 运行

```bash
$env:ZIGMA_FLOW_REPO = 'D:\zigma\zigma-flow'
$env:ZIGMA_WORKSPACE_REPO = 'D:\zigma\zigma-workspace'
npm run test:m4-cross-repo
```
