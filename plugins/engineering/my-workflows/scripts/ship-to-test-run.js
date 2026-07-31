#!/usr/bin/env node
// ship-to-test workflow 的一体化执行脚本。
// 除「提交 commit」外的全部固定流程在这里一次跑完，agent 只在出错时介入：
//   sync   → git pull --rebase + git push
//   plan   → yunke-cli 查询链（分支状态/仓库/应用/审核人）并落状态文件
//   create → 创建 MR 并通过 GitLab API 反查 + 校验 MR 确实对应本次提交
//   merge  → 调用 GitLab API 合并 MR
//   deploy → 确认合并已落到 f 分支后，对全部接测目标逐个部署并原样打印结果
//
// 输出协议（供 agent 解析）：
//   STATUS:   OK | NEED_USER | ERROR（唯一的成败判据，缺失即未完成）
//   STEP:     出问题的步骤名
//   DETAIL:   具体原因（可能多行）
//   RESUME:   问题解决后用于断点续跑的完整命令
//   NOTE:     需要如实转告用户的信息（跳过的环境、复用已合并 MR、跳过无分支的仓库等）
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
// 类命令都必须做文本级失败检测 + 语义校验（见 yunkeAction / stepCreate），只看退出码会
// 把失败当成功，并可能误把上一轮的旧 MR 当成本次结果，导致接测的是旧代码。
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

const STEPS = ["sync", "plan", "create", "merge", "deploy"];
const MEMORY_FILE = path.join(os.homedir(), ".yunke-cli", "my-workflow-reviewers.json");
// Mars 用整条 commit message 作为 MR 标题，GitLab 侧上限 255 字符
const MAX_MR_TITLE = 255;

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
const argv = process.argv.slice(2);

// register-global 子命令：把指定审核人注册为 * 级（所有项目通用）
if (argv[0] === "register-global") {
  const userName = argv[1];
  if (!userName) {
    console.error("用法: node ship-to-test-run.js register-global <user_name> [<real_name>]");
    process.exit(1);
  }
  const memory = loadMemory();
  const known = Object.values(memory).find((v) => v && v.audit_user === userName);
  const realName = argv[2] || (known && known.name) || "";
  memory["*"] = { audit_user: userName, name: realName };
  saveMemory(memory);
  console.log(`已将 ${realName ? `${realName}（${userName}）` : userName} 注册为 * 级审核人（所有项目通用）`);
  process.exit(0);
}

if (argv[0] !== "run") {
  console.error("用法: node ship-to-test-run.js run [--audit-user <关键字>] [--from <step>] [--skip-env <env_code>] [--restart] [--dry-run]\n     node ship-to-test-run.js register-global <user_name> [<real_name>]");
  process.exit(1);
}
const opts = { auditUser: "", from: "", skipEnvs: [], restart: false, dryRun: false };
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--audit-user") opts.auditUser = argv[++i] || "";
  else if (argv[i] === "--from") opts.from = argv[++i] || "";
  else if (argv[i] === "--skip-env") { const v = argv[++i]; if (v) opts.skipEnvs.push(v); }
  else if (argv[i] === "--restart") opts.restart = true;
  else if (argv[i] === "--dry-run") opts.dryRun = true;
}
if (opts.from && !STEPS.includes(opts.from)) {
  console.error(`--from 必须是: ${STEPS.join(" | ")}`);
  process.exit(1);
}

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
function yunke(args) {
  return sh("yunke-cli", ["devops", ...args], true);
}

// yunke-cli 输出是 MCP 结果 JSON，真正的业务信息在 content[].text 里
function yunkeText(res) {
  const out = (res.stdout || "").trim();
  try {
    const j = JSON.parse(out);
    if (Array.isArray(j.content)) {
      return j.content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n");
    }
  } catch { /* 非 JSON 就原样返回 */ }
  return out;
}

// 平台侧「该环境不支持接测」的措辞：既是失败标记，也用于把这类失败单独归类
// （重试永远不会成功，只能由用户决定跳过）。两处共用一个正则，避免分类规则漂移。
const UNSUPPORTED_ENV_RE = /不支持的环境|不支持接测|只支持/;

// 动作类命令（创建 MR / 部署）的失败标记：这些命令失败时退出码仍是 0。
// 只匹配「命令执行失败」类措辞，不能匹配业务数据里的正常词（如 pipeline_status: 发布失败）。
// 注意「未成功/不成功/部分成功」必须排在成功判定之前：它们都包含「成功」二字，
// 只靠 OK_MARKERS 的 /成功/ 会把失败读成成功——正是本次要根除的那类误判。
const FAIL_MARKERS = [
  /❌/,
  /未成功|不成功|部分成功/,
  /失败仓库/,
  /创建\s*mr\s*失败/i,
  /操作失败/,
  /接口请求失败/,
  UNSUPPORTED_ENV_RE,
  /"success"\s*:\s*false/,
  /statusCode:\s*[45]\d{2}/,
  /(无|没有|缺少)权限|权限不足/,
];
const OK_MARKERS = [/✅/, /"success"\s*:\s*true/, /成功/];

// 返回 { ok, unsure, text, reason }：ok=false 表示确定失败，unsure 表示既没有失败标记
// 也没有成功标记，无法判断，交给 agent/用户人工确认，绝不静默当成功。
function yunkeAction(args) {
  const res = yunke(args);
  const text = yunkeText(res);
  if (res.status !== 0) {
    return { ok: false, unsure: false, text, res, reason: `命令退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, 2000)}` };
  }
  const failed = FAIL_MARKERS.find((re) => re.test(text));
  if (failed) {
    return { ok: false, unsure: false, text, res, reason: `命令退出码为 0，但输出包含失败信息（匹配 ${failed}）:\n${text.slice(0, 2000)}` };
  }
  if (!OK_MARKERS.some((re) => re.test(text))) {
    return { ok: false, unsure: true, text, res, reason: `输出中既无成功标记也无失败标记，无法判定结果:\n${text.slice(0, 2000)}` };
  }
  return { ok: true, unsure: false, text, res };
}

function yunkeJson(args, stepName, resumeStep) {
  const res = yunke(args);
  if (res.status !== 0) {
    stop("ERROR", stepName,
      `yunke-cli devops ${args.join(" ")} 退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, 2000)}`,
      resumeStep);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    stop("ERROR", stepName, `yunke-cli 输出不是合法 JSON:\n${res.stdout.slice(0, 2000)}`, resumeStep);
  }
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
function envCheck() {
  const top = git(["rev-parse", "--show-toplevel"], true);
  if (top.status !== 0) stop("ERROR", "env", "当前目录不是 git 仓库");
  const toplevel = top.stdout.trim();
  // worktree 场景下 .git 是文件，状态文件必须放进真实的 git 目录
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const branch = git(["branch", "--show-current"]).stdout.trim();

  ENV = {
    toplevel,
    gitDir,
    dirName: path.basename(toplevel),
    devBranch: branch,
    fBranch: branch.replace(/^dev-/, ""),
    origin: git(["remote", "get-url", "origin"]).stdout.trim(),
  };

  if (!branch.startsWith("dev-f")) {
    stop("NEED_USER", "env",
      `当前分支 ${branch} 不以 dev-f 开头，请让用户确认应使用的 dev 分支后切换过去再继续`,
      "sync");
  }

  if (!process.env.MY_WORKFLOW_GL_ACCESS_TOKEN) {
    stop("NEED_USER", "env",
      "环境变量 MY_WORKFLOW_GL_ACCESS_TOKEN 未设置（GitLab access token，合并 MR 需要）。请让用户配置后继续",
      opts.from || "sync");
  }

  if (sh("yunke-cli", ["--help"], true).status === 127) {
    console.log("yunke-cli 未安装，尝试自动安装...");
    const install = sh("npm", [
      "install", "-g", "@yunke/yunke-cli@latest",
      "--registry", "https://registry-npm.myscrm.cn/repository/yunke/",
    ], true);
    if (install.status !== 0 || sh("yunke-cli", ["--help"], true).status === 127) {
      stop("NEED_USER", "env",
        `yunke-cli 自动安装失败，请让用户手动安装后继续:\n${(install.stderr || install.stdout || "").slice(0, 1000)}`,
        opts.from || "sync");
    }
  }

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
function saveState(env, state) {
  state.head_sha = headSha();
  fs.writeFileSync(statePath(env), JSON.stringify(state, null, 2));
}
// 状态里两个「按轮累积」的字段统一在这里归并：本次 --skip-env 并入已有的跳过决定，
// deploy_results 保证存在。各步骤只读 state，不再各自重算同一条规则。
function normalizeRunState(state, prevSkippedEnvs = []) {
  state.skipped_envs = [...new Set([...prevSkippedEnvs, ...(state.skipped_envs || []), ...opts.skipEnvs])];
  state.deploy_results = state.deploy_results || {};
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

function stepPlan(env, prevSkippedEnvs = []) {
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
    dev_branch: env.devBranch,
    f_branch: env.fBranch,
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
    deploy_results: {},
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

async function findMr(repo, state, wantStates = "opened") {
  const url = `${projBaseOf(repo)}/merge_requests?source_branch=${encodeURIComponent(state.dev_branch)}&target_branch=${encodeURIComponent(state.f_branch)}&state=${wantStates}&order_by=created_at&sort=desc`;
  const res = await glFetch(url);
  if (res.status !== 200) return { error: `GitLab 查询 MR 失败 HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 800)}` };
  return { mrs: Array.isArray(res.body) ? res.body : [] };
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

// 某个 commit 是否已经在指定分支上
async function shaOnBranch(projBase, sha, branch) {
  const refs = await glFetch(`${projBase}/repository/commits/${sha}/refs?type=branch&per_page=100`);
  if (refs.status === 404) return { on: false };
  if (refs.status !== 200 || !Array.isArray(refs.body)) {
    return { on: false, error: `GitLab 查询 commit refs 失败 HTTP ${refs.status}: ${JSON.stringify(refs.body).slice(0, 500)}` };
  }
  return { on: refs.body.some((r) => r.name === branch) };
}

async function stepCreate(env, state) {
  const args = ["mars-branch-create-merge-request", "--app_branch_id", String(state.app_branch_id)];
  for (const r of state.repositories) args.push("--repositories", r.repository);
  args.push("--audit_user", state.audit_user);

  const out = yunkeAction(args);
  console.log(`create-merge-request 原始输出:\n${out.text.trim()}`);

  // 先做文本级失败检测：yunke-cli 创建 MR 失败时退出码依然是 0
  if (!out.ok && !out.unsure) {
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
    const projBase = projBaseOf(repo);
    const expected = await expectedShaOf(repo, state);
    if (expected.error) stop("ERROR", "create", expected.error, "create");
    if (expected.missing) {
      console.log(`NOTE: ${repo.gl_project_path} 上不存在分支 ${state.dev_branch}，该仓库本轮没有要合并的内容，跳过`);
      continue;
    }

    const found = await findMr(repo, state, "opened");
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
      const mergedFound = await findMr(repo, state, "merged");
      if (mergedFound.error) stop("ERROR", "create", mergedFound.error, "create");
      mr = mergedFound.mrs[0];
      if (!mr) {
        console.log(`NOTE: ${repo.gl_project_path} 未找到 MR 记录，但本轮提交已在 ${state.f_branch} 上，按已合并处理`);
        mrs.push({
          gl_host: repo.gl_host, gl_project_path: repo.gl_project_path,
          iid: null, web_url: null, state: "merged",
          expected_sha: expected.sha, merged_sha: expected.sha,
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
      merged_sha: mr.merge_commit_sha || mr.squash_commit_sha || null,
    });
  }
  if (!mrs.length) {
    stop("ERROR", "create",
      `没有任何仓库产生可合并的 MR（全部仓库都没有 ${state.dev_branch} 分支）。请确认分支与应用配置后续跑`,
      "create");
  }

  if (out.unsure) {
    console.log(`NOTE: create 输出无法自动判定成败，但 GitLab 侧已确认到对应 MR，继续执行。原始判定信息: ${out.reason.slice(0, 300)}`);
  }
  state.mrs = mrs;
  saveState(env, state);
  stepOk("create", state.mrs.map((m) => `${m.web_url || "(无 MR 记录)"} (${m.state})`).join(", "));
}

async function stepMerge(env, state) {
  if (!state.mrs.length) {
    stop("ERROR", "merge", "状态文件中没有 MR 记录，无法合并，请从 create 步骤重跑", "create");
  }
  for (const mr of state.mrs) {
    if (mr.state === "merged") continue;
    const base = `${projBaseOf(mr)}/merge_requests/${mr.iid}`;

    // 等待 GitLab 完成可合并性检查
    for (let i = 0; i < 5; i++) {
      const info = await glFetch(base);
      if (info.status !== 200) break;
      const ms = info.body.detailed_merge_status || info.body.merge_status;
      if (ms !== "checking" && ms !== "unchecked" && ms !== "preparing") break;
      await sleep(3000);
    }

    const res = await glFetch(`${base}/merge`, "PUT");
    if (res.status === 200 && res.body && res.body.state === "merged") {
      mr.state = "merged";
      mr.merged_sha = res.body.merge_commit_sha || res.body.squash_commit_sha || res.body.sha || null;
      saveState(env, state);
      continue;
    }
    stop("ERROR", "merge",
      `合并 ${mr.web_url} 失败 HTTP ${res.status}（常见原因: 流水线未通过/需要审批/存在冲突）:\n${JSON.stringify(res.body).slice(0, 1200)}\n请向用户说明并等待处理，处理完后续跑`,
      "merge");
  }
  stepOk("merge", state.mrs.map((m) => m.web_url || m.merged_sha).join(", "));
}

// GitLab 的 merge API 返回 merged 只代表受理，合并提交真正落到 f 分支引用是异步的。
// 部署前必须确认 f 分支已包含本次提交，否则 Mars 流水线 checkout 到旧 tip，接测内容缺少刚合并的代码。
const LAND_POLL_TRIES = 20;
const LAND_POLL_INTERVAL_MS = 3000;
async function waitShaOnBranch(projBase, sha, branch, label, maxTries = LAND_POLL_TRIES) {
  for (let i = 1; i <= maxTries; i++) {
    const r = await shaOnBranch(projBase, sha, branch);
    if (r.error) {
      stop("ERROR", "deploy", `确认合并落地时 ${r.error}`, "deploy");
    }
    if (r.on) {
      console.log(`合并落地确认: ${label} 的 ${branch} 已包含 ${sha.slice(0, 10)}（第 ${i} 次检查）`);
      return true;
    }
    if (i < maxTries) await sleep(LAND_POLL_INTERVAL_MS);
  }
  return false;
}

async function waitMergeLanded(env, state) {
  for (const mr of state.mrs) {
    if (mr.state !== "merged") {
      stop("ERROR", "deploy", `${mr.web_url} 仍未合并（state: ${mr.state}），不能部署，请先完成 merge 步骤`, "merge");
    }
    const projBase = projBaseOf(mr);

    // 旧状态文件可能没有 merged_sha，回查 MR 详情补齐
    if (!mr.merged_sha && mr.iid) {
      const info = await glFetch(`${projBase}/merge_requests/${mr.iid}`);
      if (info.status === 200) {
        mr.merged_sha = info.body.merge_commit_sha || info.body.squash_commit_sha || info.body.sha || null;
        saveState(env, state);
      }
    }

    // 优先用本轮那个提交本身作判据（create 时按仓库解析好的 expected_sha）：
    // 它直接回答「我这轮的代码到底进没进 f 分支」，比合并提交更准确。
    const sha = mr.expected_sha || mr.merged_sha;
    if (!sha) {
      stop("ERROR", "deploy",
        `无法确定 ${mr.web_url} 本轮应落地的提交 SHA，无法确认合并是否落到 ${state.f_branch}。请人工确认后再决定是否续跑（盲目部署可能接测旧代码）`,
        "deploy");
    }

    const landed = await waitShaOnBranch(projBase, sha, state.f_branch, mr.gl_project_path);
    if (!landed) {
      stop("ERROR", "deploy",
        `等待约 ${(LAND_POLL_TRIES * LAND_POLL_INTERVAL_MS) / 1000} 秒后，${mr.gl_project_path} 的 ${state.f_branch} 分支仍未包含提交 ${sha}（${mr.web_url || "无 MR 链接"}）。为避免无效接测已中止部署，请确认合并状态后续跑`,
        "deploy");
    }
  }
  // 留出短暂缓冲，等待 Mars 侧仓库同步
  await sleep(3000);
}

async function stepDeploy(env, state) {
  await waitMergeLanded(env, state);

  const results = [];
  for (const t of state.deploy_targets) {
    if (state.skipped_envs.includes(t.env_code)) {
      console.log(`\n===== 跳过 ${t.env_code}（${t.env_name}）：已按用户决定跳过接测 =====`);
      results.push({ env_code: t.env_code, env_name: t.env_name, status: "skipped" });
      continue;
    }
    // 续跑时不重复部署已经成功的环境
    const prev = state.deploy_results[t.env_code];
    if (prev && prev.status === "ok") {
      console.log(`\n===== 跳过 ${t.env_code}（${t.env_name}）：本轮此前已部署成功 =====`);
      results.push(prev);
      continue;
    }

    const out = yunkeAction(["mars-branch-deploy-branch", "--app_branch_id", String(state.app_branch_id), "--env_code", t.env_code]);
    console.log(`\n===== 部署 ${t.env_code}（${t.env_name}）完整输出 =====`);
    console.log(out.text.trim());
    if (out.res.stderr && out.res.stderr.trim()) console.log(`stderr: ${out.res.stderr.trim().slice(0, 1000)}`);

    const record = {
      env_code: t.env_code,
      env_name: t.env_name,
      status: out.ok ? "ok" : out.unsure ? "unknown" : "failed",
      exit_code: out.res.status,
      // 平台侧明确不支持该环境接测时，重试永远不会成功，只能由用户决定是否跳过
      unsupported: !out.ok && UNSUPPORTED_ENV_RE.test(out.text),
      reason: out.ok ? "" : out.reason.slice(0, 500),
    };
    state.deploy_results[t.env_code] = record;
    saveState(env, state);
    results.push(record);
  }

  // 先把所有目标都跑完再统一报错，避免一个环境失败就漏掉其它环境
  const failed = results.filter((r) => r.status === "failed" || r.status === "unknown");
  if (failed.length) {
    const allUnsupported = failed.every((r) => r.unsupported);
    const skipHint = failed.filter((r) => r.unsupported).map((r) => `--skip-env ${r.env_code}`).join(" ");
    stop(allUnsupported ? "NEED_USER" : "ERROR", "deploy",
      `以下环境部署未成功:\n${failed.map((r) => `- ${r.env_code}（${r.env_name}）: ${r.reason}`).join("\n")}\n` +
      `已成功的环境: ${results.filter((r) => r.status === "ok").map((r) => r.env_code).join(", ") || "无"}（续跑不会重复部署）\n` +
      (skipHint
        ? `其中平台侧不支持接测的环境重试无意义，请询问用户是否跳过；同意则用 RESUME 命令续跑（跳过决定会记入状态文件，后续轮次不再询问）。\n`
        : "") +
      `其余失败请阅读上方完整输出判断原因，修复后用 RESUME 续跑。`,
      "deploy", skipHint);
  }

  stepOk("deploy", results.map((r) => `${r.env_code}(${r.status})`).join(", "));
  return results;
}

// ---------- 主流程 ----------
(async () => {
  const env = envCheck();
  let state = loadState(env);
  STATE = state;

  // 断点续跑：显式 --from 优先；否则若状态文件记录了中断步骤且 HEAD 没变，自动从那一步继续
  let from = opts.from;
  const head = headSha();
  if (opts.restart) {
    from = "sync";
    console.log("RESTART: 忽略状态文件中的断点，从 sync 完整执行");
  } else if (!from) {
    if (state && state.resume_from && state.head_sha === head) {
      from = state.resume_from;
      console.log(`RESUMING: 上次在「${from}」步中断且 HEAD 未变化，自动从该步继续（完整重跑请加 --restart）`);
    } else {
      from = "sync";
      if (state && state.resume_from) {
        console.log(`NOTE: 状态文件记录的中断步骤是「${state.resume_from}」，但 HEAD 已变化（有新提交或 rebase），按新一轮从 sync 完整执行`);
      }
    }
  }
  const fromIdx = STEPS.indexOf(from);

  if (fromIdx > STEPS.indexOf("plan") && !isPlanned(state)) {
    stop("ERROR", from, `状态文件缺失或不完整（${statePath(env)}），无法从 ${from} 断点续跑，请去掉 --from 重新完整执行`, "sync");
  }

  CURRENT_STEP = "sync";
  if (fromIdx <= STEPS.indexOf("sync")) stepSync();
  CURRENT_STEP = "plan";
  if (fromIdx <= STEPS.indexOf("plan")) state = stepPlan(env, (state && state.skipped_envs) || []);
  STATE = state;
  // HEAD 必须在 sync 之后重新取：pull --rebase 会改写本地提交，
  // 沿用进入脚本时的旧 sha 会让后面所有「这轮提交进没进 f 分支」的校验都对着一个不存在的提交。
  state.head_sha = headSha();
  normalizeRunState(state);

  if (opts.dryRun) {
    console.log("\nSTATUS: OK");
    console.log("DETAIL: dry-run 结束（未创建 MR / 合并 / 部署）");
    return;
  }

  CURRENT_STEP = "create";
  if (fromIdx <= STEPS.indexOf("create")) await stepCreate(env, state);
  CURRENT_STEP = "merge";
  if (fromIdx <= STEPS.indexOf("merge")) await stepMerge(env, state);
  CURRENT_STEP = "deploy";
  const deployResults = await stepDeploy(env, state);

  // 全部成功才清掉断点，避免下次调用误续跑
  state.resume_from = null;
  saveState(env, state);

  console.log("\nSTATUS: OK");
  console.log("SUMMARY:");
  console.log(JSON.stringify({
    branch: `${state.dev_branch} → ${state.f_branch}`,
    head_sha: state.head_sha,
    merged_mrs: state.mrs.map((m) => m.web_url || `(无链接, sha ${m.merged_sha})`),
    audit_user: `${state.audit_user_name}（${state.audit_user}, 来源: ${state.audit_user_source}）`,
    deploys: deployResults,
    skipped_envs: state.skipped_envs,
  }, null, 2));
  if (state.skipped_envs.length) {
    console.log(`NOTE: 本轮跳过了这些环境的接测（用户此前已确认跳过）: ${state.skipped_envs.join(", ")}，报告时需如实说明`);
  }
  if (state.ask_register_global) {
    const g = state.ask_register_global;
    console.log(`ASK_REGISTER_GLOBAL: 本次新增了审核人 ${g.real_name}（${g.user_name}），询问用户是否将其注册为 * 级（所有项目通用）审核人；同意则执行: node "${__filename}" register-global ${g.user_name}`);
  }
})().catch((err) => {
  // 任何意外异常（典型是 GitLab 请求的网络错误）都必须走同一套 STATUS 协议并落下断点，
  // 否则 agent 只会看到一段没有 STATUS/RESUME 的堆栈，还会丢掉续跑位置。
  stop("ERROR", CURRENT_STEP, `未预期的异常（${err && err.message ? err.message : err}）:\n${(err && err.stack ? err.stack : "").slice(0, 1000)}`, CURRENT_STEP);
});
