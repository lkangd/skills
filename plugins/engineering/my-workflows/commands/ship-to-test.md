---
description: Commit → push → create MR (dev-f → f) → merge MR → deploy f branch to test
argument-hint: [审核人姓名或关键字]
allowed-tools:
  - Bash(git:*)
  - Bash(yunke-cli:*)
  - Bash(npm:*)
  - Bash(curl:*)
  - Bash(node:*)
---

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Goal

将当前项目的变更走完整个接测链路：提交 → push → 创建 dev-f → f 的 Merge Request → 通过 GitLab API 合并 MR → 将 f 分支部署到全部测试环境。

`$ARGUMENTS` 为可选的 MR 审核人姓名或关键字。

除步骤 1（提交，需要生成 commit message）外，整个链路由一体化脚本一次性完成。**禁止手动执行 git pull/push、yunke-cli 查询/创建/部署或 GitLab API 调用来替代脚本**；agent 只负责：跑脚本、读输出、出错时按脚本给出的 `RESUME` 命令断点续跑。

## 步骤 1：提交变更

若 Context 中 git status 显示没有任何变更（工作区干净），跳过本步骤直接进入步骤 2。

Based on the above changes, create a single git commit. If recent commits are empty, use the standard commitizen commit format.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. **Do not send something like 'Co-Authored-By'.**

## 步骤 2：执行一体化接测脚本

运行（`$ARGUMENTS` 非空时追加 `--audit-user "$ARGUMENTS"`）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" run
```

脚本内部依次完成：环境检查（yunke-cli 缺失时自动安装、GitLab token 检查）→ `git pull --rebase` + `git push` → yunke-cli 查询链（分支状态/仓库/应用/审核人）→ 创建 MR 并通过 GitLab API 反查 MR 链接 → 合并 MR → 对全部接测目标（`env_code` 含 `test` 且 `app_name` 与目录名匹配的环境）逐个部署并原样打印结果。前置查询结果落在状态文件中，断点续跑时原样复用，不会重新推断参数。

审核人取自 `~/.yunke-cli/my-workflow-reviewers.json`，优先级：显式 `--audit-user` > `*` 级记录（所有项目通用） > 本项目记录（origin 为 key） > 让用户选择。

## 步骤 3：处理脚本输出

按输出末尾的 `STATUS` 处理：

- **`STATUS: OK`**：读取 `SUMMARY` 与各环境部署的完整输出，进入汇报。若输出中包含 `ASK_REGISTER_GLOBAL` 行（本次通过参数新增了审核人），在汇报时询问用户是否将该审核人注册为 `*` 级（所有项目通用）；用户同意则执行该行给出的 `register-global` 命令。
- **`STATUS: NEED_USER`**：需要用户介入。按 `DETAIL` 处理，问题解决后执行输出中的 `RESUME` 命令继续（不要从头重跑）。常见情形：
  - **rebase 冲突**：先自行查看冲突内容，判断能否安全解决（如纯格式、显然互不相关的改动），能则解决后 `git rebase --continue` 再按 `RESUME` 续跑；不能则让用户介入，用户确认处理完后续跑。
  - **审核人待选择**：`DETAIL` 中已包含候选列表，让用户选择，并同时询问是否将所选审核人注册为 `*` 级（所有项目通用）。选择后将所选 `user_name` 填入 `RESUME` 命令的 `--audit-user` 参数续跑（脚本会写入本项目记忆）；若用户同意注册为 `*` 级，再执行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-run.js" register-global <user_name>`。
  - **缺少 GitLab token**：让用户配置环境变量 `MY_WORKFLOW_GL_ACCESS_TOKEN` 后续跑（不要打印其值）。
- **`STATUS: ERROR`**：读取 `STEP` 与 `DETAIL`。能自行安全修复的（如 push 被拒需先同步）修复后按 `RESUME` 续跑；不能则向用户说明失败原因与建议操作，等用户确认后续跑。MR 合并失败的常见原因是流水线未通过、需要审批或存在冲突。

## Report

全部完成后，用中文简要汇报：

1. 提交的 commit 信息与 push 结果。
2. 创建并已合并的 MR 链接与审核人。
3. 每个接测目标环境与对应的部署触发结果（部署命令的完整输出已由脚本打印，摘要即可，异常环境需明确指出）。
