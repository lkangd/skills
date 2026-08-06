// yunke-cli 适配层：所有「yunke-cli 这个外部工具怎么说话」的知识只登记在这一个文件里。
//
// 为什么需要它：yunke-cli 是 MCP 工具的 CLI 包装，业务失败时退出码仍然是 0，真正的
// 结果只出现在 MCP 结果信封的 content[].text 文本里（例如「失败仓库: ... 创建mr失败」
// 「❌ 不支持的环境」）。因此调用方必须做文本级失败检测，而这套「措辞 → 成败」的映射
// 是随上游措辞漂移的开放列表：把它散在业务脚本里，新增一种失败措辞就要改多处，
// 漏改的那处会静默把失败读成 unsure 甚至成功。
//
// 调用方只消费结构化结果，不再自己写正则：
//   ensureInstalled()            → { ok, reason }
//   yunkeAction(args)            → { ok, unsure, text, res, reason }
//   yunkeJson(args)              → { ok, json, text, res, reason }
//   isUnsupportedEnv(text)       → 平台侧「该环境不支持接测」，重试永远不会成功
//
// 上游若将来提供了结构化失败输出（业务失败时退出码非 0，或结果里带 success/error
// 字段），首选改这里的判定逻辑，把下面这套正则退化成兜底。

const { spawnSync } = require("node:child_process");

const CLI = "yunke-cli";
const INSTALL_REGISTRY = "https://registry-npm.myscrm.cn/repository/yunke/";

// 平台侧「该环境不支持接测」的措辞：既是失败标记，也用于把这类失败单独归类
// （重试永远不会成功，只能由用户决定跳过）。两处共用一个正则，避免分类规则漂移。
const UNSUPPORTED_ENV_RE = /不支持的环境|不支持接测|只支持/;

// 动作类命令（创建 MR / 部署）的失败标记：这些命令失败时退出码仍是 0。
// 只匹配「命令执行失败」类措辞，不能匹配业务数据里的正常词（如 pipeline_status: 发布失败）。
// 注意「未成功/不成功/部分成功」必须排在成功判定之前：它们都包含「成功」二字，
// 只靠 OK_MARKERS 的 /成功/ 会把失败读成成功——这正是这套标记表要根除的那类误判。
// 新增一种失败措辞时，只需要往这个列表里加一条。
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

const MAX_DETAIL = 2000;

function spawn(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // 可执行文件不存在等 spawn 层错误：按「命令没跑起来」处理，交给调用方判定
  if (res.error) return { status: 127, stdout: "", stderr: res.error.message };
  return res;
}

// 直接执行 yunke-cli devops <args>，不做任何成败判定（原始出口，供特殊场景使用）
function yunke(args) {
  return spawn(CLI, ["devops", ...args]);
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

function isUnsupportedEnv(text) {
  return UNSUPPORTED_ENV_RE.test(text || "");
}

// 返回 { ok, unsure, text, res, reason }：ok=false 表示确定失败，unsure 表示既没有失败标记
// 也没有成功标记，无法判断，交给 agent/用户人工确认，绝不静默当成功。
// runFn 只为离线测试注入假 yunke-cli 而存在，生产路径永远走真实 CLI。
function yunkeAction(args, runFn = yunke) {
  const res = runFn(args);
  const text = yunkeText(res);
  if (res.status !== 0) {
    return { ok: false, unsure: false, text, res, reason: `命令退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, MAX_DETAIL)}` };
  }
  const failed = FAIL_MARKERS.find((re) => re.test(text));
  if (failed) {
    return { ok: false, unsure: false, text, res, reason: `命令退出码为 0，但输出包含失败信息（匹配 ${failed}）:\n${text.slice(0, MAX_DETAIL)}` };
  }
  if (!OK_MARKERS.some((re) => re.test(text))) {
    return { ok: false, unsure: true, text, res, reason: `输出中既无成功标记也无失败标记，无法判定结果:\n${text.slice(0, MAX_DETAIL)}` };
  }
  return { ok: true, unsure: false, text, res };
}

// 查询类命令：只需要拿到 JSON 负载。失败时返回 ok:false + 可直接展示的 reason，
// 由调用方决定如何中止（适配层不认识业务的 STATUS/STEP 协议）。
function yunkeJson(args, runFn = yunke) {
  const res = runFn(args);
  const text = yunkeText(res);
  if (res.status !== 0) {
    return {
      ok: false, json: null, text, res,
      reason: `${CLI} devops ${args.join(" ")} 退出码 ${res.status}:\n${(res.stderr || res.stdout || "").slice(0, MAX_DETAIL)}`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(res.stdout), text, res };
  } catch {
    return { ok: false, json: null, text, res, reason: `${CLI} 输出不是合法 JSON:\n${(res.stdout || "").slice(0, MAX_DETAIL)}` };
  }
}

function installed() {
  return spawn(CLI, ["--help"]).status !== 127;
}

// 未安装时自动安装。返回 { ok, installed, reason }：installed=true 表示本次执行过安装。
// onInstall 在开始安装前调用（npm 安装很慢，调用方需要先给用户一行提示）。
function ensureInstalled(onInstall = () => {}) {
  if (installed()) return { ok: true, installed: false };
  onInstall();
  const install = spawn("npm", ["install", "-g", "@yunke/yunke-cli@latest", "--registry", INSTALL_REGISTRY]);
  if (install.status !== 0 || !installed()) {
    return {
      ok: false,
      installed: false,
      reason: `${CLI} 自动安装失败，请让用户手动安装后继续:\n${(install.stderr || install.stdout || "").slice(0, 1000)}`,
    };
  }
  return { ok: true, installed: true };
}

module.exports = {
  CLI,
  FAIL_MARKERS,
  OK_MARKERS,
  UNSUPPORTED_ENV_RE,
  ensureInstalled,
  isUnsupportedEnv,
  yunke,
  yunkeAction,
  yunkeJson,
  yunkeText,
};
