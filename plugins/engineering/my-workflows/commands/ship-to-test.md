---
description: Commit → push → create MR (dev-f → f) → merge MR → deploy f branch to test
argument-hint: [审核人姓名或关键字]
allowed-tools:
  - Bash(git:*)
  - Bash(yunke-cli:*)
  - Bash(npm:*)
  - Bash(curl:*)
  - Bash(command:*)
  - Bash(node:*)
---

## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`
- Remote origin: !`git remote get-url origin`
- yunke-cli installed: !`command -v yunke-cli || echo "NOT_INSTALLED"`

## Goal

将当前项目的变更走完整个接测链路：提交 → push → 创建 dev-f → f 的 Merge Request → 通过 GitLab API 合并 MR → 将 f 分支部署到测试环境。

`$ARGUMENTS` 为可选的 MR 审核人姓名或关键字。

## 全局规则

- 严格按步骤 1 → 5 顺序执行，前一步成功后才能进入下一步。
- 任何一步失败且无法自动恢复时：停下来，向用户说明失败原因和建议操作，等待用户确认处理完毕后，从失败的那一步继续，不要从头重跑。
- 所有 yunke-cli 命令的参数（`app_branch_id`、`repositories`、`audit_user`、`product_id`、`env_code`）必须来自前置查询的实际返回值；重试时必须原样复用，禁止推断、变形或更换新值。
- 所有 yunke-cli 查询类命令必须通过包装脚本 `${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-query.js` 执行。脚本内部调用 yunke-cli 并只输出精简 JSON（原始返回体很大，禁止直接调用原始查询命令）；脚本退出码 2 表示未匹配到目标，需要让用户介入确认。

## 步骤 1：提交变更

若 Context 中 git status 显示没有任何变更（工作区干净），跳过本步骤直接进入步骤 2。

Based on the above changes, create a single git commit. If recent commits are empty, use the standard commitizen commit format.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. **Do not send something like 'Co-Authored-By'.**

## 步骤 2：pull --rebase 后 push

1. 执行 `git pull --rebase`。
2. 如果 rebase 顺利完成（快进或无冲突），直接 `git push`。
3. 如果出现冲突：
   - 先自行查看冲突内容，判断是否能进行合理、安全的冲突处理（例如纯格式、显然互不相关的改动）。能处理则处理后 `git rebase --continue`。
   - 如果不能有把握地处理，停下来，向用户列出冲突文件和冲突原因，让用户介入处理；用户确认处理完毕后，继续 `git rebase --continue` 并 `git push`。

## 步骤 3：通过 yunke-cli 创建 Merge Request

### 3.0 前置检查

- 若 Context 显示 yunke-cli 为 `NOT_INSTALLED`，先执行安装：

```bash
npm install -g @yunke/yunke-cli@latest --registry https://registry-npm.myscrm.cn/repository/yunke/
```

  安装失败则停下来让用户介入，用户确认装好后再继续。

- 确定分支：当前分支必须以 `dev-f` 开头，是则直接使用；否则停下来让用户确认要用哪个 dev 分支。目标 f 分支 = dev 分支名去掉 `dev-` 前缀（如 `dev-f-20260522-tiktok-mvp` → `f-20260522-tiktok-mvp`）。

### 3.1 查询链路（顺序执行，参数取自上一步返回，全部通过包装脚本）

1. **查询分支状态并确定接测目标**（参数为目标 f 分支名和当前项目目录名，目录名取当前工作目录的 basename）：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-query.js" branch-status <f分支名> <项目目录名>
```

   返回 `branch_id`、`app_branch_id`、`app_name` 和 `deploy_targets`（即 `env_code` 含 `test` 且 `app_name` 能被项目目录名包含的全部环境，这些就是步骤 5 的接测目标）。若返回 `matched: false`，向用户展示 `candidate_apps` 让用户确认目标应用后再继续。

2. **查询可建 MR 的仓库与 service_name**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-query.js" repositories <app_branch_id>
```

   只有一个仓库时默认选择；多个仓库时让用户单选或多选。返回中的 `service_name`（仓库 URL 最后一段路径名）供下一步使用。

3. **通过 service_name 查询应用，获取 product_id**：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-query.js" applications <service_name>
```

   从返回 `items` 中取 `product_id`；若返回多个应用，让用户确认。

4. **确定审核人**：
   - 审核人记忆文件为 `~/.yunke-cli/my-workflow-reviewers.json`，结构为 `{ "<origin远程地址>": { "audit_user": "...", "name": "..." } }`。该文件在工作目录之外，必须使用 Read / Write 文件工具读写，禁止用 `cat` 等 shell 命令访问；文件不存在时视为空对象 `{}`。
   - 若用户通过 `$ARGUMENTS` 指定了审核人：将其作为 `keyword` 查询，能唯一匹配就直接使用，无需再选。
   - 若未指定且记忆文件中存在本项目（以 Context 中的 origin 远程地址为 key）的记录：直接使用记录的审核人。
   - 否则查询用户列表（不带 keyword 为全量）并让用户选择：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ship-to-test-query.js" users <product_id> [keyword]
```

   - `--audit_user` 使用返回中的 `user_name` 字段。
   - 最终确定的审核人写回记忆文件（不存在则创建目录和文件），供本项目下次直接使用。

### 3.2 创建 MR

执行前向用户展示：`app_branch_id`、仓库列表、审核人、接测目标（`deploy_targets`），用户确认后执行：

```bash
yunke-cli devops mars-branch-create-merge-request \
  --app_branch_id <id> \
  --repositories <repository-1> \
  [--repositories <repository-2>] \
  --audit_user <username>
```

- 多个仓库使用重复的 `--repositories` flag。
- 失败重试时原样复用所有必填值。
- 权限不足时提示用户联系 SM 或系统管理员开通 Mars 权限。
- 从成功返回中提取所有 MR 链接（形如 `https://git.myscrm.cn/<group>/<project>/-/merge_requests/<iid>`），供步骤 4 使用。

## 步骤 4：通过 GitLab API 合并 MR

1. 检查环境变量 `MY_WORKFLOW_GL_ACCESS_TOKEN` 是否存在（`[ -n "$MY_WORKFLOW_GL_ACCESS_TOKEN" ]`，不要打印其值）。不存在则停下来让用户提供并配置好后继续。
2. 对步骤 3 返回的每一个 MR 链接，解析出项目路径 `<group>/<project>` 与 MR 编号 `<iid>`，调用 GitLab Merge API（项目路径需 URL 编码，`/` → `%2F`）：

```bash
curl -sS -X PUT \
  --header "PRIVATE-TOKEN: ${MY_WORKFLOW_GL_ACCESS_TOKEN}" \
  "https://git.myscrm.cn/api/v4/projects/<group>%2F<project>/merge_requests/<iid>/merge"
```

3. 返回 JSON 中 `state` 为 `merged` 即合并成功。
4. 若返回错误（如 405/406：流水线未通过、需要审批、存在冲突等）：不要自动重试，向用户展示 HTTP 状态与返回内容，说明可能原因，让用户介入处理；用户确认处理完毕后再重新调用本步骤。

## 步骤 5：部署 f 分支接测

1. 接测目标为步骤 3 分支状态查询返回的 `deploy_targets`（全部目标都要部署，无需让用户选择环境）。执行前向用户列出这些目标（`env_code`、`env_name`、当前 `pipeline_status`）。
2. 对每一个接测目标执行部署（`app_branch_id` 与 `env_code` 均复用步骤 3 的返回值）：

```bash
yunke-cli devops mars-branch-deploy-branch --app_branch_id <id> --env_code <目标env_code>
```

3. **将每次部署命令的完整调用结果原样打印给用户**，并附部署结果摘要；若失败，指出关键失败信息与建议的下一步。

## Report

全部完成后，用中文简要汇报：

1. 提交的 commit 信息与 push 结果。
2. 创建并已合并的 MR 链接。
3. 每个接测目标环境与对应的部署触发结果。
