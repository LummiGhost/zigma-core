# PR 草稿：Zigma-Core MVP —— 控制面完整设计与实现

> 提交到 https://github.com/LummiGhost/zigma-core 时可直接使用本文作为 PR 描述。
> 分支建议：`feat/core-mvp` → `main`。

## 概要

实现 PRD v0.2 的全部 MVP 范围（第 10 节 10 项），交付 zigma-core 控制面骨架：领域模型、SQLite 持久化、zigma-flow / zigma-workspace 适配器、权限快照、Human Gate 镜像、Evidence Bundle、审计日志，以及库 API / HTTP API / CLI 三层入口。

**设计文档**：`docs/design.md`（模型细化、ER、状态机、权限映射表、关键时序、API 契约、上游缺口）。

## PRD 覆盖

| FR | 状态 | 实现位置 |
|---|---|---|
| FR-001 项目注册与配置 | ✅ | `api/core.ts` createProject/registerRepository/createExecutionProfile |
| FR-002 任务创建 | ✅ | `services/taskService.ts` |
| FR-003 任务状态机 | ✅ | `types/index.ts` TASK_TRANSITIONS + transition() 唯一入口 |
| FR-004 Flow Run 启动 | ✅ | `services/executionService.ts` + `adapters/flow/localCli.ts`（local-cli 模式）|
| FR-005 Workspace 协调 | ✅ | Core-first：createWorkspaceForTask；flow-script：WorkspaceRef 对账回写 |
| FR-006 CLI Tool 权限策略 | ✅ | ExecutionProfile.allowedTools → 快照 → CallerContext `tool:*` |
| FR-007 状态同步 | ✅ | syncRun/syncTask（inspect --json 镜像）|
| FR-008 Human Gate | ✅ | `services/gateService.ts`：镜像/权限校验/中继/autoResume/留证 |
| FR-009 Evidence Bundle | ✅ | `services/evidenceService.ts`（flow 不可达时优雅降级）|
| FR-010 代码交付协调 | ✅ | ExternalLink + 审计（Core 不建 PR，符合 PRD）|
| FR-011 权限快照 | ✅ | 不可变，revision 递增，仓储层无 update/delete |
| FR-012 审计日志 | ✅ | 全链路 append-only audit_events |
| FR-013 API | ✅ | ZigmaCore 门面 + HTTP（serve）+ CLI（zigma-core）|

## 关键设计决策

1. **无 Runner 架构**：执行差异收敛进 `FlowExecutionProfile.mode`；MVP 仅 `local-cli`，`local-service`/`remote-host` 保留枚举位并显式报错，防止静默降级。
2. **严格边界**：Core 获取 flow 状态只走 `inspect --json`；不解析 `state.json`。唯一目录级操作是读 `.zigma-flow/runs/` 目录名（runId 发现）与 best-effort 写 `caller-context.json` —— 两者均为过渡方案，对应上游 ISSUE（`docs/issues/zigma-flow-issues.md` #1/#2）。
3. **CallerContext 逐字段对齐** zigma-flow `src/host-api.ts`；Core 的能力位（8 个 grants）到 flow permission 字符串的映射固化在 `permissionService.ts`（design.md §5 有对照表）。
4. **awaiting_human 与 blocked 分离**：flow blocked 且有待决 gate → `awaiting_human`（要人）；blocked 无 gate → `blocked`（要运维），语义不同、路由不同。
5. **审批权不外溢**：gate 无 allowedApprovers 时，仅权限快照对应 actor 本人且快照含 `canApproveHumanGate` 可决。
6. **适配器可注入**：`FlowInvoker` / `WorkspaceClient` 接口注入，测试用 Fake，未来 Host API 直调零改动服务层。

## 测试

- vitest 17 例全绿（状态机、启动/快照/CallerContext、权限映射、sync 幂等、gate 审批/拒绝/双决/越权、evidence 全量与降级）。
- `tsc --noEmit` 零错误；真实 CLI + SQLite 冒烟通过。

## 变更清单

新增 ~30 文件：`src/{types,errors,ids,db,adapters,services,api,http,cli}`、`tests/`、`docs/{design.md,prd.md,issues/}`、`README.md`、构建配置。无删除、无破坏性变更（新仓库首个功能 PR）。

## 依赖上游（不阻塞合并）

- zigma-flow：invoke --json / --caller-context / evidence CLI / approve --actor（4 个 ISSUE 草稿见 docs/issues/）。
- zigma-workspace：create/diff JSON 字段契约固化（1 个 ISSUE 草稿）。
