# 上游 ISSUE 草稿：zigma-workspace

面向 https://github.com/LummiGhost/zigma-workspace 提交。zigma-workspace v0.1.0 的 CLI 已全面支持 `--json`（`{ok:true,data}` 信封），满足 zigma-core 大部分需要，本 ISSUE 主要是**契约固化**请求。

---

## ISSUE 1：固化 `create` / `diff` 的 JSON 输出为稳定契约

**标签**：`api-contract` `priority:medium`

### 背景

zigma-core（控制面）在 Core-first 工作区模式下调用：

```bash
zigma-workspace create --repo <url> --base <ref> --branch <name> --mode writable --json
zigma-workspace diff <workspace_id> --json [--patch-out <file>]
zigma-workspace bind-run <workspace_id> --run <flow_run_id> --json
```

并把结果落库为 `WorkspaceRef { zigmaWorkspaceId, path, branch, baseRef, baseCommit, mode, status }`，其中：

- `create` 输出的 `workspace_id / path / branch / base_ref / base_commit / mode / status / manifest_path`；
- `diff` 输出的 `changed_files / untracked_files`（以及 `--patch-out` 落盘的 patch 文件）；

被 Evidence Bundle 的 `codeChanges` 直接消费。

### 请求

1. 在 docs/prd.md 或新增 docs/api.md 中，将上述字段声明为**稳定契约**（semver 保障：删除/改名视为 breaking change）；
2. 明确 `base_commit` 在所有 mode 下都保证存在（zigma-core 用它锚定 diff 基线）；
3. 明确 `diff` 在 workspace 处于 `locked` / `archived` 状态时的行为（报错 or 返回最后快照的 diff）；
4. （nice-to-have）`diff --json` 增加 `head_commit` 字段，便于证据包记录精确区间。

### 验收

- [ ] 文档列出各命令 `--json` 的字段清单与稳定性承诺；
- [ ] `base_commit` 缺失场景（如 shallow clone）有明确错误码；
- [ ] `head_commit`（如采纳）在 diff 输出中出现。
