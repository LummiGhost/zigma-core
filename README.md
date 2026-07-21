# zigma-core

Zigma 平台控制面（Control Plane）。把外部开发请求转化为**有权限快照、有工作区、有 flow run、有审批记录、有交付证据**的可审计 Agent 开发任务。

- 流程执行 → [zigma-flow](https://github.com/LummiGhost/zigma-flow)（Core 只启动/观察/审批/取消，不读写其内部状态机）
- 工作区 → [zigma-workspace](https://github.com/LummiGhost/zigma-workspace)
- 设计文档 → [docs/design.md](docs/design.md)，PRD → [docs/prd.md](docs/prd.md)

## 安装与构建

```bash
pnpm install   # 或 npm install
npm run build  # tsc → dist/
npm test       # vitest（17 例）
```

要求 Node >= 20.11。数据库为内嵌 SQLite（better-sqlite3，WAL），默认路径 `.zigma-core/core.db`。

## 快速开始（CLI）

```bash
# 1. 注册项目（projectRoot 指向包含 .zigma-flow/ 的目录）
zigma-core project create --name DataCat \
  --root /path/to/datacat --workflow code-change

# 2. 创建任务
zigma-core task create --project prj_xxx \
  --title "Add CSV export" --description "Export query results as CSV" --actor alice

# 3. 启动（生成权限快照 → 调 zigma-flow invoke → 记录 FlowRunRef）
zigma-core task start --id task_xxx --create-pr --actor alice

# 4. 同步状态 / 查看待审批门
zigma-core task status --id task_xxx --sync
zigma-core gate list

# 5. 审批（中继到 zigma-flow approve 并自动 resume）
zigma-core gate approve --id gate_xxx --actor alice --comment "LGTM"

# 6. 汇总证据包 / 审计
zigma-core evidence --task task_xxx
zigma-core audit --task task_xxx
```

## HTTP API

```bash
zigma-core serve --port 7180
```

`POST /projects`、`POST /tasks`、`POST /tasks/:id/start|sync|cancel|links|evidence`、`GET /tasks/:id/status`、`GET /gates`、`POST /gates/:id/approve|reject`、`GET /evidence/:id`、`GET /audit`、`GET /health`。错误信封统一 `{ code, message, details?, suggestion? }`。

## 库 API

```ts
import { ZigmaCore } from "@zigma-ai/zigma-core";

const core = new ZigmaCore({ dbPath: ".zigma-core/core.db" });
const project = core.createProject({ name: "DataCat", projectRoot: "/repo/datacat", defaultFlowWorkflowId: "code-change" });
const task = core.createTask({ projectId: project.id, title: "Add CSV export", description: "...", source: { channel: "api" }, createdBy: { type: "user", id: "alice" } });
const run = await core.startTask(task.id, { actor: { type: "user", id: "alice" }, grants: { canWriteCode: true, canCreatePullRequest: true } });
```

`FlowInvoker` 与 `WorkspaceClient` 可注入替换（测试/未来 Host API 直调）。

## 架构一览

```
cli / http  →  api(ZigmaCore)  →  services(permission/task/execution/gate/evidence)
                                     ↓                     ↓
                              adapters(flow, workspace)   db(sqlite repos)
```

任务状态机：`created → queued → running → {awaiting_human, blocked} → {completed, failed, cancelled}`（failed 可重试回 queued）。权限快照不可变，变更即新 revision。详见 [docs/design.md](docs/design.md)。

## License

Apache-2.0
