# 上游 ISSUE 草稿：zigma-flow

以下四个 ISSUE 面向 https://github.com/LummiGhost/zigma-flow 提交。zigma-core 作为 API 契约的更高优先级方，请求 flow CLI 补齐 host 集成所需的最小表面。每条均附当前 zigma-core 的临时绕行方案，上游落地后即可删除绕行代码。

---

## ISSUE 1：`invoke` 增加 `--json`，在 stdout 回显 runId

**标签**：`host-integration` `cli` `priority:high`

### 背景

zigma-core（Host 侧控制面）通过 `zigma-flow invoke <workflow> --task <text>` 启动 run，需要立即获得 runId 以建立 `FlowRunRef` 并后续 `inspect`/`approve`/`abort`。当前 `invoke` 不输出 runId（`inspect` 已支持 `--json`，但 `invoke` 没有）。

### 现状绕行（希望移除）

zigma-core 在 invoke 前后对比 `.zigma-flow/runs/` 目录名集合，取新增目录名作为 runId（轮询上限 15s）。该方案：

- 仅在单进程串行 invoke 下无歧义，并发启动会撞车；
- 依赖运行目录布局这一未承诺的内部细节。

### 请求

```bash
zigma-flow invoke code-change --task "..." --json
# stdout: {"ok":true,"data":{"runId":"2026-07-20-...","status":"running"}}
```

- `--json` 时仅向 stdout 输出单个 JSON 对象（日志走 stderr）；
- 错误也走 JSON 信封（对齐 host-api.ts 的 `HostApiError{code,message,details?,suggestion?}`）；
- 与 `inspect --json` 的信封风格保持一致。

### 验收

- [ ] `invoke --json` 成功时 stdout 输出含 `runId`；
- [ ] 失败时输出 `HostApiError` 形状且退出码非 0；
- [ ] `--resume` 路径同样支持 `--json`。

---

## ISSUE 2：`invoke` 增加 `--caller-context <file>`

**标签**：`host-integration` `cli` `security` `priority:high`

### 背景

`docs/host-integration.md` 约定 Host 负责身份/权限，run 目录内有 `caller-context.json`。但 CLI 没有入口把 CallerContext 传进去。

### 现状绕行（希望移除）

zigma-core 在发现 runId 后 best-effort 直写 `.zigma-flow/runs/<runId>/caller-context.json`。问题：

- 写入发生在 run 启动之后，首个 agent step 可能读不到；
- Host 直写 flow 内部目录破坏边界。

### 请求

```bash
zigma-flow invoke code-change --task "..." --caller-context ./ctx.json
```

- 文件形状即 host-api.ts 的 CallerContext（user/actor/source/permissions/project）；
- flow 在 run 初始化时校验并快照到 run 目录，供 step 读取与权限判定；
- 缺省时保持现行为（匿名/本地上下文）。

### 验收

- [ ] run 目录内 `caller-context.json` 在任何 step 执行前就绪；
- [ ] 非法 JSON / 缺字段时启动即失败并给出 `suggestion`。

---

## ISSUE 3：CLI 暴露 `evidence <runId> --json`

**标签**：`host-integration` `cli` `priority:medium`

### 背景

host-api.ts 已定义 `collectRunEvidence`，但 CLI 未暴露对应命令。zigma-core 的 Evidence Bundle（FR-009）目前只能用 `inspect --jobs --events --artifacts --json` 的通用镜像自行提炼 validation/check 证据，提炼逻辑依赖事件命名习惯（`check.*`），偏脆弱。

### 请求

```bash
zigma-flow evidence <runId> --json
```

输出与 `collectRunEvidence` 返回一致的结构化证据（artifacts、check 结果、gate 决策、summary），作为稳定契约。

### 验收

- [ ] 输出 schema 写入 docs/host-integration.md；
- [ ] run 未结束时也可调用（返回当前已产生的证据）。

---

## ISSUE 4：`approve` / `reject` 增加 `--actor <id>`（可选 `--actor-email`）

**标签**：`host-integration` `cli` `audit` `priority:medium`

### 背景

Host 侧审批（Web/邮件/CLI）由 zigma-core 校验审批人权限后中继到 `zigma-flow approve/reject --run --job --step --comment`。当前 flow 侧事件里没有审批人身份，flow 的 events.jsonl 无法独立作为审计证据，必须与 Core 记录联查。

### 请求

```bash
zigma-flow approve --run <id> --job review --step gate --actor alice --comment "LGTM"
```

- actor 写入 gate 决策事件 payload；
- 不做权限判定（权限仍归 Host），仅留痕。

### 验收

- [ ] events.jsonl 中 gate 决策事件包含 actor 字段；
- [ ] 未传 `--actor` 时行为不变（向后兼容）。
