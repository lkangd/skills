#!/usr/bin/env node
// ship-to-test workflow 的 yunke-cli 查询包装器。
// 由脚本直接调用 yunke-cli 并只输出精简 JSON，避免庞大的原始返回进入 LLM 上下文。
//
// 用法:
//   node ship-to-test-query.js branch-status <f分支名> <项目目录名>
//   node ship-to-test-query.js repositories <app_branch_id>
//   node ship-to-test-query.js applications <service_name>
//   node ship-to-test-query.js users <product_id> [keyword]
//
// 退出码: 0 成功; 1 命令执行/解析失败; 2 未匹配到目标（需要用户介入）。

const { spawnSync } = require("node:child_process");

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function runCli(args) {
  const res = spawnSync("yunke-cli", ["devops", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) fail(`yunke-cli 执行失败: ${res.error.message}`);
  if (res.status !== 0) {
    fail(
      `yunke-cli 退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, 2000)}`
    );
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    fail(`yunke-cli 输出不是合法 JSON:\n${res.stdout.slice(0, 2000)}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "branch-status") {
  // 查询分支状态，过滤出「env_code 含 test 且 app_name 被项目目录名包含」的接测目标。
  const [branchName, dirName] = rest;
  if (!branchName || !dirName) {
    fail("用法: branch-status <f分支名> <项目目录名>");
  }
  const json = runCli([
    "mars-branch-query-branch-status",
    "--branch_name",
    branchName,
  ]);
  const items = (json.structuredContent && json.structuredContent.items) || [];
  if (!items.length) fail(`分支状态查询无结果（关键字: ${branchName}）`, 2);

  let pool = items.filter((i) => i.full_branch_name === branchName);
  if (!pool.length) pool = items;

  const testItems = pool.filter((i) => /test/i.test(i.env_code));
  let hits = testItems.filter((i) => dirName.includes(i.app_name));
  if (hits.length) {
    // 多个 app_name 命中时取最长匹配（如 fe-xxx 与 xxx 同时被目录名包含）
    const maxLen = Math.max(...hits.map((i) => i.app_name.length));
    hits = hits.filter((i) => i.app_name.length === maxLen);
  }

  if (!hits.length) {
    out({
      matched: false,
      reason: "没有 app_name 能被项目目录名包含的接测（test）环境条目，请让用户确认目标应用",
      branch_names: [...new Set(pool.map((i) => i.full_branch_name))],
      candidate_apps: [...new Set(testItems.map((i) => i.app_name))],
    });
    process.exit(2);
  }

  out({
    matched: true,
    full_branch_name: hits[0].full_branch_name,
    branch_id: hits[0].branch_id,
    app_branch_id: hits[0].app_branch_id,
    app_name: hits[0].app_name,
    deploy_targets: hits.map((i) => ({
      env_code: i.env_code,
      env_name: i.env_name,
      pipeline_status: i.pipeline_status,
    })),
  });
} else if (cmd === "repositories") {
  // 查询可建 MR 的仓库，并从仓库 URL 提取 service_name（最后一段路径名）。
  const [appBranchId] = rest;
  if (!appBranchId) fail("用法: repositories <app_branch_id>");
  const json = runCli([
    "mars-branch-query-repositories",
    "--app_branch_id",
    appBranchId,
  ]);
  const text =
    (json.content && json.content[0] && json.content[0].text) || "[]";
  let repos;
  try {
    repos = JSON.parse(text);
  } catch {
    fail(`仓库列表解析失败，原始 text:\n${text.slice(0, 1000)}`);
  }
  if (!Array.isArray(repos) || !repos.length) {
    fail(`应用分支 ${appBranchId} 未查询到仓库`, 2);
  }
  out({
    repositories: repos.map((url) => ({
      repository: url,
      service_name: url.replace(/\/+$/, "").split("/").pop(),
    })),
  });
} else if (cmd === "applications") {
  // 通过 service_name 查询应用，提取 product_id。
  const [serviceName] = rest;
  if (!serviceName) fail("用法: applications <service_name>");
  const json = runCli([
    "mars-branch-query-applications",
    "--service_name",
    serviceName,
  ]);
  const items = (json.structuredContent && json.structuredContent.items) || [];
  if (!items.length) fail(`未查询到应用（service_name: ${serviceName}）`, 2);
  out({
    total: items.length,
    items: items.map((i) => ({
      app_id: i.id,
      product_id: i.product_id,
      product_name: i.product_name,
      service_name: i.service_name,
      service_namespace: i.service_namespace,
    })),
  });
} else if (cmd === "users") {
  // 查询可选审核人；可选 keyword 在本地按 user_name / real_name 过滤。
  const [productId, keyword] = rest;
  if (!productId) fail("用法: users <product_id> [keyword]");
  const json = runCli([
    "mars-branch-query-branch-users",
    "--product_id",
    productId,
    "--ignore_app_members",
    "true",
  ]);
  let items = (json.structuredContent && json.structuredContent.items) || [];
  if (!items.length) fail(`未查询到可选审核人（product_id: ${productId}）`, 2);
  const total = items.length;
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(
      (i) =>
        (i.user_name || "").toLowerCase().includes(kw) ||
        (i.real_name || "").includes(keyword)
    );
  }
  out({
    total,
    matched: items.length,
    items: items.map((i) => ({
      user_name: i.user_name,
      real_name: i.real_name,
      roles: i.roles,
    })),
  });
} else {
  fail(
    "未知子命令。可用: branch-status | repositories | applications | users"
  );
}
