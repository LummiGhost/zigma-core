# Zigma Core PRD

文档版本：v0.2

状态：草案

日期：2026-07-14

仓库：`zigma-core`

（本文件为随仓库归档的 PRD 副本；实现细节与差异说明见 docs/design.md。）

## 1. 项目定位

Zigma Core 是 Zigma 平台的控制面组件，负责项目、任务、权限、审批、证据汇总和平台级状态管理。它将用户请求转化为可执行的 `zigma-flow` run，并把 `zigma-flow`、`zigma-workspace`、外部 Git/GitHub CLI、未来的 `zigma-code` 组织为一个可审计的开发任务生命周期。

一句话定义：Zigma Core 是 Zigma 的平台控制面，负责把外部请求转化为有权限快照、有工作区、有 flow run、有审批记录、有交付证据的 Agent 开发任务。

当前版本明确移除 `zigma-runner` 作为独立组件：Core 通过本地进程、服务进程或未来 execution host 直接启动 `zigma-flow`；`git`、`gh`、`pnpm`、`zigma-workspace` 等命令由 `zigma-flow` 的 `script` / `check` step 调用并纳入 artifact/evidence 体系。

## 2. 核心功能需求索引

- FR-001 项目注册与配置（Project CRUD、默认仓库/workflow/profile 绑定）
- FR-002 任务创建（多来源）
- FR-003 任务状态机（created→queued→running→awaiting_human/blocked→completed|failed|cancelled）
- FR-004 Flow Run 启动（Execution Profile；MVP local-cli）
- FR-005 Workspace 协调（Core-first 与 flow-script 双模式，统一回写 WorkspaceRef）
- FR-006 CLI Tool 权限策略（allowedTools 快照）
- FR-007 状态同步（FlowRunRef 状态镜像）
- FR-008 Human Gate 处理（镜像、审批权限校验、回传、留证）
- FR-009 Evidence Bundle 汇总
- FR-010 代码交付协调（Core 不直接建 PR，只记录 ExternalLink 与审计）
- FR-011 权限快照（不可变，revision 递增）
- FR-012 审计日志
- FR-013 最小 API（createProject/createTask/startTask/getTask/getTaskStatus/approveGate/rejectGate/cancelTask/collectEvidence）

完整原文（含背景、核心概念 TS 定义、数据模型、组件关系、MVP 范围、DataCat 场景、成功标准、风险与开发阶段）请见项目文档库中的《Zigma Core PRD v0.2》；实现遵循并在 design.md §3 标注了与 PRD 的字段级差异（如 Project.status/projectRoot 增补）。
