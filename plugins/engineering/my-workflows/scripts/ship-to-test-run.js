#!/usr/bin/env node
// ship-to-test workflow 的一体化执行脚本。
// 除「提交 commit」外的全部固定流程在这里一次跑完，agent 只在出错时介入：
//   sync   → git pull --rebase + git push
//   plan   → yunke-cli 查询链（分支状态/仓库/应用/审核人）并落状态文件
//   create → 创建 MR 并通过 GitLab API 反查 MR（create 返回不含链接）
//   merge  → 调用 GitLab API 合并 MR
//   deploy → 对全部接测目标逐个部署并原样打印结果
//
// 输出协议（供 agent 解析）：
//   STATUS: OK | NEED_USER | ERROR
//   STEP:   出问题的步骤名
//   DETAIL: 具体原因（可能多行）
//   RESUME: 问题解决后用于断点续跑的完整命令
//
// 用法:
//   node ship-to-test-run.js run [--audit-user <关键字或user_name>] [--from <step>] [--dry-run]
//   node ship-to-test-run.js register-global <user_name> [<real_name>]
//
// 审核人记忆（~/.yunke-cli/my-workflow-reviewers.json）优先级:
//   显式 --audit-user > "*" 级（所有项目通用） > 项目级（origin 为 key） > 让用户选择
//
// 状态文件: <git目录>/ship-to-test-state.json（前置查询结果与 MR 信息，
// 断点续跑时原样复用，保证重试不更换参数）。

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STEPS = ["sync", "plan", "create", "merge", "deploy"];
const MEMORY_FILE = path.join(os.homedir(), ".yunke-cli", "my-workflow-reviewers.json");

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
  console.error("用法: node ship-to-test-run.js run [--audit-user <关键字>] [--from <step>] [--dry-run]\n     node ship-to-test-run.js register-global <user_name> [<real_name>]");
  process.exit(1);
}
const opts = { auditUser: "", from: "sync", dryRun: false };
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--audit-user") opts.auditUser = argv[++i] || "";
  else if (argv[i] === "--from") opts.from = argv[++i] || "sync";
  else if (argv[i] === "--dry-run") opts.dryRun = true;
}
if (!STEPS.includes(opts.from)) {
  console.error(`--from 必须是: ${STEPS.join(" | ")}`);
  process.exit(1);
}

// ---------- 输出与退出 ----------
function resumeCmd(step, extra = "") {
  const base = `node "${__filename}" run --from ${step}`;
  return extra ? `${base} ${extra}` : base;
}
function stop(status, step, detail, resume) {
  console.log(`\nSTATUS: ${status}`);
  console.log(`STEP: ${step}`);
  console.log(`DETAIL: ${detail}`);
  if (resume) console.log(`RESUME: ${resume}`);
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
    stop("ERROR", "env", `命令执行失败: ${cmd} ${args.join(" ")}\n${res.error.message}`);
  }
  return res;
}
function git(args, allowFail = false) {
  return sh("git", args, allowFail);
}
function yunke(args) {
  const res = sh("yunke-cli", ["devops", ...args], true);
  return res;
}
function yunkeJson(args, stepName) {
  const res = yunke(args);
  if (res.status !== 0) {
    stop("ERROR", stepName,
      `yunke-cli devops ${args.join(" ")} 退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, 2000)}`,
      resumeCmd(stepName === "deploy" ? "deploy" : "plan"));
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    stop("ERROR", stepName,
      `yunke-cli 输出不是合法 JSON:\n${res.stdout.slice(0, 2000)}`,
      resumeCmd("plan"));
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
  if (!branch.startsWith("dev-f")) {
    stop("NEED_USER", "env",
      `当前分支 ${branch} 不以 dev-f 开头，请让用户确认应使用的 dev 分支后切换过去再继续`,
      resumeCmd("sync"));
  }
  const origin = git(["remote", "get-url", "origin"]).stdout.trim();

  if (!process.env.MY_WORKFLOW_GL_ACCESS_TOKEN) {
    stop("NEED_USER", "env",
      "环境变量 MY_WORKFLOW_GL_ACCESS_TOKEN 未设置（GitLab access token，合并 MR 需要）。请让用户配置后继续",
      resumeCmd(opts.from));
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
        resumeCmd(opts.from));
    }
  }

  return {
    toplevel,
    gitDir,
    dirName: path.basename(toplevel),
    devBranch: branch,
    fBranch: branch.replace(/^dev-/, ""),
    origin,
  };
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
  fs.writeFileSync(statePath(env), JSON.stringify(state, null, 2));
}

// ---------- 各步骤 ----------
function stepSync() {
  const pull = git(["pull", "--rebase"], true);
  if (pull.status !== 0) {
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"], true).stdout.trim();
    stop("NEED_USER", "sync",
      `git pull --rebase 失败。\n冲突文件:\n${conflicts || "(无冲突文件，可能是未提交变更或网络问题)"}\n输出:\n${(pull.stderr || pull.stdout).slice(0, 1500)}\n请先自行判断能否安全解决冲突并 git rebase --continue；不能则让用户介入处理`,
      resumeCmd("sync"));
  }
  const push = git(["push"], true);
  if (push.status !== 0) {
    stop("ERROR", "sync", `git push 失败:\n${(push.stderr || push.stdout).slice(0, 1500)}`, resumeCmd("sync"));
  }
  stepOk("sync", "pull --rebase + push 完成");
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
    "plan"
  );
  const users = (json.structuredContent && json.structuredContent.items) || [];
  if (!users.length) stop("ERROR", "plan", `未查询到可选审核人（product_id: ${productId}）`, resumeCmd("plan"));

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
      resumeCmd("plan", `--audit-user <user_name>`));
  }

  stop("NEED_USER", "plan",
    `本项目还没有记忆的审核人，请让用户从以下列表中选择（选择后用所选 user_name 续跑）:\n${JSON.stringify(compact, null, 2)}`,
    resumeCmd("plan", `--audit-user <user_name>`));
}

function stepPlan(env) {
  // 1. 分支状态 → app_branch_id + 接测目标
  const statusJson = yunkeJson(["mars-branch-query-branch-status", "--branch_name", env.fBranch], "plan");
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
      resumeCmd("plan"));
  }
  const appBranchId = hits[0].app_branch_id;
  const deployTargets = hits.map((i) => ({
    env_code: i.env_code, env_name: i.env_name, pipeline_status: i.pipeline_status,
  }));

  // 2. 仓库 → repositories + service_name
  const repoJson = yunkeJson(["mars-branch-query-repositories", "--app_branch_id", String(appBranchId)], "plan");
  let repos;
  try {
    repos = JSON.parse((repoJson.content && repoJson.content[0] && repoJson.content[0].text) || "[]");
  } catch {
    stop("ERROR", "plan", "仓库列表解析失败", resumeCmd("plan"));
  }
  if (!Array.isArray(repos) || !repos.length) {
    stop("ERROR", "plan", `应用分支 ${appBranchId} 未查询到仓库`, resumeCmd("plan"));
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
  const appJson = yunkeJson(["mars-branch-query-applications", "--service_name", primary.service_name], "plan");
  const apps = (appJson.structuredContent && appJson.structuredContent.items) || [];
  const app = apps.find((a) => a.service_name === primary.service_name) || apps[0];
  if (!app) stop("ERROR", "plan", `未查询到应用（service_name: ${primary.service_name}）`, resumeCmd("plan"));

  // 4. 审核人
  const reviewer = resolveAuditUser(env, app.product_id);

  const state = {
    dev_branch: env.devBranch,
    f_branch: env.fBranch,
    app_branch_id: appBranchId,
    product_id: app.product_id,
    repositories: repoInfos,
    audit_user: reviewer.audit_user,
    audit_user_name: reviewer.name,
    audit_user_source: reviewer.source,
    ask_register_global: reviewer.ask_register_global || null,
    deploy_targets: deployTargets,
    mrs: [],
  };
  saveState(env, state);
  stepOk("plan", "");
  console.log("PLAN:");
  console.log(JSON.stringify(state, null, 2));
  return state;
}

async function findMr(repo, state, wantStates = "opened") {
  const url = `${repo.gl_host}/api/v4/projects/${encodeURIComponent(repo.gl_project_path)}/merge_requests?source_branch=${encodeURIComponent(state.dev_branch)}&target_branch=${encodeURIComponent(state.f_branch)}&state=${wantStates}&order_by=created_at&sort=desc`;
  const res = await glFetch(url);
  if (res.status !== 200) return { error: `GitLab 查询 MR 失败 HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 800)}` };
  return { mrs: res.body };
}

async function stepCreate(env, state) {
  const args = ["mars-branch-create-merge-request", "--app_branch_id", String(state.app_branch_id)];
  for (const r of state.repositories) args.push("--repositories", r.repository);
  args.push("--audit_user", state.audit_user);

  const res = yunke(args);
  console.log(`create-merge-request 原始输出:\n${(res.stdout || "").trim()}`);
  if (res.status !== 0) {
    stop("ERROR", "create",
      `创建 MR 失败，退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, 2000)}\n若为权限不足，提示用户联系 SM 或系统管理员开通 Mars 权限；重试必须原样复用状态文件中的参数`,
      resumeCmd("create"));
  }

  // create 返回不含 MR 链接，通过 GitLab API 按 source/target 分支反查
  state.mrs = [];
  for (const repo of state.repositories) {
    let found = await findMr(repo, state, "opened");
    if (found.error) stop("ERROR", "create", found.error, resumeCmd("create"));
    let mr = found.mrs[0];
    if (!mr) {
      // 可能已被合并（重复续跑场景）
      found = await findMr(repo, state, "merged");
      if (found.error) stop("ERROR", "create", found.error, resumeCmd("create"));
      mr = found.mrs[0];
      if (!mr) {
        stop("ERROR", "create",
          `在 ${repo.gl_project_path} 中未找到 ${state.dev_branch} → ${state.f_branch} 的 MR。可能创建未生效或分支无差异，请检查 create 输出后决定是否续跑`,
          resumeCmd("create"));
      }
    }
    state.mrs.push({
      gl_host: repo.gl_host,
      gl_project_path: repo.gl_project_path,
      iid: mr.iid,
      web_url: mr.web_url,
      state: mr.state,
      merged_sha: mr.merge_commit_sha || mr.squash_commit_sha || null,
    });
  }
  saveState(env, state);
  stepOk("create", state.mrs.map((m) => `${m.web_url} (${m.state})`).join(", "));
}

async function stepMerge(env, state) {
  for (const mr of state.mrs) {
    if (mr.state === "merged") continue;
    const base = `${mr.gl_host}/api/v4/projects/${encodeURIComponent(mr.gl_project_path)}/merge_requests/${mr.iid}`;

    // 等待 GitLab 完成可合并性检查
    for (let i = 0; i < 5; i++) {
      const info = await glFetch(base);
      if (info.status !== 200) break;
      const ms = info.body.detailed_merge_status || info.body.merge_status;
      if (ms !== "checking" && ms !== "unchecked" && ms !== "preparing") break;
      await new Promise((r) => setTimeout(r, 3000));
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
      resumeCmd("merge"));
  }
  stepOk("merge", state.mrs.map((m) => m.web_url).join(", "));
}

// GitLab 的 merge API 返回 merged 只代表受理，合并提交真正落到 f 分支引用是异步的。
// 部署前必须确认 f 分支已包含合并提交，否则 Mars 流水线 checkout 到旧 tip，接测内容缺少刚合并的代码。
async function waitMergeLanded(env, state) {
  for (const mr of state.mrs) {
    if (mr.state !== "merged") continue;
    const projBase = `${mr.gl_host}/api/v4/projects/${encodeURIComponent(mr.gl_project_path)}`;

    // 旧状态文件可能没有 merged_sha，回查 MR 详情补齐
    if (!mr.merged_sha) {
      const info = await glFetch(`${projBase}/merge_requests/${mr.iid}`);
      if (info.status === 200) {
        mr.merged_sha = info.body.merge_commit_sha || info.body.squash_commit_sha || info.body.sha || null;
        saveState(env, state);
      }
    }
    if (!mr.merged_sha) {
      console.log(`警告: 无法获取 ${mr.web_url} 的合并提交 SHA，跳过落地确认（接测内容可能滞后，请在结果中留意）`);
      continue;
    }

    const maxTries = 20;
    let landed = false;
    for (let i = 1; i <= maxTries; i++) {
      const refs = await glFetch(`${projBase}/repository/commits/${mr.merged_sha}/refs?type=branch&per_page=100`);
      if (refs.status === 200 && Array.isArray(refs.body) &&
          refs.body.some((r) => r.name === state.f_branch)) {
        landed = true;
        console.log(`合并落地确认: ${mr.gl_project_path} 的 ${state.f_branch} 已包含 ${mr.merged_sha.slice(0, 10)}（第 ${i} 次检查）`);
        break;
      }
      if (refs.status !== 200 && refs.status !== 404) {
        stop("ERROR", "deploy",
          `确认合并落地时 GitLab 查询失败 HTTP ${refs.status}: ${JSON.stringify(refs.body).slice(0, 800)}`,
          resumeCmd("deploy"));
      }
      if (i < maxTries) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!landed) {
      stop("ERROR", "deploy",
        `等待约 ${maxTries * 3} 秒后，${mr.gl_project_path} 的 ${state.f_branch} 分支仍未包含合并提交 ${mr.merged_sha}（${mr.web_url}）。为避免无效接测已中止部署，请确认合并状态后续跑`,
        resumeCmd("deploy"));
    }
  }
  // 留出短暂缓冲，等待 Mars 侧仓库同步
  await new Promise((r) => setTimeout(r, 3000));
}

async function stepDeploy(env, state) {
  await waitMergeLanded(env, state);
  const results = [];
  for (const t of state.deploy_targets) {
    const res = yunke(["mars-branch-deploy-branch", "--app_branch_id", String(state.app_branch_id), "--env_code", t.env_code]);
    console.log(`\n===== 部署 ${t.env_code}（${t.env_name}）完整输出 =====`);
    console.log((res.stdout || "").trim());
    if (res.stderr && res.stderr.trim()) console.log(`stderr: ${res.stderr.trim().slice(0, 1000)}`);
    results.push({ env_code: t.env_code, env_name: t.env_name, exit_code: res.status });
  }
  const failed = results.filter((r) => r.exit_code !== 0);
  if (failed.length) {
    stop("ERROR", "deploy",
      `以下环境部署命令退出码非 0: ${failed.map((f) => f.env_code).join(", ")}。请阅读上方完整输出判断原因；已成功的环境无需重复部署`,
      resumeCmd("deploy"));
  }
  stepOk("deploy", results.map((r) => `${r.env_code}(exit=${r.exit_code})`).join(", "));
  return results;
}

// ---------- 主流程 ----------
(async () => {
  const env = envCheck();
  const fromIdx = STEPS.indexOf(opts.from);
  let state = loadState(env);

  if (fromIdx > STEPS.indexOf("plan") && !state) {
    stop("ERROR", opts.from, "缺少状态文件（.git/ship-to-test-state.json），无法断点续跑，请去掉 --from 完整执行");
  }

  if (fromIdx <= STEPS.indexOf("sync")) stepSync();
  if (fromIdx <= STEPS.indexOf("plan")) state = stepPlan(env);

  if (opts.dryRun) {
    console.log("\nSTATUS: OK");
    console.log("DETAIL: dry-run 结束（未创建 MR / 合并 / 部署）");
    return;
  }

  if (fromIdx <= STEPS.indexOf("create")) await stepCreate(env, state);
  if (fromIdx <= STEPS.indexOf("merge")) await stepMerge(env, state);
  const deployResults = await stepDeploy(env, state);

  console.log("\nSTATUS: OK");
  console.log("SUMMARY:");
  console.log(JSON.stringify({
    branch: `${state.dev_branch} → ${state.f_branch}`,
    merged_mrs: state.mrs.map((m) => m.web_url),
    audit_user: `${state.audit_user_name}（${state.audit_user}, 来源: ${state.audit_user_source}）`,
    deploys: deployResults,
  }, null, 2));
  if (state.ask_register_global) {
    const g = state.ask_register_global;
    console.log(`ASK_REGISTER_GLOBAL: 本次新增了审核人 ${g.real_name}（${g.user_name}），询问用户是否将其注册为 * 级（所有项目通用）审核人；同意则执行: node "${__filename}" register-global ${g.user_name}`);
  }
})();
