#!/usr/bin/env node
// ship-to-test workflow 的一体化执行脚本。
// 除「提交 commit」外的全部固定流程在这里一次跑完，agent 只在出错时介入：
//   sync   → git pull --rebase + git push
//   plan   → yunke-cli 查询链（分支状态/仓库/应用/审核人）并落状态文件
//   create → 创建 MR 并通过 GitLab API 反查 + 校验 MR 确实对应本次提交
//   merge  → 调用 GitLab API 合并 MR；合不了但本轮提交已经在 f 上的空 MR（上一轮已合并过）
//            关掉后继续走，其余合并失败一律停下
//   deploy → 确认合并已落到 f 分支后，对全部接测目标逐个部署并原样打印结果
//
// 关于「空接测」：GitLab 的 f 分支已经包含本轮合并，不代表 Mars 也看见了——Mars 接测读的是
// 它自己那份 f 分支快照，刚合并就触发会把「合并前的 f」发到测试分支。deploy 因此做两件事：
// 触发前按合并时刻补足静默期（MARS_SETTLE_MS）；触发后若在环境分支上发现本 f 分支的接测
// 合并却仍不含目标提交（stale_deploy），判定为发了旧快照并有限次重触发。
//
// 输出协议（供 agent 解析）：
//   STATUS:   OK | NEED_USER | ERROR（唯一的成败判据，缺失即未完成）
//   STEP:     出问题的步骤名
//   DETAIL:   具体原因（可能多行）
//   RESUME:   问题解决后用于断点续跑的完整命令
//   NOTE:     需要如实转告用户的信息（跳过的环境、跳过审核人不在合并人中的仓库、复用已合并 MR、跳过无分支的仓库等）
//   RESUMING / RESTART: 本次是从断点续跑还是完整重跑
//
// 用法:
//   node ship-to-test-run.js run [--audit-user <关键字或user_name>] [--from <step>]
//                                [--skip-env <env_code>] [--restart] [--dry-run]
//   node ship-to-test-run.js register-global <user_name> [<real_name>]
//
// 断点续跑：每次失败都会把中断步骤写进状态文件的 resume_from。下次不带 --from 直接
// `run` 时，只要 HEAD 没变就自动从中断步骤继续；HEAD 变了（有新提交/rebase）说明是新
// 的一轮，自动回到 sync 完整执行。--restart 强制完整重跑。
//
// 重要：yunke-cli 是 MCP 工具的 CLI 包装，业务失败时退出码仍然是 0，失败信息只出现在
// 输出的文本负载里（例如「失败仓库: ... 创建mr失败」「❌ 不支持的环境」）。因此所有动作
// 类命令都必须做文本级失败检测 + 语义校验，只看退出码会把失败当成功，并可能误把上一轮
// 的旧 MR 当成本次结果，导致接测的是旧代码。文本级判定住在 ./yunke.js（适配层），本文件
// 只消费 { ok, unsure, text, reason }；新增一种失败措辞只需要改 yunke.js 一处。
//
// 审核人记忆（~/.yunke-cli/my-workflow-reviewers.json）优先级:
//   显式 --audit-user > "*" 级（所有项目通用） > 项目级（origin 为 key） > 让用户选择
//
// 状态文件: <git目录>/ship-to-test-state.json（前置查询结果、MR 信息、中断步骤与已完成
// 的部署环境，断点续跑时原样复用，保证重试不更换参数、不重复部署）。

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// yunke-cli 的输出解析与成败判定全部收敛在适配层里（新增失败措辞只改 yunke.js）
const {
  ensureInstalled: ensureYunkeCli,
  isUnsupportedEnv,
  yunkeAction,
  yunkeJson: yunkeQuery,
} = require("./yunke.js");

const STEPS = ["sync", "plan", "create", "merge", "deploy"];
const MEMORY_FILE = path.join(os.homedir(), ".yunke-cli", "my-workflow-reviewers.json");
// Mars 用整条 commit message 作为 MR 标题，GitLab 侧上限 255 字符
const MAX_MR_TITLE = 255;
const STATE_SCHEMA_VERSION = 2;
const ENV_BRANCH_BY_CODE = Object.freeze({ yktest: "test" });
// 受支持的开发分支形式：dev-f-*（前端）与 dev-bg-*（后端），去掉 dev- 前缀即目标分支。
const DEV_BRANCH_RE = /^dev-(f|bg)-/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 记忆文件 ----------
function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8")); } catch { return {}; }
}
function saveMemory(memory) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

// ---------- 参数解析 ----------
function registerGlobal(argv) {
  const userName = argv[1];
  if (!userName) {
    console.error("用法: node ship-to-test-run.js register-global <user_name> [<real_name>]");
    return 1;
  }
  const memory = loadMemory();
  const known = Object.values(memory).find((value) => value && value.audit_user === userName);
  const realName = argv[2] || (known && known.name) || "";
  memory["*"] = { audit_user: userName, name: realName };
  saveMemory(memory);
  console.log(`已将 ${realName ? `${realName}（${userName}）` : userName} 注册为 * 级审核人（所有项目通用）`);
  return 0;
}

function parseRunOptions(argv) {
  if (argv[0] !== "run") {
    return { error: "用法: node ship-to-test-run.js run [--audit-user <关键字>] [--from <step>] [--skip-env <env_code>] [--restart] [--dry-run]\n     node ship-to-test-run.js register-global <user_name> [<real_name>]" };
  }
  const parsed = { auditUser: "", from: "", skipEnvs: [], restart: false, dryRun: false };
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === "--audit-user") parsed.auditUser = argv[++index] || "";
    else if (argv[index] === "--from") parsed.from = argv[++index] || "";
    else if (argv[index] === "--skip-env") { const value = argv[++index]; if (value) parsed.skipEnvs.push(value); }
    else if (argv[index] === "--restart") parsed.restart = true;
    else if (argv[index] === "--dry-run") parsed.dryRun = true;
  }
  if (parsed.from && !STEPS.includes(parsed.from)) {
    return { error: `--from 必须是: ${STEPS.join(" | ")}` };
  }
  return { opts: parsed };
}

let opts = { auditUser: "", from: "", skipEnvs: [], restart: false, dryRun: false };

// ---------- 全局上下文（stop 需要用它落盘中断步骤） ----------
let ENV = null;
let STATE = null;
let CURRENT_STEP = "sync";

// ---------- 输出与退出 ----------
function resumeCmd(step, extra = "") {
  const base = `node "${__filename}" run --from ${step}`;
  return extra ? `${base} ${extra}` : base;
}
// 把中断步骤写进状态文件，保证 agent 即使不带 --from 再次调用也能从断点继续
function persistResume(step) {
  if (!ENV || !step) return;
  try {
    const cur = STATE || loadState(ENV) || {};
    // 不要用更早的步骤覆盖更靠后的断点：HEAD 没变时，envCheck 阶段的失败（如 token 缺失）
    // 只是挡在门口，之前记录的 deploy 断点仍然有效，覆盖掉会导致整条流水线重跑。
    const prev = STEPS.indexOf(cur.resume_from);
    const keepLater = prev > STEPS.indexOf(step) && cur.head_sha === headSha();
    if (!keepLater) cur.resume_from = step;
    saveState(ENV, cur);
  } catch { /* 状态落盘失败不应掩盖真正的错误 */ }
}
function stop(status, step, detail, resumeStep, resumeExtra = "") {
  persistResume(resumeStep);
  console.log(`\nSTATUS: ${status}`);
  console.log(`STEP: ${step}`);
  console.log(`DETAIL: ${detail}`);
  if (resumeStep) console.log(`RESUME: ${resumeCmd(resumeStep, resumeExtra)}`);
  process.exit(status === "NEED_USER" ? 2 : 1);
}
function stepOk(step, msg) {
  console.log(`STEP ${step}: OK${msg ? ` — ${msg}` : ""}`);
}

// ---------- 基础命令封装 ----------
function sh(cmd, args, allowFail = false) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    if (allowFail) return { status: 127, stdout: "", stderr: res.error.message };
    stop("ERROR", "env", `命令执行失败: ${cmd} ${args.join(" ")}\n${res.error.message}`, "sync");
  }
  return res;
}
function git(args, allowFail = false) {
  return sh("git", args, allowFail);
}
function headSha() {
  return git(["rev-parse", "HEAD"], true).stdout.trim();
}
// 查询类命令：适配层只返回 { ok, json, reason }，这里把失败翻译成本脚本的输出协议。
function yunkeJson(args, stepName, resumeStep) {
  const out = yunkeQuery(args);
  if (!out.ok) stop("ERROR", stepName, out.reason, resumeStep);
  return out.json;
}

async function glFetch(url, method = "GET") {
  const resp = await fetch(url, {
    method,
    headers: { "PRIVATE-TOKEN": process.env.MY_WORKFLOW_GL_ACCESS_TOKEN },
  });
  let body = null;
  const text = await resp.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.status, body };
}

// ---------- 环境与仓库信息 ----------
// 分支形式校验与目标分支推导。fBranch 是历史字段名，实际含义是「目标分支」：
// dev-f-* → f-*，dev-bg-* → bg-*。
function resolveDevBranch(branch) {
  if (!DEV_BRANCH_RE.test(branch)) {
    return {
      error: `当前分支 ${branch || "(空)"} 不是 dev-f-* 或 dev-bg-* 形式，` +
        "请让用户确认应使用的 dev 分支后切换过去再继续",
    };
  }
  return { devBranch: branch, fBranch: branch.replace(/^dev-/, "") };
}

function envCheck() {
  const top = git(["rev-parse", "--show-toplevel"], true);
  if (top.status !== 0) stop("ERROR", "env", "当前目录不是 git 仓库");
  const toplevel = top.stdout.trim();
  // worktree 场景下 .git 是文件，状态文件必须放进真实的 git 目录
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const branch = git(["branch", "--show-current"]).stdout.trim();

  const resolved = resolveDevBranch(branch);

  ENV = {
    toplevel,
    gitDir,
    dirName: path.basename(toplevel),
    devBranch: branch,
    fBranch: resolved.fBranch || branch.replace(/^dev-/, ""),
    origin: git(["remote", "get-url", "origin"]).stdout.trim(),
  };

  if (resolved.error) stop("NEED_USER", "env", resolved.error, "sync");

  if (!process.env.MY_WORKFLOW_GL_ACCESS_TOKEN) {
    stop("NEED_USER", "env",
      "环境变量 MY_WORKFLOW_GL_ACCESS_TOKEN 未设置（GitLab access token，合并 MR 需要）。请让用户配置后继续",
      opts.from || "sync");
  }

  const cli = ensureYunkeCli(() => console.log("yunke-cli 未安装，尝试自动安装..."));
  if (!cli.ok) stop("NEED_USER", "env", cli.reason, opts.from || "sync");

  return ENV;
}

// ---------- 状态文件 ----------
function statePath(env) {
  return path.join(env.gitDir, "ship-to-test-state.json");
}
function loadState(env) {
  try {
    return JSON.parse(fs.readFileSync(statePath(env), "utf8"));
  } catch {
    return null;
  }
}
// schema_version 只在 normalizeRunState 的迁移入口被消费（v1 缺字段回填）；这里写入是为了
// 让下一次运行能识别状态文件的版本。
function saveState(env, state) {
  state.schema_version = STATE_SCHEMA_VERSION;
  state.run_head_sha = state.run_head_sha || state.head_sha || headSha();
  // 保留旧字段供旧版缓存脚本读取，但它与 run_head_sha 一样固定为本轮身份，不能随保存漂移。
  state.head_sha = state.run_head_sha;
  fs.writeFileSync(statePath(env), JSON.stringify(state, null, 2));
}
// 状态里两个「按轮累积」的字段统一在这里归并：本次 --skip-env 并入已有的跳过决定，
// deploy_results 保证存在。
//
// 同时把 v1 状态迁移到当前 schema：状态文件存放在本仓库的 git 目录内，所以缺失的 origin
// 只能是本仓库的 origin，回填它才能让 v1 状态参与身份比较——否则 v1 状态永远判为「另一轮」，
// 已受理但尚未落地的触发会被丢弃并在 Mars 滞后窗口里被重复触发。
// v1 的 ok / unknown 都只代表触发曾被受理（或无法判定），一律降级为待验证，绝不能当作已验证。
function normalizeRunState(state, prevSkippedEnvs = [], runOpts = opts, env = null) {
  state.schema_version = STATE_SCHEMA_VERSION;
  state.run_head_sha = state.run_head_sha || state.head_sha || null;
  state.head_sha = state.run_head_sha;
  if (!state.origin && env) state.origin = env.origin;
  state.skipped_envs = [...new Set([...prevSkippedEnvs, ...(state.skipped_envs || []), ...runOpts.skipEnvs])];
  state.skipped_repos = Array.isArray(state.skipped_repos) ? state.skipped_repos : [];
  state.closed_mrs = Array.isArray(state.closed_mrs) ? state.closed_mrs : [];
  state.deploy_results = state.deploy_results || {};
  for (const record of Object.values(state.deploy_results)) {
    if (!record) continue;
    // 旧版本写下的仓库条目没有 f_branch，补齐后续跑才认得出「接测发的是旧快照」。
    for (const repo of Object.values(record.repositories || {})) {
      repo.f_branch = repo.f_branch || state.f_branch || null;
      repo.env_branch = repo.env_branch || record.env_branch || ENV_BRANCH_BY_CODE[record.env_code] || null;
    }
    if (record.status === "ok") {
      record.status = "verifying";
      record.trigger_status = record.trigger_status || "accepted";
      record.verification_status = "pending";
    } else if (record.status === "unknown") {
      record.status = "verifying";
      record.trigger_status = record.trigger_status || "possibly_accepted";
      record.verification_status = "pending";
    }
  }
  return state;
}
// plan 之后的步骤必须有完整的查询结果才能续跑
function isPlanned(state) {
  return !!(state && state.app_branch_id && state.audit_user && Array.isArray(state.repositories) && state.repositories.length);
}

// ---------- 各步骤 ----------
// Mars 把整条 commit message 当 MR 标题（上限 255 字符），超长会在创建 MR 时报 400。
// 放在 push 之前检查：此时 amend 还是纯本地操作，代价最小。
function checkCommitTitleLength() {
  const msg = git(["log", "-1", "--pretty=%B"], true).stdout.replace(/\s+$/, "");
  if (!msg || msg.length <= MAX_MR_TITLE) return;
  const unpushed = git(["rev-list", "--count", "@{u}..HEAD"], true);
  const pushed = unpushed.status === 0 && Number(unpushed.stdout.trim()) === 0;
  stop("NEED_USER", "sync",
    `最新 commit message 共 ${msg.length} 字符，超过 Mars 创建 MR 的标题上限（${MAX_MR_TITLE} 字符），继续下去会在 create 步骤报 400。\n` +
    `请精简 commit message（保留 subject + 精简正文，总长 < ${MAX_MR_TITLE}）后续跑：\n` +
    (pushed
      ? `  该 commit 已推送到远端，git commit --amend 之后需要 git push --force-with-lease`
      : `  该 commit 尚未推送，直接 git commit --amend 即可`),
    "sync");
}

function hasUpstream() {
  return git(["rev-parse", "--abbrev-ref", "@{u}"], true).status === 0;
}

function stepSync() {
  checkCommitTitleLength();

  // 新建的 dev-f 分支可能还没有上游，此时 git pull --rebase 会以「没有跟踪信息」失败，
  // 报成冲突会误导 agent；直接建立上游即可。
  const upstream = hasUpstream();
  if (upstream) {
    // amend 改写已推送的提交后，本地提交与远端那条是同一个 patch，git pull --rebase 会把改写
    // 直接丢掉（commit message 变回旧的），流水线于是在 create 处以同样的原因永远失败。
    // git cherry 用 patch-id 比较：全是 "-" 说明本地提交在远端都已存在，必须先 force 推送。
    const cherry = git(["cherry", "@{u}", "HEAD"], true).stdout.trim();
    const cherryLines = cherry ? cherry.split("\n") : [];
    if (cherryLines.length && cherryLines.every((l) => l.startsWith("-"))) {
      stop("NEED_USER", "sync",
        `本地提交与远端已有提交内容等价（通常是 git commit --amend 改写了已推送的提交）。\n` +
        `此时 git pull --rebase 会静默丢弃这次改写（commit message 会变回旧的），因此已中止。\n` +
        `确认改写无误后执行 git push --force-with-lease，再续跑。`,
        "sync");
    }
    const pull = git(["pull", "--rebase"], true);
    if (pull.status !== 0) {
      const conflicts = git(["diff", "--name-only", "--diff-filter=U"], true).stdout.trim();
      stop("NEED_USER", "sync",
        `git pull --rebase 失败。\n冲突文件:\n${conflicts || "(无冲突文件，可能是未提交变更或网络问题)"}\n输出:\n${(pull.stderr || pull.stdout).slice(0, 1500)}\n请先自行判断能否安全解决冲突并 git rebase --continue；不能则让用户介入处理`,
        "sync");
    }
  } else {
    console.log(`NOTE: 分支 ${ENV.devBranch} 还没有上游，跳过 pull，直接 push -u 建立跟踪`);
  }

  const push = upstream
    ? git(["push"], true)
    : git(["push", "-u", "origin", ENV.devBranch], true);
  if (push.status !== 0) {
    const output = (push.stderr || push.stdout).slice(0, 1500);
    // amend 过已推送的提交时 push 会被拒；这是本脚本自己的「精简 commit message」指引之后
    // 最常见的后续失败，必须给出下一步动作，否则 agent 会卡在这里
    const nonFastForward = /non-fast-forward|rejected|fetch first|behind/i.test(output);
    stop(nonFastForward ? "NEED_USER" : "ERROR", "sync",
      `git push 失败:\n${output}` +
      (nonFastForward
        ? `\n若你刚 git commit --amend 改写了已推送的提交，需要先 git push --force-with-lease 再续跑；` +
          `否则说明远端有他人新提交，请先处理同步再续跑。`
        : ""),
      "sync");
  }
  stepOk("sync", `${upstream ? "pull --rebase + push" : "push -u"} 完成（HEAD ${headSha().slice(0, 10)}）`);
}

function resolveAuditUser(env, productId) {
  const memory = loadMemory();

  // 未指定关键字时按记忆解析：* 级（所有项目通用）优先，其次本项目记录；
  // 命中记忆时连用户列表都不用查
  if (!opts.auditUser) {
    if (memory["*"] && memory["*"].audit_user) {
      return { audit_user: memory["*"].audit_user, name: memory["*"].name, source: "global(*)" };
    }
    if (memory[env.origin] && memory[env.origin].audit_user) {
      return { audit_user: memory[env.origin].audit_user, name: memory[env.origin].name, source: "memory" };
    }
  }

  const json = yunkeJson(
    ["mars-branch-query-branch-users", "--product_id", String(productId), "--ignore_app_members", "true"],
    "plan", "plan"
  );
  const users = (json.structuredContent && json.structuredContent.items) || [];
  if (!users.length) stop("ERROR", "plan", `未查询到可选审核人（product_id: ${productId}）`, "plan");

  const compact = users.map((u) => ({ user_name: u.user_name, real_name: u.real_name, roles: u.roles }));

  if (opts.auditUser) {
    const kw = opts.auditUser.toLowerCase();
    const exact = compact.filter((u) => u.user_name.toLowerCase() === kw);
    const fuzzy = exact.length
      ? exact
      : compact.filter((u) => u.user_name.toLowerCase().includes(kw) || (u.real_name || "").includes(opts.auditUser));
    if (fuzzy.length === 1) {
      const chosen = { audit_user: fuzzy[0].user_name, name: fuzzy[0].real_name, source: "argument" };
      memory[env.origin] = { audit_user: chosen.audit_user, name: chosen.name };
      saveMemory(memory);
      // 新增审核人且尚未注册为 * 级时，标记出来让 agent 询问用户是否注册
      if (!memory["*"] || memory["*"].audit_user !== chosen.audit_user) {
        chosen.ask_register_global = { user_name: chosen.audit_user, real_name: chosen.name };
      }
      return chosen;
    }
    stop("NEED_USER", "plan",
      `审核人关键字「${opts.auditUser}」${fuzzy.length ? `匹配到 ${fuzzy.length} 个候选` : "没有匹配"}，请让用户从以下列表中选择（选择后用所选 user_name 续跑）:\n${JSON.stringify(fuzzy.length ? fuzzy : compact, null, 2)}`,
      "plan", "--audit-user <user_name>");
  }

  stop("NEED_USER", "plan",
    `本项目还没有记忆的审核人，请让用户从以下列表中选择（选择后用所选 user_name 续跑）:\n${JSON.stringify(compact, null, 2)}`,
    "plan", "--audit-user <user_name>");
}

function stepPlan(env, prevSkippedEnvs = [], prevDeployResults = {}) {
  // 1. 分支状态 → app_branch_id + 接测目标
  const statusJson = yunkeJson(["mars-branch-query-branch-status", "--branch_name", env.fBranch], "plan", "plan");
  const items = (statusJson.structuredContent && statusJson.structuredContent.items) || [];
  let pool = items.filter((i) => i.full_branch_name === env.fBranch);
  if (!pool.length) pool = items;
  const testItems = pool.filter((i) => /test/i.test(i.env_code));
  let hits = testItems.filter((i) => env.dirName.includes(i.app_name));
  if (hits.length) {
    const maxLen = Math.max(...hits.map((i) => i.app_name.length));
    hits = hits.filter((i) => i.app_name.length === maxLen);
  }
  if (!hits.length) {
    stop("NEED_USER", "plan",
      `分支 ${env.fBranch} 下没有 app_name 能被目录名「${env.dirName}」包含的接测环境条目，请让用户确认目标应用。候选应用: ${JSON.stringify([...new Set(testItems.map((i) => i.app_name))])}`,
      "plan");
  }
  const appBranchId = hits[0].app_branch_id;
  const deployTargets = hits.map((i) => ({
    env_code: i.env_code, env_name: i.env_name, pipeline_status: i.pipeline_status,
  }));

  // 2. 仓库 → repositories + service_name
  const repoJson = yunkeJson(["mars-branch-query-repositories", "--app_branch_id", String(appBranchId)], "plan", "plan");
  let repos;
  try {
    repos = JSON.parse((repoJson.content && repoJson.content[0] && repoJson.content[0].text) || "[]");
  } catch {
    stop("ERROR", "plan", "仓库列表解析失败", "plan");
  }
  if (!Array.isArray(repos) || !repos.length) {
    stop("ERROR", "plan", `应用分支 ${appBranchId} 未查询到仓库`, "plan");
  }
  const repoInfos = repos.map((url) => {
    const clean = url.replace(/\/+$/, "");
    const u = new URL(clean);
    return {
      repository: url,
      service_name: clean.split("/").pop(),
      gl_host: `${u.protocol}//${u.host}`,
      gl_project_path: u.pathname.replace(/^\//, ""),
    };
  });
  const primary = repoInfos.find((r) => env.dirName.includes(r.service_name)) || repoInfos[0];

  // 3. 应用 → product_id
  const appJson = yunkeJson(["mars-branch-query-applications", "--service_name", primary.service_name], "plan", "plan");
  const apps = (appJson.structuredContent && appJson.structuredContent.items) || [];
  const app = apps.find((a) => a.service_name === primary.service_name) || apps[0];
  if (!app) stop("ERROR", "plan", `未查询到应用（service_name: ${primary.service_name}）`, "plan");

  // 4. 审核人
  const reviewer = resolveAuditUser(env, app.product_id);

  const state = {
    schema_version: STATE_SCHEMA_VERSION,
    run_head_sha: headSha(),
    dev_branch: env.devBranch,
    f_branch: env.fBranch,
    origin: env.origin,
    app_branch_id: appBranchId,
    product_id: app.product_id,
    repositories: repoInfos,
    primary_repo: primary.gl_project_path,
    audit_user: reviewer.audit_user,
    audit_user_name: reviewer.name,
    audit_user_source: reviewer.source,
    ask_register_global: reviewer.ask_register_global || null,
    deploy_targets: deployTargets,
    // 上一轮明确决定跳过的环境（如平台侧不支持接测）继续沿用，避免每轮都卡在同一个环境
    skipped_envs: prevSkippedEnvs,
    skipped_repos: [],
    closed_mrs: [],
    // 同一轮里重跑 plan（如旧状态缺字段）时必须继承已受理的触发，否则会在 Mars 滞后窗口
    // 重复触发同一次接测。目标 SHA 变了的记录会在 stepDeploy 的指纹检查里作废。
    deploy_results: prevDeployResults,
    mrs: [],
    resume_from: null,
  };
  normalizeRunState(state);
  saveState(env, state);
  STATE = state;
  stepOk("plan", "");
  console.log("PLAN:");
  console.log(JSON.stringify(state, null, 2));
  if (state.skipped_envs.length) {
    console.log(`NOTE: 以下环境已按此前决定跳过部署（如需恢复，删除状态文件 ${statePath(env)} 后重跑）: ${state.skipped_envs.join(", ")}`);
  }
  return state;
}

function projBaseOf(repo) {
  return `${repo.gl_host}/api/v4/projects/${encodeURIComponent(repo.gl_project_path)}`;
}

function mrHeadSha(mr) {
  return mr && (mr.sha || (mr.diff_refs && mr.diff_refs.head_sha) || null);
}

function filterMrsForExpectedSha(mrs, expectedSha) {
  return (Array.isArray(mrs) ? mrs : []).filter((mr) => mrHeadSha(mr) === expectedSha);
}

// GitLab 列表接口默认分页。逐页取回并交给 onPage 判定，命中即停；返回统一的
// { hit, error, retryable } 供调用方处理，避免每个查询各自实现一套重试语义。
const GL_PAGE_SIZE = 100;
async function fetchPagedUntil(buildUrl, onPage, fetchFn = glFetch, label = "GitLab 分页查询") {
  for (let page = 1; page <= 100; page++) {
    let res;
    try {
      res = await fetchFn(buildUrl(page));
    } catch (error) {
      return { retryable: true, error: `${label}网络异常: ${error.message || error}` };
    }
    if (res.status === 404) return { hit: null, notFound: true };
    if (res.status !== 200 || !Array.isArray(res.body)) {
      return {
        retryable: res.status === 429 || res.status >= 500,
        error: `${label}失败 HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`,
      };
    }
    const hit = onPage(res.body);
    if (hit !== undefined && hit !== null) return { hit };
    if (res.body.length < GL_PAGE_SIZE) return { hit: null };
  }
  return { error: `${label}超过 100 页仍未得到结论` };
}

async function findMr(repo, state, expectedSha, wantStates = "opened") {
  const buildUrl = (page) =>
    `${projBaseOf(repo)}/merge_requests?source_branch=${encodeURIComponent(state.dev_branch)}&target_branch=${encodeURIComponent(state.f_branch)}&state=${wantStates}&order_by=created_at&sort=desc&per_page=${GL_PAGE_SIZE}&page=${page}`;
  const result = await fetchPagedUntil(
    buildUrl,
    (pageMrs) => filterMrsForExpectedSha(pageMrs, expectedSha)[0],
    glFetch,
    "GitLab 查询 MR ",
  );
  if (result.error) return { error: result.error };
  return { mrs: result.hit ? [result.hit] : [] };
}

// 本轮要送进 f 分支的提交：本地仓库直接用本地 HEAD，其余仓库回查它们各自 dev 分支的远端 tip。
// 有了它，「MR 是不是本轮的」「代码到底进没进 f」对所有仓库都用同一套判据，
// 不再出现「本地仓库严格校验、其它仓库直接信任最近一个已合并 MR」的不对称。
async function expectedShaOf(repo, state) {
  if (repo.gl_project_path === state.primary_repo && state.head_sha) {
    return { sha: state.head_sha };
  }
  const res = await glFetch(`${projBaseOf(repo)}/repository/branches/${encodeURIComponent(state.dev_branch)}`);
  if (res.status === 404) return { missing: true };
  if (res.status !== 200 || !res.body || !res.body.commit) {
    return { error: `GitLab 查询分支 ${state.dev_branch} 失败 HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}` };
  }
  return { sha: res.body.commit.id };
}

// 某个 commit 是否已经在指定分支上。GitLab refs API 默认分页，必须读完才能避免假阴性。
async function shaOnBranch(projBase, sha, branch, fetchFn = glFetch) {
  const result = await fetchPagedUntil(
    (page) => `${projBase}/repository/commits/${sha}/refs?type=branch&per_page=${GL_PAGE_SIZE}&page=${page}`,
    (refs) => refs.some((ref) => ref.name === branch) || undefined,
    fetchFn,
    "GitLab 查询 commit refs ",
  );
  if (result.error) return { on: false, retryable: result.retryable, error: result.error };
  return { on: result.hit === true };
}

function repoUrlKey(url) {
  return String(url || "").replace(/\/+$/, "");
}

function parseCreateRepoResults(text) {
  const succeeded = [];
  const failed = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const ok = line.match(/^成功仓库[：:]\s*(https?:\/\/\S+)/);
    if (ok) {
      succeeded.push(ok[1].replace(/[,;]+$/, ""));
      continue;
    }
    const fail = line.match(/^失败仓库[：:]\s*(https?:\/\/\S+?):\s*(.+)$/);
    if (fail) failed.push({ url: fail[1], reason: fail[2].trim() });
  }
  return { succeeded, failed };
}

function isReviewerMissingFailure(reason) {
  return /获取审核人Id失败|用户不存在|找不到审核人/.test(reason || "");
}

function classifyReviewerMissingRepos(failed, { primaryUrl, auditUser } = {}) {
  const skipped = [];
  const hard = [];
  const primary = repoUrlKey(primaryUrl);
  for (const item of failed || []) {
    const url = repoUrlKey(item.url);
    if (isReviewerMissingFailure(item.reason) && url && url !== primary) {
      skipped.push({
        repository: item.url,
        reason: `MR 合并人不包含已指定审核人 ${auditUser}（${item.reason}）`,
      });
    } else {
      hard.push(item);
    }
  }
  return { skipped, hard };
}

function primaryRepoUrl(state) {
  const primary = (state.repositories || []).find((repo) => repo.gl_project_path === state.primary_repo);
  return primary ? primary.repository : "";
}

function skippedRepoUrlSet(state) {
  return new Set((state.skipped_repos || []).map((item) => repoUrlKey(item.repository)));
}

function recordSkippedRepo(state, skipped, skippedUrls) {
  const repo = (state.repositories || []).find((item) => repoUrlKey(item.repository) === repoUrlKey(skipped.repository));
  const rec = {
    repository: skipped.repository,
    gl_project_path: repo ? repo.gl_project_path : skipped.repository,
    reason: skipped.reason,
  };
  const key = repoUrlKey(rec.repository);
  if (!skippedUrls.has(key)) {
    state.skipped_repos.push(rec);
    skippedUrls.add(key);
    console.log(`NOTE: 跳过仓库 ${rec.gl_project_path}：${rec.reason}`);
  }
  return rec;
}

async function stepCreate(env, state) {
  state.skipped_repos = Array.isArray(state.skipped_repos) ? state.skipped_repos : [];
  const skippedUrls = skippedRepoUrlSet(state);
  const reposToCreate = state.repositories.filter((repo) => !skippedUrls.has(repoUrlKey(repo.repository)));
  if (!reposToCreate.length) {
    stop("ERROR", "create", "没有任何可创建 MR 的仓库（均因审核人不在合并人中被跳过）", "create");
  }

  const args = ["mars-branch-create-merge-request", "--app_branch_id", String(state.app_branch_id)];
  for (const r of reposToCreate) args.push("--repositories", r.repository);
  args.push("--audit_user", state.audit_user);

  const out = yunkeAction(args);
  console.log(`create-merge-request 原始输出:\n${out.text.trim()}`);

  const classified = classifyReviewerMissingRepos(parseCreateRepoResults(out.text).failed, {
    primaryUrl: primaryRepoUrl(state),
    auditUser: state.audit_user,
  });
  for (const skipped of classified.skipped) recordSkippedRepo(state, skipped, skippedUrls);

  // 先做文本级失败检测：yunke-cli 创建 MR 失败时退出码依然是 0。
  // 附属仓库「审核人不在合并人中」只跳过该仓库，不能把整次 create 判失败。
  if (classified.hard.length || (!out.ok && !out.unsure && !classified.skipped.length)) {
    const tooLong = /255|过长/.test(out.text);
    const hint = tooLong
      ? `\n看起来是 MR 标题超长：Mars 用整条 commit message 作为标题，上限 ${MAX_MR_TITLE} 字符。请 git commit --amend 精简后续跑（RESUME 已指向 sync，因为改写后的提交需要重新推送；提交已推送过时 push 需要 --force-with-lease）。`
      : "\n若为权限不足，提示用户联系 SM 或系统管理员开通 Mars 权限；重试必须原样复用状态文件中的参数。";
    // 标题超长只能靠改写提交解决，改写后必须重新推送，所以断点回到 sync 而不是 create
    stop("ERROR", "create", `创建 MR 失败。${out.reason}${hint}`, tooLong ? "sync" : "create");
  }

  // 再做语义校验：命令说成功不代表 MR 真的建出来了，必须在 GitLab 侧看到对应本轮提交的 MR。
  const mrs = [];
  for (const repo of state.repositories) {
    if (skippedUrls.has(repoUrlKey(repo.repository))) continue;
    const projBase = projBaseOf(repo);
    const expected = await expectedShaOf(repo, state);
    if (expected.error) stop("ERROR", "create", expected.error, "create");
    if (expected.missing) {
      console.log(`NOTE: ${repo.gl_project_path} 上不存在分支 ${state.dev_branch}，该仓库本轮没有要合并的内容，跳过`);
      continue;
    }

    const found = await findMr(repo, state, expected.sha, "opened");
    if (found.error) stop("ERROR", "create", found.error, "create");
    let mr = found.mrs[0];

    if (!mr) {
      // 没有待合并 MR 时，只有「本轮提交已经在 f 分支上」才说明是上一轮已经合并过
      // （或该仓库本轮无差异）。否则就是本次创建没生效——绝不能退回去捡上一轮的旧 MR，
      // 那会把旧代码当成本次结果接测。
      const landed = await shaOnBranch(projBase, expected.sha, state.f_branch);
      if (landed.error) stop("ERROR", "create", landed.error, "create");
      if (!landed.on) {
        stop("ERROR", "create",
          `创建 MR 未生效：${repo.gl_project_path} 中找不到 ${state.dev_branch} → ${state.f_branch} 的待合并 MR，` +
          `且本轮提交 ${expected.sha.slice(0, 10)} 也不在 ${state.f_branch} 分支上。\n` +
          `请阅读上方 create 原始输出定位原因（常见：MR 标题超长 / 权限不足 / 分支无差异），修复后续跑；` +
          `不要跳过 create 直接 merge 或 deploy，否则接测的会是旧代码。${out.unsure ? `\n（另注：${out.reason}）` : ""}`,
          "create");
      }
      // 已合并场景：取最近一个 merged MR 作为记录；取不到就只靠 expected_sha 确认落地
      const mergedFound = await findMr(repo, state, expected.sha, "merged");
      if (mergedFound.error) stop("ERROR", "create", mergedFound.error, "create");
      mr = mergedFound.mrs[0];
      if (!mr) {
        console.log(`NOTE: ${repo.gl_project_path} 未找到 MR 记录，但本轮提交已在 ${state.f_branch} 上，按已合并处理`);
        mrs.push({
          gl_host: repo.gl_host, gl_project_path: repo.gl_project_path,
          iid: null, web_url: null, state: "merged",
          expected_sha: expected.sha, mr_head_sha: expected.sha,
          merge_commit_sha: null, squash_commit_sha: null, merged_sha: expected.sha,
          // 这里唯一被证明的事实就是「本轮提交已经在目标分支上」，没有目标侧 merge/squash
          // 可用。用同一个标记，让 deploy 前的落地确认走包含判定，而不是要求 f 的 tip
          // 恰好等于它（上一轮合并过之后 tip 必然已经前进，那个判据永远不成立）。
          already_on_target: true,
        });
        continue;
      }
      console.log(`NOTE: ${repo.gl_project_path} 本轮提交已在 ${state.f_branch} 上，复用已合并的 MR !${mr.iid}`);
    }

    mrs.push({
      gl_host: repo.gl_host,
      gl_project_path: repo.gl_project_path,
      iid: mr.iid,
      web_url: mr.web_url,
      state: mr.state,
      expected_sha: expected.sha,
      mr_head_sha: mrHeadSha(mr),
      merge_commit_sha: mr.merge_commit_sha || null,
      squash_commit_sha: mr.squash_commit_sha || null,
      merged_sha: mr.merge_commit_sha || mr.squash_commit_sha || null,
    });
  }
  if (!mrs.length) {
    const skipped = (state.skipped_repos || []).map((repo) => repo.gl_project_path).join(", ");
    stop("ERROR", "create",
      `没有任何仓库产生可合并的 MR（全部仓库都没有 ${state.dev_branch} 分支` +
      `${skipped ? `；另有仓库因审核人不在合并人中被跳过: ${skipped}` : ""}）。请确认分支与应用配置后续跑`,
      "create");
  }

  if (out.unsure) {
    console.log(`NOTE: create 输出无法自动判定成败，但 GitLab 侧已确认到对应 MR，继续执行。原始判定信息: ${out.reason.slice(0, 300)}`);
  }
  state.mrs = mrs;
  saveState(env, state);
  stepOk("create", state.mrs.map((m) => `${m.web_url || "(无 MR 记录)"} (${m.state})`).join(", "));
}

// head 一致性校验 + 目标侧 SHA 字段归并的唯一实现。keepState 用于「只刷新字段、状态以
// GitLab 返回为准」的回查场景；默认把 MR 标记为已合并。
function applyMergedMrInfo(mr, body, { keepState = false } = {}) {
  const mergedHead = mrHeadSha(body);
  if (mergedHead && mr.expected_sha && mergedHead !== mr.expected_sha) {
    return { error: `GitLab 返回的 MR !${mr.iid} head ${mergedHead} 与本轮期望 ${mr.expected_sha} 不一致` };
  }
  mr.state = keepState ? (body.state || mr.state) : "merged";
  mr.mr_head_sha = mergedHead || mr.mr_head_sha;
  // 合并时刻用于计算「Mars 还需要多久才可能看见这次合并」的静默期
  mr.merged_at = body.merged_at || mr.merged_at || null;
  mr.merge_commit_sha = body.merge_commit_sha || mr.merge_commit_sha || null;
  mr.squash_commit_sha = body.squash_commit_sha || mr.squash_commit_sha || null;
  mr.merged_sha = mr.merge_commit_sha || mr.squash_commit_sha || body.sha || mr.merged_sha || null;
  return { ok: true };
}

// 「本轮内容已经在 f 分支上」的两种形态：正常合并完成，或者本轮的 MR 里其实没有可合并的
// 内容、已被关闭。两者都可以往下走 deploy，其它状态都不行。
function isSettledMr(mr) {
  return mr.state === "merged" || mr.already_on_target === true;
}

// 上一轮已经把同样的提交合进 f 时，这一轮建出来的 MR 里没有任何可合并的内容，GitLab 会拒绝
// 合并（detailed_merge_status: commits_status）。这种空 MR 关掉继续走即可——但前提是先证明
// 「本轮提交确实已经在目标分支上」。证明不了就不是空 MR，而是真的合不了，必须报错停下。
async function closeMrWithNothingToMerge(state, mr, latestBody, fetchFn = glFetch) {
  const projBase = projBaseOf(mr);

  // 「提交在 f 上 ⇒ MR 是空的」只有在 MR 头还是本轮那个提交时才成立。有人往同一 dev 分支
  // 又推了提交时，MR 里装着还没合并的东西，关掉它等于把别人的改动悄悄丢掉。
  // 读不到当前 head 就证明不了，一律不关（fail closed）。
  const head = mrHeadSha(latestBody);
  if (head !== mr.expected_sha) {
    return { empty: false, head_moved: head || null };
  }

  const landed = await shaOnBranch(projBase, mr.expected_sha, state.f_branch, fetchFn);
  if (landed.error) return { error: landed.error };
  if (!landed.on) return { empty: false };

  // 本轮提交已经在目标分支上 ⇒ 源分支到它为止的内容全部都在，MR 确实是空的。
  // target_sha 仍然留给 deploy 前的落地确认去解析，保证「要接测的提交」只有那一个出处。
  mr.already_on_target = true;
  mr.closed_reason = `本轮提交 ${String(mr.expected_sha).slice(0, 10)} 已经在 ${state.f_branch} 上（上一轮已合并），该 MR 没有可合并的内容`;

  const res = await fetchFn(`${projBase}/merge_requests/${mr.iid}?state_event=close`, "PUT");
  if (res.status === 200 && res.body && res.body.state === "closed") {
    mr.state = "closed";
    mr.close_error = null;
  } else {
    // 关不掉不影响「代码已经在 f 上」这个事实，流程继续，但必须如实上报。
    mr.close_error = `关闭 MR !${mr.iid} 失败 HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`;
  }
  return { empty: true, closed: !mr.close_error };
}

function recordClosedMr(state, mr) {
  state.closed_mrs = Array.isArray(state.closed_mrs) ? state.closed_mrs : [];
  const key = `${mr.gl_project_path}#${mr.iid}`;
  if (state.closed_mrs.some((item) => `${item.gl_project_path}#${item.iid}` === key)) return;
  state.closed_mrs.push({
    gl_project_path: mr.gl_project_path,
    iid: mr.iid,
    web_url: mr.web_url,
    expected_sha: mr.expected_sha,
    reason: mr.closed_reason,
    close_error: mr.close_error || null,
  });
}

async function stepMerge(env, state) {
  if (!state.mrs.length) {
    stop("ERROR", "merge", "状态文件中没有 MR 记录，无法合并，请从 create 步骤重跑", "create");
  }
  for (const mr of state.mrs) {
    if (isSettledMr(mr)) continue;
    const base = `${projBaseOf(mr)}/merge_requests/${mr.iid}`;

    // 等待 GitLab 完成可合并性检查；若上次 PUT 已成功但脚本未落盘，先对账再决定是否发送 PUT。
    let reconciled = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const info = await glFetch(base);
      if (info.status !== 200) break;
      if (info.body && info.body.state === "merged") {
        const applied = applyMergedMrInfo(mr, info.body);
        if (applied.error) stop("ERROR", "merge", `${applied.error}，已停止，不能继续部署旧 MR`, "create");
        saveState(env, state);
        reconciled = true;
        break;
      }
      const mergeStatus = info.body.detailed_merge_status || info.body.merge_status;
      if (!["checking", "unchecked", "preparing"].includes(mergeStatus)) break;
      await sleep(3000);
    }
    if (reconciled) continue;

    const res = await glFetch(`${base}/merge`, "PUT");
    if (res.status === 200 && res.body && res.body.state === "merged") {
      const applied = applyMergedMrInfo(mr, res.body);
      if (applied.error) stop("ERROR", "merge", `${applied.error}，已停止，不能继续部署旧 MR`, "create");
      saveState(env, state);
      continue;
    }

    // PUT 响应可能丢失或滞后；失败前再 GET 一次，避免已经合并却永久卡在 merge。
    const after = await glFetch(base);
    if (after.status === 200 && after.body && after.body.state === "merged") {
      const applied = applyMergedMrInfo(mr, after.body);
      if (applied.error) stop("ERROR", "merge", `${applied.error}，已停止，不能继续部署旧 MR`, "create");
      saveState(env, state);
      continue;
    }

    // 「MR 建出来了却合不了」最常见的原因是这次要合的内容上一轮已经进了 f。
    // 判据要用刚刚取回的 MR 实况（after.body），而不是 create 时的旧认知。
    const emptied = await closeMrWithNothingToMerge(state, mr, after.body);
    if (emptied.error) {
      stop("ERROR", "merge", `判断 ${mr.web_url} 是否为空 MR 时 ${emptied.error}`, "merge");
    }
    if (emptied.empty) {
      recordClosedMr(state, mr);
      saveState(env, state);
      console.log(`NOTE: ${mr.web_url} 无可合并内容（${mr.closed_reason}）` +
        (mr.close_error ? `，关闭失败：${mr.close_error}；` : `，已关闭该 MR；`) +
        `本轮内容已在 ${state.f_branch} 上，继续后续流程`);
      continue;
    }

    stop("ERROR", "merge",
      `合并 ${mr.web_url} 失败 HTTP ${res.status}（常见原因: 流水线未通过/需要审批/存在冲突）。` +
      (emptied.head_moved
        ? `另注：该 MR 当前 head 是 ${emptied.head_moved.slice(0, 10)}，已经不是本轮提交 ` +
          `${String(mr.expected_sha).slice(0, 10)}（dev 分支上有本轮之外的新提交），因此不能按「空 MR」关闭；` +
          `请先确认这些提交是否也要一起接测。`
        : emptied.head_moved === null
          ? `另注：这次没能读到该 MR 的当前 head，无法证明它是「空 MR」，因此没有关闭它。`
          : `已确认本轮提交 ${String(mr.expected_sha).slice(0, 10)} 还不在 ${state.f_branch} 上，所以不是「无内容可合并的空 MR」。`) +
      `\n${JSON.stringify(res.body).slice(0, 1200)}\n请向用户说明并等待处理，处理完后续跑`,
      "merge");
  }
  stepOk("merge", state.mrs.map((m) => `${m.web_url || m.merged_sha}${m.already_on_target ? "(closed:空 MR)" : ""}`).join(", "));
}

// GitLab 的 merge API 返回 merged 只代表受理。部署前先解析真正落到 f 的目标侧 SHA，
// 部署后再确认该 SHA 已进入测试分支；yunke 的“成功”文本只代表触发被接受。
const LAND_POLL_TRIES = 20;
const LAND_POLL_INTERVAL_MS = 3000;
const VERIFY_POLL_TRIES = 61;
const VERIFY_POLL_INTERVAL_MS = 10000;
// 「目标侧 SHA 已在 GitLab 的 f 分支上」并不代表 Mars 也看见了：Mars 接测读的是它自己那份
// f 分支快照，MR 刚合并就触发会把「合并前的 f」发到测试分支（空接测）。两道防线：
//   1) 合并落地后先补足静默期再触发，让 Mars 有时间刷新（不够也不会误判，只是概率问题）；
//   2) 真的发生了就检测出来并重新触发——这是唯一能救回来的动作，光继续等永远等不到。
// 写错环境变量不能把静默期悄悄关掉（NaN 会让 sleep 立即返回），非法值一律回落到默认值。
const MARS_SETTLE_MS = Number.isFinite(Number(process.env.SHIP_TO_TEST_MARS_SETTLE_MS))
  ? Number(process.env.SHIP_TO_TEST_MARS_SETTLE_MS)
  : 30000;
const MAX_TRIGGER_ATTEMPTS = 3;
const RETRIGGER_BACKOFF_MS = 60000;
// 目标 SHA 指纹变化时，「旧触发可能还在跑，先别重复触发」这个假设只在同一次运行内重新
// 解析目标（如合并侧 SHA 换了一种取法）时成立——那次触发确实是几秒前才发出去的。
// 如果是进程被杀死、resume_from 没能落盘导致整条流水线从 sync 重新跑一遍（用户在
// 2026-08-24 复现过），旧触发可能是几个小时前的，早已经跟当前目标无关；继续把它当成
// 「还在跑」只会验证一个根本没人重新触发过的目标，白等一整个轮询窗口。
const FINGERPRINT_CARRY_MAX_MS = 20 * 60 * 1000;

function targetShaCandidates(mr) {
  // 空 MR 被关闭的场景：本轮提交本身就已经在目标分支上，它就是要在测试分支上验证的提交。
  if (mr.already_on_target && mr.expected_sha) {
    return [{ sha: mr.expected_sha, kind: "already_on_target" }];
  }
  const targetSide = [
    { sha: mr.merge_commit_sha, kind: "merge_commit" },
    { sha: mr.squash_commit_sha, kind: "squash_commit" },
    { sha: mr.merged_sha !== mr.expected_sha ? mr.merged_sha : null, kind: "legacy_merged" },
  ].filter((candidate) => candidate.sha);
  const candidates = targetSide.length ? targetSide : [{ sha: mr.expected_sha, kind: "source_fast_forward" }];
  return candidates
    .filter((candidate) => candidate.sha)
    .filter((candidate, index) => candidates.findIndex((item) => item.sha === candidate.sha) === index);
}

async function resolveTargetShaOnBranch(mr, branch, checkFn = shaOnBranch, tipFn = getBranchTip) {
  const projBase = projBaseOf(mr);
  for (const candidate of targetShaCandidates(mr)) {
    if (candidate.kind === "source_fast_forward") {
      const tip = await tipFn(projBase, branch);
      if (tip.error) return { error: tip.error, retryable: tip.retryable };
      // source commit 作为祖先位于 f 并不能证明是 fast-forward；只有分支 tip 本身等于它才成立。
      if (tip.sha === candidate.sha) return { sha: candidate.sha, kind: candidate.kind };
      continue;
    }
    const result = await checkFn(projBase, candidate.sha, branch);
    if (result.error) return { error: result.error, retryable: result.retryable };
    if (result.on) return { sha: candidate.sha, kind: candidate.kind };
  }
  return { missing: true };
}

async function refreshMergedMr(mr) {
  if (!mr.iid) return { ok: true };
  let info;
  try {
    info = await glFetch(`${projBaseOf(mr)}/merge_requests/${mr.iid}`);
  } catch (error) {
    return { retryable: true, error: `GitLab 回查 MR !${mr.iid} 网络异常: ${error.message || error}` };
  }
  if (info.status !== 200 || !info.body) {
    return {
      retryable: info.status === 429 || info.status >= 500,
      error: `GitLab 回查 MR !${mr.iid} 失败 HTTP ${info.status}: ${JSON.stringify(info.body).slice(0, 500)}`,
    };
  }
  return applyMergedMrInfo(mr, info.body, { keepState: true });
}

async function prepareDeploymentTargets(env, state) {
  if (!Array.isArray(state.mrs) || !state.mrs.length) {
    stop("ERROR", "deploy", "状态文件中没有本轮 MR 记录，不能验证要进入测试分支的目标提交", "create");
  }
  for (const mr of state.mrs) {
    if (!isSettledMr(mr)) {
      stop("ERROR", "deploy", `${mr.web_url} 仍未合并（state: ${mr.state}），不能部署，请先完成 merge 步骤`, "merge");
    }

    let resolved = null;
    let lastRetryableError = "";
    for (let attempt = 1; attempt <= LAND_POLL_TRIES; attempt++) {
      const refreshed = await refreshMergedMr(mr);
      if (refreshed.error) {
        if (!refreshed.retryable) stop("ERROR", "deploy", refreshed.error, "deploy");
        lastRetryableError = refreshed.error;
      } else {
        resolved = await resolveTargetShaOnBranch(mr, state.f_branch);
        if (resolved.error && !resolved.retryable) stop("ERROR", "deploy", `确认合并落地时 ${resolved.error}`, "deploy");
        if (resolved.error) lastRetryableError = resolved.error;
        if (resolved.sha) {
          mr.target_sha = resolved.sha;
          mr.target_sha_kind = resolved.kind;
          // 静默期的兜底基准：GitLab 没给 merged_at 时，用「确认落地」这一刻代替，
          // 免得每个环境都按「刚刚合并」重新等满一次。
          mr.landed_confirmed_at = mr.landed_confirmed_at || new Date().toISOString();
          console.log(`合并落地确认: ${mr.gl_project_path} 的 ${state.f_branch} 已包含目标侧提交 ${resolved.sha.slice(0, 10)}（${resolved.kind}，第 ${attempt} 次检查）`);
          break;
        }
      }
      if (attempt < LAND_POLL_TRIES) await sleep(LAND_POLL_INTERVAL_MS);
    }

    if (!mr.target_sha) {
      stop("ERROR", "deploy",
        `等待约 ${(LAND_POLL_TRIES * LAND_POLL_INTERVAL_MS) / 1000} 秒后，无法确认 ${mr.gl_project_path} 本轮 MR 的目标侧提交已进入 ${state.f_branch}。` +
        `候选: ${targetShaCandidates(mr).map((candidate) => `${candidate.kind}:${candidate.sha}`).join(", ") || "无"}。` +
        `${lastRetryableError ? `最后一次临时错误: ${lastRetryableError}。` : ""}为避免接测旧代码已中止`,
        "deploy");
    }
    saveState(env, state);
  }
}

async function getBranchTip(projBase, branch, fetchFn = glFetch) {
  let result;
  try {
    result = await fetchFn(`${projBase}/repository/branches/${encodeURIComponent(branch)}`);
  } catch (error) {
    return { retryable: true, error: `GitLab 查询分支 ${branch} 网络异常: ${error.message || error}` };
  }
  if (result.status === 404) return { sha: null };
  if (result.status !== 200 || !result.body || !result.body.commit) {
    return {
      retryable: result.status === 429 || result.status >= 500,
      error: `GitLab 查询分支 ${branch} 失败 HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`,
    };
  }
  return { sha: result.body.commit.id };
}

// Mars 接测把 f 分支合进环境分支时，会先建一个 temp-<f分支当时的SHA前缀>-<f分支>-<环境分支>
// 的中转分支，并把它原样写进合并提交标题。分支名整体匹配（后面必须紧跟 -<环境分支>'），
// 否则 f-...-2 会被 f-...-22 的接测提交误判成自己的。
function marsDeployMergePattern(fBranch, envBranch) {
  const esc = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Merge branch '(temp-([0-9a-f]{6,40})-${esc(fBranch)}-${esc(envBranch)})' into '${esc(envBranch)}'`);
}

function matchMarsDeployMerge(title, pattern) {
  const matched = pattern.exec(String(title || "").split(/\r?\n/)[0].trim());
  return matched ? { temp_branch: matched[1], source_sha: matched[2] } : null;
}

function parseMarsDeployMerge(title, fBranch, envBranch) {
  return matchMarsDeployMerge(title, marsDeployMergePattern(fBranch, envBranch));
}

// 基线 SHA 之后进入环境分支的提交。用 compare 而不是按时间筛：不受时钟偏差影响，也不会
// 把本分支上一轮的接测提交算进来。
async function commitsSinceBaseline(projBase, fromSha, toBranch, fetchFn = glFetch) {
  let result;
  try {
    result = await fetchFn(`${projBase}/repository/compare?from=${encodeURIComponent(fromSha)}&to=${encodeURIComponent(toBranch)}`);
  } catch (error) {
    return { retryable: true, error: `GitLab 对比 ${fromSha} → ${toBranch} 网络异常: ${error.message || error}` };
  }
  if (result.status !== 200 || !result.body || !Array.isArray(result.body.commits)) {
    return {
      retryable: result.status === 429 || result.status >= 500,
      error: `GitLab 对比 ${fromSha} → ${toBranch} 失败 HTTP ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`,
    };
  }
  return { commits: result.body.commits };
}

// 「本轮基线之后，环境分支上出现了属于本 f 分支的接测合并，但目标提交仍不在分支上」
// ＝ 这次接测确实跑完了，只是 Mars 用的是合并前的旧快照。继续等待永远等不到，必须重触发。
async function findStaleDeploy(repository, branchSha, fetchFn = glFetch) {
  if (!repository.baseline_branch_sha || !repository.f_branch) return {};
  // 分支自基线以来没动过就没有新提交可查，省掉每 10 秒一次的 compare 请求。
  if (branchSha && branchSha === repository.baseline_branch_sha) return {};
  const compared = await commitsSinceBaseline(
    repository.proj_base, repository.baseline_branch_sha, repository.env_branch, fetchFn);
  if (compared.error) return { error: compared.error };
  const pattern = marsDeployMergePattern(repository.f_branch, repository.env_branch);
  for (const commit of compared.commits) {
    const parsed = matchMarsDeployMerge(commit.title || commit.message, pattern);
    if (parsed) return { stale: { deploy_commit: commit.id, ...parsed } };
  }
  return {};
}

async function checkRepositoryDeployment(repository, fetchFn = glFetch) {
  const [tip, landed] = await Promise.all([
    getBranchTip(repository.proj_base, repository.env_branch, fetchFn),
    shaOnBranch(repository.proj_base, repository.target_sha, repository.env_branch, fetchFn),
  ]);
  const observed = {
    on: landed.on === true,
    branch_sha: tip.sha || null,
    error: tip.error || landed.error || null,
  };
  // 只有「目标不在分支上」才需要区分「还没发过来」和「发过来的是旧快照」。
  // 记录基线时 repository 还没有 baseline_branch_sha，findStaleDeploy 会直接返回，不产生额外请求。
  if (observed.on || observed.error) return observed;
  const stale = await findStaleDeploy(repository, observed.branch_sha, fetchFn);
  if (stale.stale) observed.stale = stale.stale;
  // 旧快照检测只是诊断，失败不应该让整轮验证报错，但要留痕。
  else if (stale.error) observed.stale_error = stale.error;
  return observed;
}

// 指纹用于判断「已保存的验证结果是否仍对应本轮目标」。两个入口必须产出逐字节一致的字符串，
// 因此行格式与序列化只有这一处定义。
function buildTargetFingerprint(rows) {
  if (!rows.length) return null;
  return rows.map((row) => `${row.proj_base}|${row.env_branch}|${row.target_sha}`).sort().join("\n");
}

function deploymentTargetFingerprint(state, envBranch) {
  return buildTargetFingerprint(state.mrs.map((mr) => ({
    proj_base: projBaseOf(mr),
    env_branch: envBranch,
    target_sha: mr.target_sha,
  })));
}

function recordTargetFingerprint(record) {
  return buildTargetFingerprint(Object.values((record && record.repositories) || {}));
}

async function captureDeploymentBaseline(state, envBranch, checkFn = checkRepositoryDeployment) {
  const repositories = {};
  for (const mr of state.mrs) {
    const repository = {
      repository_id: `${mr.gl_host}::${mr.gl_project_path}`,
      gl_host: mr.gl_host,
      project_path: mr.gl_project_path,
      proj_base: projBaseOf(mr),
      env_branch: envBranch,
      // 旧快照检测要用它还原 Mars 的中转分支名
      f_branch: state.f_branch,
      target_sha: mr.target_sha,
    };
    const observed = await checkFn(repository);
    if (observed.error) return { error: observed.error };
    repositories[repository.repository_id] = {
      ...repository,
      baseline_branch_sha: observed.branch_sha,
      target_present_before: observed.on,
      observed_branch_sha: observed.branch_sha,
      verified_at: null,
      last_error: null,
    };
  }
  return { repositories, all_present: Object.values(repositories).every((repo) => repo.target_present_before) };
}

async function pollDeploymentVerification(record, options = {}) {
  const checkFn = options.checkFn || checkRepositoryDeployment;
  const sleepFn = options.sleepFn || sleep;
  const nowFn = options.nowFn || (() => new Date().toISOString());
  const maxTries = options.maxTries || VERIFY_POLL_TRIES;
  const intervalMs = options.intervalMs === undefined ? VERIFY_POLL_INTERVAL_MS : options.intervalMs;
  const onProgress = options.onProgress || (() => {});
  const repositories = Object.values(record.repositories || {});

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const observations = await Promise.all(repositories.map((repo) => checkFn(repo)));
    let allPresent = repositories.length > 0;
    const staleDeploys = [];
    for (let index = 0; index < repositories.length; index++) {
      const repo = repositories[index];
      const observed = observations[index];
      repo.observed_branch_sha = observed.branch_sha || repo.observed_branch_sha || null;
      repo.last_error = observed.error || observed.stale_error || null;
      if (observed.on) repo.verified_at = repo.verified_at || nowFn();
      else {
        allPresent = false;
        if (observed.stale) {
          repo.stale_deploy = { ...observed.stale, project_path: repo.project_path, detected_at: nowFn() };
          staleDeploys.push(repo.stale_deploy);
        }
      }
    }
    record.verification_attempts = attempt;
    record.last_checked_at = nowFn();
    if (allPresent) {
      record.status = "verified";
      record.verification_status = "verified";
      record.verification_mode = Object.values(record.repositories).every((repo) => repo.target_present_before)
        ? "already_present"
        : "observed_after_trigger";
      record.verified_at = nowFn();
      await onProgress(record);
      return { verified: true };
    }
    if (staleDeploys.length) {
      // 已经证实这次接测发出去的是合并前的旧提交，再等下去不会有结果，交回上层重触发。
      record.status = "stale_deploy";
      record.verification_status = "stale_deploy";
      await onProgress(record);
      return { verified: false, stale: staleDeploys };
    }
    record.status = "verifying";
    record.verification_status = "pending";
    await onProgress(record);
    if (attempt < maxTries) await sleepFn(intervalMs);
  }
  return { verified: false };
}

function verificationTimeoutDetail(record) {
  return Object.values(record.repositories || {}).map((repo) =>
    `${repo.project_path}: target=${repo.target_sha}, baseline=${repo.baseline_branch_sha || "(无)"}, ` +
    `last=${repo.observed_branch_sha || "(无)"}${repo.last_error ? `, error=${repo.last_error}` : ""}`
  ).join("; ");
}

function staleDeployDetail(record) {
  return (record.stale_deploys || []).map((stale) =>
    `第 ${stale.attempt} 次接测把 f 分支的 ${stale.source_sha} 发到了 ${record.env_branch}（合并提交 ${String(stale.deploy_commit).slice(0, 10)}）`
  ).join("; ");
}

// Mars 的接测读的是它自己那份 f 分支快照，MR 刚合并就触发大概率发出「合并前」的代码。
// 按合并时刻补足静默期（续跑时通常已经过去，等于不等），把无效接测挡在发生之前。
async function waitForMarsToSeeMerge(state, sleepFn = sleep, nowFn = Date.now) {
  // 本轮没有新合并（MR 都是上一轮就合过的空 MR）时，Mars 早就看见了，不需要静默期。
  const freshlyMerged = (state.mrs || []).filter((mr) => !mr.already_on_target);
  if (!freshlyMerged.length) return 0;
  const mergedAt = freshlyMerged
    .map((mr) => Date.parse(mr.merged_at || mr.landed_confirmed_at || ""))
    .filter((time) => Number.isFinite(time));
  // 连落地确认时刻都没有时按「刚刚合并」处理：宁可多等，也不要再发一次旧代码。
  const newest = mergedAt.length ? Math.max(...mergedAt) : nowFn();
  const remain = MARS_SETTLE_MS - (nowFn() - newest);
  if (remain <= 0) return 0;
  console.log(`合并落地后再等 ${Math.ceil(remain / 1000)} 秒触发接测，避免 Mars 仍用合并前的 f 分支快照`);
  await sleepFn(remain);
  return remain;
}

function printDeployOutput(target, out) {
  console.log(`\n===== 触发 ${target.env_code}（${target.env_name}）接测的完整输出 =====`);
  console.log(out.text.trim());
  if (out.res.stderr && out.res.stderr.trim()) console.log(`stderr: ${out.res.stderr.trim().slice(0, 1000)}`);
}

// 调用接测命令的唯一入口：两个分支共用同一套 argv、输出打印与 unsupported 判定，
// 避免有映射/无映射两条路径对同一平台响应给出不同结论。
function triggerDeploy(state, target) {
  const out = yunkeAction(["mars-branch-deploy-branch", "--app_branch_id", String(state.app_branch_id), "--env_code", target.env_code]);
  printDeployOutput(target, out);
  return {
    out,
    accepted: out.ok,
    possiblyAccepted: !out.ok && out.unsure,
    unsupported: !out.ok && isUnsupportedEnv(out.text),
  };
}

// record 的字段形状只在这里定义一次，三个写入点都从它出发。
function newDeployRecord(target, envBranch, overrides = {}) {
  return {
    env_code: target.env_code,
    env_name: target.env_name,
    env_branch: envBranch,
    status: "triggering",
    trigger_status: "pending",
    verification_status: "pending",
    verification_mode: null,
    target_fingerprint: null,
    repositories: {},
    trigger_attempts: 0,
    stale_deploys: [],
    reason: "",
    ...overrides,
  };
}

function deploymentActionFor(record) {
  if (!record) return "trigger";
  if (record.status === "verified") return "skip";
  // 已证实上一次接测发的是合并前的旧快照：重触发是唯一出路，不能只继续验证。
  // triggering 表示重触发还没确认被受理（进程死在触发中途）。此时重取的基线已经把那次
  // 旧快照合并排除在检测之外，只验证就永远等不到目标提交，所以旧快照的证明必须压过它。
  if (record.status === "stale_deploy" ||
    (record.status === "triggering" && (record.stale_deploys || []).length)) return "trigger";
  if (["triggering", "verifying"].includes(record.status)) return "verify";
  // 平台已明确「不支持该环境接测」时重试永远不会成功，只能由用户决定跳过。
  if (record.unsupported) return "blocked";
  return "trigger";
}

// 恢复续跑：沿用同一次触发，只补齐验证需要的字段，绝不再调用接测命令。
async function resumeVerification(env, state, target, envBranch, record, deps) {
  record.env_branch = envBranch;
  if (!record.repositories || !Object.keys(record.repositories).length) {
    const baseline = await deps.baselineFn(state, envBranch);
    if (baseline.error) stop("ERROR", "deploy", `恢复 ${target.env_code} 内容验证失败: ${baseline.error}`, "deploy");
    record.repositories = baseline.repositories;
    record.target_fingerprint = deploymentTargetFingerprint(state, envBranch);
    // 旧状态发生在触发之后，此时看到目标 SHA 不能归因到新的触发前基线。
    for (const repo of Object.values(record.repositories)) repo.target_present_before = null;
  }
  if (record.status === "triggering") {
    record.status = "verifying";
    record.trigger_status = record.trigger_status === "pending" ? "possibly_accepted" : record.trigger_status;
  }
  saveState(env, state);
  console.log(`\n===== 继续验证 ${target.env_code}（${target.env_name}），不会重复触发接测 =====`);
  return record;
}

// 触发一次接测：等待（首次是 Mars 静默期，重触发是退避）→ 取基线 → 调用接测命令。
// 返回的 record 已经落盘，status 说明还要不要继续验证。
async function triggerOnce(env, state, target, envBranch, record, deps) {
  const attempts = (record && record.trigger_attempts) || 0;
  const staleDeploys = (record && record.stale_deploys) || [];

  if (attempts > 0) {
    console.log(`\n===== 重新触发 ${target.env_code}（${target.env_name}）第 ${attempts + 1} 次：上一次接测发的是合并前的旧提交 =====`);
    console.log(`先等待 ${Math.round(RETRIGGER_BACKOFF_MS / 1000)} 秒，让 Mars 侧的 f 分支快照追上本轮合并`);
    await deps.sleepFn(RETRIGGER_BACKOFF_MS);
  } else {
    await waitForMarsToSeeMerge(state, deps.sleepFn);
  }

  // 退避/静默期内目标可能已经自己进来了，所以基线必须在等待之后取。
  const baseline = await deps.baselineFn(state, envBranch);
  if (baseline.error) {
    stop("ERROR", "deploy", `记录 ${target.env_code} 部署前基线失败: ${baseline.error}`, "deploy");
  }
  record = newDeployRecord(target, envBranch, {
    status: baseline.all_present ? "verified" : "triggering",
    trigger_status: baseline.all_present ? "not_needed" : "pending",
    verification_status: baseline.all_present ? "verified" : "pending",
    verification_mode: baseline.all_present ? "already_present" : null,
    target_fingerprint: deploymentTargetFingerprint(state, envBranch),
    repositories: baseline.repositories,
    trigger_attempts: attempts,
    stale_deploys: staleDeploys,
    baseline_captured_at: deps.nowFn(),
  });
  state.deploy_results[target.env_code] = record;
  saveState(env, state);

  if (baseline.all_present) {
    record.verified_at = deps.nowFn();
    for (const repo of Object.values(record.repositories)) repo.verified_at = record.verified_at;
    saveState(env, state);
    console.log(`\n===== ${target.env_code}（${target.env_name}）：本轮目标提交在触发前已位于 ${envBranch}，不重复触发 =====`);
    return record;
  }

  record.trigger_started_at = deps.nowFn();
  saveState(env, state);
  const fired = deps.triggerFn(state, target);
  record.trigger_attempts = attempts + 1;
  record.exit_code = fired.out.res.status;
  if (!fired.accepted && !fired.possiblyAccepted) {
    record.status = "failed";
    record.trigger_status = "rejected";
    record.unsupported = fired.unsupported;
    record.reason = fired.out.reason.slice(0, 500);
    saveState(env, state);
    return record;
  }
  record.status = "verifying";
  record.trigger_status = fired.accepted ? "accepted" : "possibly_accepted";
  record.trigger_accepted_at = deps.nowFn();
  record.reason = fired.accepted ? "" : `触发输出无法确认是否已受理；为避免重复触发，只继续验证目标提交。${fired.out.reason.slice(0, 300)}`;
  saveState(env, state);
  return record;
}

// 单个环境的「触发 + 内容验证」。只有一种情况允许再次调用接测命令：已经证实上一次接测
// 把合并前的旧快照发到了环境分支（stale_deploy）——此时继续等待永远等不到目标提交，
// 重触发是唯一出路。其余情况（只是还没等到）仍然一次都不重复触发。
async function triggerAndVerify(env, state, target, envBranch, record, overrides = {}) {
  const deps = {
    sleepFn: sleep,
    nowFn: () => new Date().toISOString(),
    triggerFn: triggerDeploy,
    baselineFn: (currentState, branch) => captureDeploymentBaseline(currentState, branch),
    pollFn: pollDeploymentVerification,
    ...overrides,
  };

  for (;;) {
    record = deploymentActionFor(record) === "verify"
      ? await resumeVerification(env, state, target, envBranch, record, deps)
      : await triggerOnce(env, state, target, envBranch, record, deps);
    // 触发被拒绝 / 基线里目标已经在了：都不需要再验证。
    if (record.status !== "verifying") return record;

    const verified = await deps.pollFn(record, { onProgress: () => saveState(env, state) });
    if (verified.verified) return record;

    if (verified.stale) {
      const attempts = record.trigger_attempts || 0;
      record.stale_deploys = [
        ...(record.stale_deploys || []),
        ...verified.stale.map((stale) => ({ ...stale, attempt: Math.max(attempts, 1) })),
      ];
      saveState(env, state);
      console.log(`\nNOTE: ${target.env_code} 这次接测已经跑完，但 Mars 发出去的是 f 分支合并前的提交 ` +
        `${verified.stale.map((stale) => stale.source_sha).join(", ")}，目标提交并没有进入 ${envBranch}`);
      if (attempts < MAX_TRIGGER_ATTEMPTS) continue;
      record.reason = `已触发 ${attempts} 次接测，其中 ${record.stale_deploys.length} 次被证实发到 ${record.env_branch} 的` +
        `是本轮合并前的 f 分支提交，目标提交始终没有进入测试分支（${staleDeployDetail(record)}）。` +
        `这通常说明 Mars 侧的分支快照迟迟没有刷新，需要人工在 Mars 上确认后重新接测。`;
      saveState(env, state);
      return record;
    }

    record.reason = `触发已受理，但等待约 ${Math.round((VERIFY_POLL_TRIES * VERIFY_POLL_INTERVAL_MS) / 60000)} 分钟后，` +
      `${record.env_branch} 仍未包含本轮全部目标提交。${verificationTimeoutDetail(record)}` +
      (record.stale_deploys && record.stale_deploys.length
        ? `；本轮此前已发生过旧快照接测（${staleDeployDetail(record)}）`
        : "");
    saveState(env, state);
    return record;
  }
}

// 目标 SHA 指纹变化时，判断刚才那次触发是不是新鲜到还值得只验证、不重触发。
function shouldCarryOverTrigger(record, nowFn = Date.now) {
  if (!["accepted", "possibly_accepted"].includes(record.trigger_status)) return false;
  const startedAt = Date.parse(record.trigger_started_at || "");
  if (!Number.isFinite(startedAt)) return false;
  return nowFn() - startedAt <= FINGERPRINT_CARRY_MAX_MS;
}

async function stepDeploy(env, state) {
  await prepareDeploymentTargets(env, state);

  const results = [];
  for (const target of state.deploy_targets) {
    if (state.skipped_envs.includes(target.env_code)) {
      console.log(`\n===== 跳过 ${target.env_code}（${target.env_name}）：已按用户决定跳过接测 =====`);
      results.push({ env_code: target.env_code, env_name: target.env_name, status: "skipped" });
      continue;
    }

    const envBranch = ENV_BRANCH_BY_CODE[target.env_code] || null;
    let record = state.deploy_results[target.env_code] || null;
    if (envBranch && record) {
      const currentFingerprint = deploymentTargetFingerprint(state, envBranch);
      const savedFingerprint = record.target_fingerprint || recordTargetFingerprint(record);
      if (savedFingerprint && savedFingerprint !== currentFingerprint) {
        const previousTriggerMayBeRunning = shouldCarryOverTrigger(record);
        console.log(`NOTE: ${target.env_code} 的本轮目标 SHA 已变化，废弃旧验证结果${previousTriggerMayBeRunning ? "并只验证原触发" : "（旧触发已过期，将重新触发）"}`);
        record = previousTriggerMayBeRunning
          ? newDeployRecord(target, envBranch, {
            status: "verifying",
            trigger_status: record.trigger_status,
            target_fingerprint: currentFingerprint,
            trigger_started_at: record.trigger_started_at,
            trigger_accepted_at: record.trigger_accepted_at,
          })
          : null;
        if (record) state.deploy_results[target.env_code] = record;
        else delete state.deploy_results[target.env_code];
        saveState(env, state);
      }
    }
    if (deploymentActionFor(record) === "skip") {
      console.log(`\n===== 跳过 ${target.env_code}（${target.env_name}）：本轮目标提交此前已在 ${record.env_branch} 验证 =====`);
      results.push(record);
      continue;
    }
    if (deploymentActionFor(record) === "blocked") {
      console.log(`\n===== 不再触发 ${target.env_code}（${target.env_name}）：平台已明确不支持该环境接测，重试无意义 =====`);
      results.push(record);
      continue;
    }

    // 没有可靠的环境分支映射时仍执行一次，以保留平台“不支持环境”的既有诊断；
    // 若平台接受触发，因为无法校验内容，必须 fail closed，绝不能报告完成。
    if (!envBranch) {
      // 只有「上一次明确被拒绝」才值得重试；已受理/不确定的触发一律不重复调用。
      const shouldTrigger = !record || !record.trigger_status ||
        (record.trigger_status === "rejected" && !record.unsupported);
      const fired = shouldTrigger ? triggerDeploy(state, target) : null;
      const accepted = fired ? fired.accepted : record.trigger_status === "accepted";
      const possiblyAccepted = fired ? fired.possiblyAccepted : record.trigger_status === "possibly_accepted";
      const triggerStatus = accepted ? "accepted" : possiblyAccepted ? "possibly_accepted" : "rejected";
      const unverifiableReason = {
        accepted: `平台已接受触发，但 env_code ${target.env_code} 没有可靠的 GitLab 环境分支映射，无法验证本轮目标提交是否进入测试分支`,
        possibly_accepted: `触发输出无法确认是否已受理，且 env_code ${target.env_code} 没有可靠的 GitLab 环境分支映射；不会自动重复触发`,
        rejected: fired ? fired.out.reason.slice(0, 500) : record.reason,
      }[triggerStatus];
      record = {
        ...(record || {}),
        env_code: target.env_code,
        env_name: target.env_name,
        status: triggerStatus === "rejected" ? "failed" : "unverifiable",
        trigger_status: triggerStatus,
        verification_status: "unavailable",
        exit_code: fired ? fired.out.res.status : record.exit_code,
        unsupported: fired ? fired.unsupported : !!record.unsupported,
        reason: unverifiableReason,
      };
      state.deploy_results[target.env_code] = record;
      saveState(env, state);
      results.push(record);
      continue;
    }

    record = await triggerAndVerify(env, state, target, envBranch, record);
    results.push(record);
  }

  // 先处理所有目标再统一报错；只有 verified 才是成功，accepted/verifying 都不是完成。
  const failed = results.filter((record) => !["verified", "skipped"].includes(record.status));
  if (failed.length) {
    const allUnsupported = failed.every((record) => record.unsupported);
    const skipHint = failed.filter((record) => record.unsupported).map((record) => `--skip-env ${record.env_code}`).join(" ");
    const staleEnvs = failed.filter((record) => record.status === "stale_deploy");
    stop(allUnsupported ? "NEED_USER" : "ERROR", "deploy",
      `以下环境尚未完成内容验证:\n${failed.map((record) => `- ${record.env_code}（${record.env_name}）: ${record.reason}`).join("\n")}\n` +
      `已验证环境: ${results.filter((record) => record.status === "verified").map((record) => record.env_code).join(", ") || "无"}（续跑不会重复触发）\n` +
      (skipHint
        ? `其中平台侧不支持接测的环境重试无意义，请询问用户是否跳过；同意后用 RESUME 续跑。\n`
        : "") +
      (staleEnvs.length
        ? `${staleEnvs.map((record) => record.env_code).join(", ")} 属于「接测跑了但发的是合并前的旧代码」，已自动重触发到上限；` +
          `续跑会再重新触发（重触发是这种情况唯一的出路），若仍然如此需要人工在 Mars 上排查分支快照。\n`
        : "") +
      `其余环境续跑时只会继续验证同一次触发，不会再次调用接测命令。`,
      "deploy", skipHint);
  }

  stepOk("deploy", results.map((record) => `${record.env_code}(${record.status})`).join(", "));
  return results;
}

// ---------- 主流程 ----------
function stateMatchesRun(env, state, head) {
  if (!state) return false;
  const stateHead = state.run_head_sha || state.head_sha;
  return stateHead === head &&
    state.dev_branch === env.devBranch &&
    state.f_branch === env.fBranch &&
    state.origin === env.origin;
}

// --from 只能选择同一轮中的步骤，不能绕过 HEAD/分支/origin 身份检查。
// 返回 { from, sameRun, note }，note 为需要如实打印的说明。
function resolveStartStep(env, state, head, runOpts = opts) {
  const sameRun = stateMatchesRun(env, state, head);
  if (runOpts.restart) {
    return { from: "sync", sameRun, note: "RESTART: 忽略状态文件中的断点，从 sync 完整执行" };
  }
  if (state && !sameRun) {
    return {
      from: "sync",
      sameRun,
      note: "NOTE: 状态文件属于另一轮 HEAD/分支/origin，即使指定了 --from 也不能复用旧 MR 或部署结果；按新一轮从 sync 完整执行",
    };
  }
  if (runOpts.from) return { from: runOpts.from, sameRun, note: "" };
  if (state && state.resume_from && sameRun) {
    return {
      from: state.resume_from,
      sameRun,
      note: `RESUMING: 上次在「${state.resume_from}」步中断且本轮身份未变化，自动从该步继续（完整重跑请加 --restart）`,
    };
  }
  return { from: "sync", sameRun, note: "" };
}

async function runWorkflow() {
  const env = envCheck();
  let state = loadState(env);
  if (state) normalizeRunState(state, state.skipped_envs || [], opts, env);
  STATE = state;

  const head = headSha();
  const start = resolveStartStep(env, state, head);
  if (start.note) console.log(start.note);
  const from = start.from;
  const fromIdx = STEPS.indexOf(from);

  if (fromIdx > STEPS.indexOf("plan") && !isPlanned(state)) {
    stop("ERROR", from, `状态文件缺失或不完整（${statePath(env)}），无法从 ${from} 断点续跑，请去掉 --from 重新完整执行`, "sync");
  }

  CURRENT_STEP = "sync";
  if (fromIdx <= STEPS.indexOf("sync")) stepSync();
  CURRENT_STEP = "plan";
  if (fromIdx <= STEPS.indexOf("plan")) {
    // sync 可能改写 HEAD，重跑 plan 前按最新 HEAD 判断旧部署结果是否仍属于同一轮。
    const carryDeploy = stateMatchesRun(env, state, headSha()) ? state.deploy_results : {};
    state = stepPlan(env, (state && state.skipped_envs) || [], carryDeploy);
  }
  STATE = state;
  // HEAD 必须在 sync 之后重新取：pull --rebase 可能改写提交。run_head_sha 从这里开始固定。
  state.run_head_sha = state.run_head_sha || headSha();
  state.head_sha = state.run_head_sha;
  normalizeRunState(state);

  if (opts.dryRun) {
    console.log("\nSTATUS: DRY_RUN");
    console.log("DETAIL: dry-run 结束（未创建 MR / 合并 / 部署，不能视为接测完成）");
    return;
  }

  CURRENT_STEP = "create";
  if (fromIdx <= STEPS.indexOf("create")) await stepCreate(env, state);
  CURRENT_STEP = "merge";
  if (fromIdx <= STEPS.indexOf("merge")) await stepMerge(env, state);
  CURRENT_STEP = "deploy";
  const deployResults = await stepDeploy(env, state);

  // 全部环境内容验证成功后才清掉断点。
  state.resume_from = null;
  saveState(env, state);

  console.log("\nSTATUS: OK");
  console.log("SUMMARY:");
  console.log(JSON.stringify({
    branch: `${state.dev_branch} → ${state.f_branch}`,
    head_sha: state.run_head_sha,
    merged_mrs: state.mrs.map((mr) => ({
      url: mr.web_url,
      state: mr.state,
      target_sha: mr.target_sha,
      target_sha_kind: mr.target_sha_kind,
    })),
    audit_user: `${state.audit_user_name}（${state.audit_user}, 来源: ${state.audit_user_source}）`,
    deploys: deployResults,
    skipped_envs: state.skipped_envs,
    skipped_repos: state.skipped_repos,
    closed_mrs: state.closed_mrs,
  }, null, 2));
  if ((state.closed_mrs || []).length) {
    console.log(`NOTE: 本轮有 MR 因为没有可合并的内容（上一轮已合并过）被关闭: ${state.closed_mrs.map((mr) =>
      `${mr.gl_project_path} !${mr.iid}（${mr.reason}${mr.close_error ? `；关闭失败: ${mr.close_error}` : "，已关闭"}）`).join("；")}，报告时需如实说明`);
  }
  if (state.skipped_envs.length) {
    console.log(`NOTE: 本轮跳过了这些环境的接测（用户此前已确认跳过）: ${state.skipped_envs.join(", ")}，报告时需如实说明`);
  }
  if (state.skipped_repos.length) {
    console.log(`NOTE: 本轮跳过了这些仓库的 MR（审核人不在合并人中）: ${state.skipped_repos.map((repo) => `${repo.gl_project_path}（${repo.reason}）`).join("；")}，报告时需如实说明`);
  }
  if (state.ask_register_global) {
    const reviewer = state.ask_register_global;
    console.log(`ASK_REGISTER_GLOBAL: 本次新增了审核人 ${reviewer.real_name}（${reviewer.user_name}），询问用户是否将其注册为 * 级（所有项目通用）审核人；同意则执行: node "${__filename}" register-global ${reviewer.user_name}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "register-global") return registerGlobal(argv);
  const parsed = parseRunOptions(argv);
  if (parsed.error) {
    console.error(parsed.error);
    return 1;
  }
  opts = parsed.opts;
  await runWorkflow();
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    if (code) process.exitCode = code;
  }).catch((err) => {
    // 任何意外异常都必须走同一套 STATUS 协议并落下断点。
    stop("ERROR", CURRENT_STEP, `未预期的异常（${err && err.message ? err.message : err}）:\n${(err && err.stack ? err.stack : "").slice(0, 1000)}`, CURRENT_STEP);
  });
}

module.exports = {
  applyMergedMrInfo,
  buildTargetFingerprint,
  captureDeploymentBaseline,
  classifyReviewerMissingRepos,
  closeMrWithNothingToMerge,
  deploymentActionFor,
  deploymentTargetFingerprint,
  filterMrsForExpectedSha,
  findStaleDeploy,
  isReviewerMissingFailure,
  isSettledMr,
  newDeployRecord,
  parseMarsDeployMerge,
  normalizeRunState,
  parseCreateRepoResults,
  parseRunOptions,
  pollDeploymentVerification,
  recordTargetFingerprint,
  resolveDevBranch,
  resolveStartStep,
  resolveTargetShaOnBranch,
  shaOnBranch,
  shouldCarryOverTrigger,
  stateMatchesRun,
  targetShaCandidates,
  triggerAndVerify,
  waitForMarsToSeeMerge,
};
