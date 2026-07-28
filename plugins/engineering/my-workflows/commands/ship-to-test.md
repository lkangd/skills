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

### 3.1 查询链路（顺序执行，参数取自上一步返回）

1. **查询分支状态**（`--branch_name` 使用目标 f 分支名作为关键字）：

```bash
yunke-cli devops mars-branch-query-branch-status --branch_name <f分支名>
```

   从返回中提取 `app_branch_id`、`product_id`、当前状态。若匹配到多个候选，列出让用户选择。

2. **查询可建 MR 的仓库**：

```bash
yunke-cli devops mars-branch-query-repositories --app_branch_id <上一步返回的id>
```

   只有一个仓库时默认选择；多个仓库时让用户单选或多选。

3. **确定审核人**：
   - 审核人记忆文件为 `~/.yunke-cli/my-workflow-reviewers.json`，结构为 `{ "<origin远程地址>": { "audit_user": "...", "name": "..." } }`。该文件在工作目录之外，必须使用 Read / Write 文件工具读写，禁止用 `cat` 等 shell 命令访问；文件不存在时视为空对象 `{}`。
   - 若用户通过 `$ARGUMENTS` 指定了审核人：查询用户列表并用它匹配，能唯一匹配就直接使用，无需再选。
   - 若未指定且记忆文件中存在本项目（以 Context 中的 origin 远程地址为 key）的记录：直接使用记录的审核人。
   - 否则查询用户列表并让用户选择：

```bash
yunke-cli devops mars-branch-query-branch-users --product_id <前置返回的id> --ignore_app_members true
```

   - 最终确定的审核人写回记忆文件（不存在则创建目录和文件），供本项目下次直接使用。

### 3.2 创建 MR

执行前向用户展示：`app_branch_id`、仓库列表、审核人，用户确认后执行：

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

1. 查询可部署环境并列出，让用户选择目标测试环境的 `env_code`：

```bash
yunke-cli devops mars-branch-query-environments --product_id <步骤3返回的id>
```

2. 使用用户选定的环境执行部署（`app_branch_id` 复用步骤 3 的值）：

```bash
yunke-cli devops mars-branch-deploy-branch --app_branch_id <id> --env_code <用户选择的code>
```

3. **将部署命令的完整调用结果原样打印给用户**，并附一句部署结果摘要；若失败，指出关键失败信息与建议的下一步。

## Report

全部完成后，用中文简要汇报：

1. 提交的 commit 信息与 push 结果。
2. 创建并已合并的 MR 链接。
3. 部署的目标环境与部署触发结果。
