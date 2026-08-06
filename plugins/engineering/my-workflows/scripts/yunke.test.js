const test = require("node:test");
const assert = require("node:assert/strict");

const { isUnsupportedEnv, yunkeAction, yunkeJson, yunkeText } = require("./yunke.js");

// 假 yunke-cli：只按调用方给的退出码/输出回放，不碰真实 CLI
function fakeRun({ status = 0, stdout = "", stderr = "" }) {
  return () => ({ status, stdout, stderr });
}
function mcp(...texts) {
  return JSON.stringify({ content: texts.map((text) => ({ type: "text", text })) });
}

test("unwraps the MCP envelope and falls back to raw output", () => {
  assert.equal(yunkeText({ stdout: mcp("第一段", "第二段") }), "第一段\n第二段");
  assert.equal(yunkeText({ stdout: "  不是 JSON  " }), "不是 JSON");
  assert.equal(yunkeText({ stdout: '{"structuredContent":{}}' }), '{"structuredContent":{}}');
});

test("treats exit code 0 with failure wording as a failure", () => {
  for (const text of [
    "❌ 部署失败",
    "失败仓库: group/project 创建mr失败",
    "创建 MR 失败",
    "操作失败：接口请求失败",
    '{"success": false}',
    "statusCode: 500",
    "当前用户无权限操作该应用",
    "部分成功：1/2 仓库已合并",
  ]) {
    const out = yunkeAction([], fakeRun({ stdout: mcp(text) }));
    assert.equal(out.ok, false, `应判为失败: ${text}`);
    assert.equal(out.unsure, false, `应是确定失败而非无法判定: ${text}`);
    assert.match(out.reason, /退出码为 0，但输出包含失败信息/);
  }
});

test("does not read a partial success as success", () => {
  // 「未成功/部分成功」都含「成功」二字，失败判定必须排在成功判定之前
  assert.equal(yunkeAction([], fakeRun({ stdout: mcp("接测未成功") })).ok, false);
  assert.equal(yunkeAction([], fakeRun({ stdout: mcp("✅ 接测成功") })).ok, true);
});

test("reports an undecidable output as unsure instead of success", () => {
  const out = yunkeAction([], fakeRun({ stdout: mcp("已受理，请稍后在 Mars 查看") }));

  assert.deepEqual({ ok: out.ok, unsure: out.unsure }, { ok: false, unsure: true });
  assert.match(out.reason, /无法判定结果/);
});

test("keeps a non-zero exit code a definite failure", () => {
  const out = yunkeAction([], fakeRun({ status: 1, stdout: "", stderr: "connection refused" }));

  assert.deepEqual({ ok: out.ok, unsure: out.unsure }, { ok: false, unsure: false });
  assert.match(out.reason, /命令退出码 1/);
  assert.match(out.reason, /connection refused/);
});

test("classifies platform refusals so they are never retried", () => {
  const out = yunkeAction([], fakeRun({ stdout: mcp("❌ 不支持的环境") }));

  assert.equal(out.ok, false);
  assert.equal(isUnsupportedEnv(out.text), true);
  assert.equal(isUnsupportedEnv("该应用只支持灰度环境接测"), true);
  assert.equal(isUnsupportedEnv("✅ 接测成功"), false);
  assert.equal(isUnsupportedEnv(undefined), false);
});

test("returns query failures instead of throwing or exiting", () => {
  assert.deepEqual(
    yunkeJson([], fakeRun({ stdout: '{"structuredContent":{"items":[1]}}' })).json,
    { structuredContent: { items: [1] } },
  );

  const broken = yunkeJson(["mars-branch-query-branch-status"], fakeRun({ stdout: "not json" }));
  assert.equal(broken.ok, false);
  assert.equal(broken.json, null);
  assert.match(broken.reason, /不是合法 JSON/);

  const failed = yunkeJson(["mars-branch-query-branch-status"], fakeRun({ status: 2, stderr: "boom" }));
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /mars-branch-query-branch-status 退出码 2/);
  assert.match(failed.reason, /boom/);
});
