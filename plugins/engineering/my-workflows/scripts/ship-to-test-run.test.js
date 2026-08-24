const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyMergedMrInfo,
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
  normalizeRunState,
  parseMarsDeployMerge,
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
} = require("./ship-to-test-run.js");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RUN_ENV = {
  devBranch: "dev-f-topic",
  fBranch: "f-topic",
  origin: "git@example:group/project.git",
};

function runState(overrides = {}) {
  return {
    schema_version: 2,
    run_head_sha: "head-1",
    dev_branch: "dev-f-topic",
    f_branch: "f-topic",
    origin: "git@example:group/project.git",
    resume_from: "deploy",
    ...overrides,
  };
}

function deploymentRecord(repositories) {
  return {
    env_code: "yktest",
    env_name: "云客测试环境",
    env_branch: "test",
    status: "verifying",
    trigger_status: "accepted",
    verification_status: "pending",
    repositories,
  };
}

function repository(projectPath, targetSha, targetPresentBefore = false) {
  return {
    project_path: projectPath,
    proj_base: `https://git.example/api/v4/projects/${encodeURIComponent(projectPath)}`,
    env_branch: "test",
    f_branch: "f-topic",
    target_sha: targetSha,
    baseline_branch_sha: "old-test-tip",
    target_present_before: targetPresentBefore,
    observed_branch_sha: "old-test-tip",
    verified_at: null,
    last_error: null,
  };
}

test("filters merge requests by this round's exact head SHA", () => {
  const mrs = [
    { iid: 1, sha: "old" },
    { iid: 2, sha: "expected" },
    { iid: 3, diff_refs: { head_sha: "expected" } },
  ];

  assert.deepEqual(filterMrsForExpectedSha(mrs, "expected").map((mr) => mr.iid), [2, 3]);
});

test("uses the target-side merge commit instead of an existing source ancestor", async () => {
  const calls = [];
  const mr = {
    gl_host: "https://git.example",
    gl_project_path: "group/project",
    expected_sha: "source",
    merge_commit_sha: "merge",
  };

  const unresolved = await resolveTargetShaOnBranch(mr, "f-topic", async (_base, sha) => {
    calls.push(sha);
    return { on: sha === "source" };
  });

  assert.deepEqual(unresolved, { missing: true });
  assert.deepEqual(calls, ["merge"]);
});

test("resolves normal merge and squash target SHAs", async () => {
  const normal = {
    gl_host: "https://git.example",
    gl_project_path: "group/normal",
    expected_sha: "source-normal",
    merge_commit_sha: "merge-normal",
  };
  const squash = {
    gl_host: "https://git.example",
    gl_project_path: "group/squash",
    expected_sha: "source-squash",
    squash_commit_sha: "squash-target",
  };

  assert.deepEqual(
    await resolveTargetShaOnBranch(normal, "f-topic", async (_base, sha) => ({ on: sha === "merge-normal" })),
    { sha: "merge-normal", kind: "merge_commit" },
  );
  assert.deepEqual(
    await resolveTargetShaOnBranch(squash, "f-topic", async (_base, sha) => ({ on: sha === "squash-target" })),
    { sha: "squash-target", kind: "squash_commit" },
  );
});

test("accepts a source SHA as fast-forward only when it is the target branch tip", async () => {
  const mr = {
    gl_host: "https://git.example",
    gl_project_path: "group/project",
    expected_sha: "source",
  };
  const containedAsAncestor = async () => ({ on: true });

  assert.deepEqual(
    await resolveTargetShaOnBranch(mr, "f-topic", containedAsAncestor, async () => ({ sha: "newer-merge" })),
    { missing: true },
  );
  assert.deepEqual(
    await resolveTargetShaOnBranch(mr, "f-topic", containedAsAncestor, async () => ({ sha: "source" })),
    { sha: "source", kind: "source_fast_forward" },
  );
});

test("does not verify when Mars first advances test with the stale f tip", async () => {
  const record = deploymentRecord({
    "ai-sale/inquiries": repository("ai-sale/inquiries", "fd0bfd80"),
  });
  const observations = [
    { on: false, branch_sha: "4963b315" },
    { on: false, branch_sha: "4963b315" },
    { on: true, branch_sha: "420b13f9" },
  ];
  const statuses = [];
  let checks = 0;

  const result = await pollDeploymentVerification(record, {
    maxTries: 3,
    intervalMs: 0,
    sleepFn: async () => {},
    nowFn: () => "2026-08-05T14:19:29.000Z",
    checkFn: async () => observations[checks++],
    onProgress: async (current) => statuses.push(current.status),
  });

  assert.equal(result.verified, true);
  assert.deepEqual(statuses, ["verifying", "verifying", "verified"]);
  assert.equal(record.verification_attempts, 3);
  assert.equal(record.verification_mode, "observed_after_trigger");
  assert.equal(record.repositories["ai-sale/inquiries"].observed_branch_sha, "420b13f9");
});

function emptyMrState() {
  return { f_branch: "f-topic" };
}

function emptyMr() {
  return {
    gl_host: "https://git.example",
    gl_project_path: "group/project",
    iid: 42,
    web_url: "https://git.example/group/project/-/merge_requests/42",
    state: "opened",
    expected_sha: "c60affe123",
  };
}

// 用一个假的 GitLab：commit refs 决定「本轮提交在不在 f 上」，PUT 记录关闭动作
function gitlabStub({ onTargetBranch, closeStatus = 200 }) {
  const calls = [];
  return {
    calls,
    fetchFn: async (url, method = "GET") => {
      calls.push(`${method} ${url}`);
      if (url.includes("/repository/commits/")) {
        return { status: 200, body: onTargetBranch ? [{ name: "f-topic" }] : [{ name: "dev-f-topic" }] };
      }
      if (url.includes("state_event=close")) {
        return { status: closeStatus, body: closeStatus === 200 ? { state: "closed" } : { message: "403 Forbidden" } };
      }
      throw new Error(`未预期的请求: ${method} ${url}`);
    },
  };
}

// stepMerge 关闭前刚取回的 MR 实况
function mrBody(sha = "c60affe123") {
  return { state: "opened", sha, detailed_merge_status: "commits_status" };
}

test("closes an MR that has nothing left to merge and keeps the pipeline going", async () => {
  const mr = emptyMr();
  const gitlab = gitlabStub({ onTargetBranch: true });

  assert.deepEqual(
    await closeMrWithNothingToMerge(emptyMrState(), mr, mrBody(), gitlab.fetchFn),
    { empty: true, closed: true },
  );
  assert.equal(mr.state, "closed");
  assert.equal(mr.close_error, null);
  assert.equal(mr.already_on_target, true);
  assert.equal(isSettledMr(mr), true, "空 MR 关闭后允许继续 deploy");
  assert.match(mr.closed_reason, /已经在 f-topic 上/);
  assert.ok(gitlab.calls.some((call) => call === "PUT https://git.example/api/v4/projects/group%2Fproject/merge_requests/42?state_event=close"));
  // 要在测试分支上验证的就是本轮提交本身
  assert.deepEqual(targetShaCandidates(mr), [{ sha: "c60affe123", kind: "already_on_target" }]);
  assert.deepEqual(
    await resolveTargetShaOnBranch(mr, "test", async (_base, sha) => ({ on: sha === "c60affe123" })),
    { sha: "c60affe123", kind: "already_on_target" },
  );
});

test("never closes an MR whose commit has not reached the target branch", async () => {
  const mr = emptyMr();
  const gitlab = gitlabStub({ onTargetBranch: false });

  assert.deepEqual(
    await closeMrWithNothingToMerge(emptyMrState(), mr, mrBody(), gitlab.fetchFn),
    { empty: false },
  );
  assert.equal(mr.state, "opened");
  assert.equal(mr.already_on_target, undefined);
  assert.equal(isSettledMr(mr), false, "合不了又没落地的 MR 必须停下来报错");
  assert.equal(gitlab.calls.filter((call) => call.includes("state_event=close")).length, 0);
});

test("never closes an MR whose head moved past this round's commit", async () => {
  const gitlab = gitlabStub({ onTargetBranch: true });

  // 有人往同一 dev 分支又推了提交：MR 里装着还没合并的东西，关掉等于把它们悄悄丢掉
  const advanced = emptyMr();
  assert.deepEqual(
    await closeMrWithNothingToMerge(emptyMrState(), advanced, mrBody("deadbeef99"), gitlab.fetchFn),
    { empty: false, head_moved: "deadbeef99" },
  );
  // 连当前 head 都读不到时同样不能关
  const unreadable = emptyMr();
  assert.deepEqual(
    await closeMrWithNothingToMerge(emptyMrState(), unreadable, "502 Bad Gateway", gitlab.fetchFn),
    { empty: false, head_moved: null },
  );

  for (const mr of [advanced, unreadable]) {
    assert.equal(mr.already_on_target, undefined);
    assert.equal(isSettledMr(mr), false);
  }
  assert.deepEqual(gitlab.calls, [], "证明不了就一个请求都不该发出去");
});

test("keeps going but reports it when the close call itself fails", async () => {
  const mr = emptyMr();
  const gitlab = gitlabStub({ onTargetBranch: true, closeStatus: 403 });

  assert.deepEqual(
    await closeMrWithNothingToMerge(emptyMrState(), mr, mrBody(), gitlab.fetchFn),
    { empty: true, closed: false },
  );
  assert.equal(mr.state, "opened", "GitLab 侧没关掉就不能记成 closed");
  assert.match(mr.close_error, /关闭 MR !42 失败 HTTP 403/);
  assert.equal(isSettledMr(mr), true, "代码已在 f 上，关不掉不影响后续接测");
});

test("verifies an already-landed commit by containment, not by branch tip", async () => {
  // create 那条「未找到 MR 记录但提交已在 f 上」的记录：没有目标侧 merge/squash 可用，
  // 若退回 source_fast_forward 就会要求 f 的 tip 恰好等于它——上一轮合并过之后永不成立。
  const landed = {
    gl_host: "https://git.example",
    gl_project_path: "group/project",
    expected_sha: "c60affe123",
    merged_sha: "c60affe123",
    already_on_target: true,
  };

  assert.deepEqual(targetShaCandidates(landed), [{ sha: "c60affe123", kind: "already_on_target" }]);
  assert.deepEqual(
    await resolveTargetShaOnBranch(landed, "f-topic",
      async (_base, sha) => ({ on: sha === "c60affe123" }),
      async () => assert.fail("不应退回 tip 判定")),
    { sha: "c60affe123", kind: "already_on_target" },
  );
});

test("recognizes only this f branch's ship-to-test merge on the environment branch", () => {
  // 线上真实标题（f-20260820-script-strategy-2 那次空接测）
  assert.deepEqual(
    parseMarsDeployMerge(
      "Merge branch 'temp-5025fb49-f-20260820-script-strategy-2-test' into 'test'",
      "f-20260820-script-strategy-2", "test"),
    { temp_branch: "temp-5025fb49-f-20260820-script-strategy-2-test", source_sha: "5025fb49" },
  );
  // 另一条分支的接测、名字前缀相同的分支、以及普通提交都不能算成自己的
  for (const title of [
    "Merge branch 'temp-5c3fbafa-f-20260727-copy-shop-config-test' into 'test'",
    "Merge branch 'temp-5025fb49-f-20260820-script-strategy-22-test' into 'test'",
    "Merge branch 'temp-8ff737e0-master-f-20260820-script-strategy-2' into 'f-20260820-script-strategy-2'",
    "feat: 普通提交",
  ]) {
    assert.equal(parseMarsDeployMerge(title, "f-20260820-script-strategy-2", "test"), null, title);
  }
});

test("flags a finished deployment that shipped the pre-merge f tip", async () => {
  const repo = { ...repository("group/project", "41f45411"), baseline_branch_sha: "23c3ef03" };
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return {
      status: 200,
      body: {
        commits: [
          { id: "5025fb49", title: "Merge branch 'temp-8ff737e0-master-f-topic' into 'f-topic'" },
          { id: "ca79fb16", title: "Merge branch 'temp-5025fb49-f-topic-test' into 'test'" },
        ],
      },
    };
  };

  assert.deepEqual(await findStaleDeploy(repo, "ca79fb16", fetchFn), {
    stale: { deploy_commit: "ca79fb16", temp_branch: "temp-5025fb49-f-topic-test", source_sha: "5025fb49" },
  });
  assert.match(urls[0], /repository\/compare\?from=23c3ef03&to=test$/);
});

test("does not call GitLab for a stale deployment before a baseline exists", async () => {
  const noBaseline = { ...repository("group/project", "target"), baseline_branch_sha: null };
  const onlyOthers = { ...repository("group/project", "target"), baseline_branch_sha: "base" };
  const refuse = async () => assert.fail("不应发起请求");

  assert.deepEqual(await findStaleDeploy(noBaseline, "tip", refuse), {});
  // 分支自基线以来没动过 ⇒ 没有新提交可查，不必每 10 秒 compare 一次
  assert.deepEqual(await findStaleDeploy(onlyOthers, "base", refuse), {});
  assert.deepEqual(
    await findStaleDeploy(onlyOthers, "moved", async () => ({
      status: 200,
      body: { commits: [{ id: "x", title: "Merge branch 'temp-abc12345-f-other-test' into 'test'" }] },
    })),
    {},
  );
});

test("stops polling and asks for a retrigger once a stale deployment is proven", async () => {
  const record = deploymentRecord({ "group/project": repository("group/project", "target") });
  const stale = { deploy_commit: "ca79fb16", temp_branch: "temp-5025fb49-f-topic-test", source_sha: "5025fb49" };
  let checks = 0;

  const result = await pollDeploymentVerification(record, {
    maxTries: 10,
    intervalMs: 0,
    sleepFn: async () => {},
    nowFn: () => "2026-08-24T03:04:00.000Z",
    checkFn: async () => (++checks < 2
      ? { on: false, branch_sha: "23c3ef03" }
      : { on: false, branch_sha: "ca79fb16", stale }),
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.stale, [{
    ...stale, project_path: "group/project", detected_at: "2026-08-24T03:04:00.000Z",
  }]);
  assert.equal(checks, 2, "证实旧快照后不应继续空等");
  assert.equal(record.status, "stale_deploy");
  assert.equal(record.verification_status, "stale_deploy");
  // 这是唯一允许重复调用接测命令的状态
  assert.equal(deploymentActionFor(record), "trigger");
});

test("reports every repository that shipped a stale snapshot, not just the first", async () => {
  const record = deploymentRecord({
    "group/a": repository("group/a", "target-a"),
    "group/b": repository("group/b", "target-b"),
  });

  const result = await pollDeploymentVerification(record, {
    maxTries: 1,
    intervalMs: 0,
    sleepFn: async () => {},
    nowFn: () => "2026-08-24T03:04:00.000Z",
    checkFn: async (repo) => ({
      on: false,
      branch_sha: "moved",
      stale: { deploy_commit: `deploy-${repo.project_path}`, temp_branch: "t", source_sha: "old" },
    }),
  });

  assert.deepEqual(result.stale.map((stale) => stale.project_path), ["group/a", "group/b"]);
});

test("still retriggers when the process died mid-retrigger, before the trigger was accepted", () => {
  // 重触发的基线取在旧快照合并之后，只验证的话那次旧快照永远检测不到 → 会卡死
  assert.equal(
    deploymentActionFor({ status: "triggering", trigger_status: "pending", stale_deploys: [{ source_sha: "old" }] }),
    "trigger",
  );
  // 没有旧快照证据的 triggering 仍然只验证，不重复触发
  assert.equal(deploymentActionFor({ status: "triggering", trigger_status: "pending", stale_deploys: [] }), "verify");
  assert.equal(deploymentActionFor({ status: "verifying", trigger_status: "accepted" }), "verify");
});

// triggerAndVerify 会落盘状态文件，给它一个临时 git 目录
function deployEnv() {
  return { gitDir: fs.mkdtempSync(path.join(os.tmpdir(), "ship-to-test-")) };
}

function deployState() {
  return {
    run_head_sha: "head-1",
    f_branch: "f-topic",
    app_branch_id: 1,
    mrs: [{
      gl_host: "https://git.example", gl_project_path: "group/project",
      target_sha: "target", merged_at: "2000-01-01T00:00:00.000Z",
    }],
    deploy_results: {},
  };
}

function deployDeps(overrides) {
  return {
    sleepFn: async () => {},
    nowFn: () => "2026-08-24T03:04:00.000Z",
    baselineFn: async () => ({
      all_present: false,
      repositories: { "group/project": repository("group/project", "target") },
    }),
    ...overrides,
  };
}

const acceptedTrigger = { accepted: true, possiblyAccepted: false, unsupported: false, out: { res: { status: 0 }, reason: "" } };
const staleObserved = [{ deploy_commit: "ca79fb16", temp_branch: "t", source_sha: "5025fb49" }];

test("retriggers after a proven stale deployment and stops once verified", async () => {
  const target = { env_code: "yktest", env_name: "测试" };
  const state = deployState();
  const triggers = [];
  let polls = 0;

  const record = await triggerAndVerify(deployEnv(), state, target, "test", null, deployDeps({
    triggerFn: () => { triggers.push("fired"); return acceptedTrigger; },
    pollFn: async (rec) => {
      polls++;
      if (polls === 1) { rec.status = "stale_deploy"; return { verified: false, stale: staleObserved }; }
      rec.status = "verified";
      return { verified: true };
    },
  }));

  assert.equal(triggers.length, 2, "证实旧快照后必须重触发一次");
  assert.equal(record.status, "verified");
  assert.equal(record.trigger_attempts, 2);
  assert.equal(record.stale_deploys.length, 1);
  assert.equal(record.stale_deploys[0].attempt, 1);
});

test("stops retriggering at the cap and explains what Mars kept shipping", async () => {
  const target = { env_code: "yktest", env_name: "测试" };
  const state = deployState();
  let triggers = 0;

  const record = await triggerAndVerify(deployEnv(), state, target, "test", null, deployDeps({
    triggerFn: () => { triggers++; return acceptedTrigger; },
    pollFn: async (rec) => { rec.status = "stale_deploy"; return { verified: false, stale: staleObserved }; },
  }));

  assert.equal(triggers, 3, "重触发次数必须有上限");
  assert.equal(record.status, "stale_deploy");
  assert.equal(record.trigger_attempts, 3);
  assert.match(record.reason, /已触发 3 次接测，其中 3 次被证实/);
  assert.match(record.reason, /5025fb49/);
  // 续跑仍会再触发一次，但那是用户按 RESUME 时的显式决定
  assert.equal(deploymentActionFor(record), "trigger");
});

test("a rejected trigger is never followed by verification polling", async () => {
  const target = { env_code: "ykhuawei", env_name: "华为测试" };
  const state = deployState();

  const record = await triggerAndVerify(deployEnv(), state, target, "test", null, deployDeps({
    triggerFn: () => ({
      accepted: false, possiblyAccepted: false, unsupported: true,
      out: { res: { status: 0 }, reason: "❌ 不支持的环境" },
    }),
    pollFn: async () => assert.fail("被拒绝的触发不该进入验证轮询"),
  }));

  assert.equal(record.status, "failed");
  assert.equal(record.unsupported, true);
  assert.equal(deploymentActionFor(record), "blocked");
});

test("does not trust an hours-old accepted trigger after the target changed", () => {
  // 2026-08-24 实测复现：进程被杀死、resume_from 没能落盘 → 整条流水线从 sync 重跑一遍，
  // create 阶段因为空 MR 修复把目标从 41f45411 换成了 c60affe123，指纹因此改变；
  // 3.5 小时前的 03:03 触发被当成「还在跑」，deploy 只验证不重触发，白等满 10 分钟。
  const now = () => Date.parse("2026-08-24T06:32:00.000Z");

  assert.equal(
    shouldCarryOverTrigger({ trigger_status: "accepted", trigger_started_at: "2026-08-24T06:25:00.000Z" }, now),
    true, "同一次运行内几分钟前的触发应该继续只验证",
  );
  assert.equal(
    shouldCarryOverTrigger({ trigger_status: "accepted", trigger_started_at: "2026-08-24T03:03:15.437Z" }, now),
    false, "3.5 小时前的旧触发不该被当成还在跑",
  );
  assert.equal(
    shouldCarryOverTrigger({ trigger_status: "rejected", trigger_started_at: "2026-08-24T06:31:00.000Z" }, now),
    false, "被拒绝的触发本来就不该被继承",
  );
  assert.equal(
    shouldCarryOverTrigger({ trigger_status: "accepted", trigger_started_at: null }, now),
    false, "没有触发时刻就没法证明它还新鲜",
  );
});

test("waits out the Mars snapshot window only while the merge is fresh", async () => {
  const slept = [];
  const sleepFn = async (ms) => slept.push(ms);
  const state = (mergedAt) => ({ mrs: [{ merged_at: mergedAt }] });
  const now = Date.parse("2026-08-24T03:03:15.000Z");

  // 刚合并 1.4 秒就触发，正是线上那次空接测的时序
  assert.ok(await waitForMarsToSeeMerge(state("2026-08-24T03:03:14.000Z"), sleepFn, () => now) > 0);
  assert.equal(slept.length, 1);
  // 续跑时合并已经过去很久，不该再等
  assert.equal(await waitForMarsToSeeMerge(state("2026-08-24T02:30:00.000Z"), sleepFn, () => now), 0);
  // 拿不到合并时刻时按「刚刚合并」处理
  assert.ok(await waitForMarsToSeeMerge(state(null), sleepFn, () => now) > 0);
  assert.equal(slept.length, 2);
  // 本轮只有「上一轮就合过」的空 MR，没有新合并可等
  assert.equal(
    await waitForMarsToSeeMerge({ mrs: [{ already_on_target: true }] }, sleepFn, () => now),
    0,
  );
  assert.equal(slept.length, 2);
});

test("keeps an accepted trigger in verifying state after timeout", async () => {
  const record = deploymentRecord({
    "group/project": repository("group/project", "target"),
  });

  const result = await pollDeploymentVerification(record, {
    maxTries: 2,
    intervalMs: 0,
    sleepFn: async () => {},
    nowFn: () => "2026-08-05T14:20:00.000Z",
    checkFn: async () => ({ on: false, branch_sha: "unrelated-tip" }),
  });

  assert.equal(result.verified, false);
  assert.equal(record.status, "verifying");
  assert.equal(record.verification_status, "pending");
  assert.equal(deploymentActionFor(record), "verify");
});

test("requires every repository in an app branch to contain its target", async () => {
  const record = deploymentRecord({
    "group/a": repository("group/a", "target-a"),
    "group/b": repository("group/b", "target-b"),
  });
  const calls = { "group/a": 0, "group/b": 0 };

  const result = await pollDeploymentVerification(record, {
    maxTries: 2,
    intervalMs: 0,
    sleepFn: async () => {},
    nowFn: () => "2026-08-05T14:19:29.000Z",
    checkFn: async (repo) => {
      calls[repo.project_path]++;
      return {
        on: repo.project_path === "group/a" || calls[repo.project_path] > 1,
        branch_sha: `tip-${calls[repo.project_path]}`,
      };
    },
  });

  assert.equal(result.verified, true);
  assert.equal(record.verification_attempts, 2);
  assert.equal(calls["group/a"], 2);
  assert.equal(calls["group/b"], 2);
});

test("captures a pre-trigger baseline and detects already-present targets", async () => {
  const state = {
    mrs: [
      { gl_host: "https://git.example", gl_project_path: "group/a", target_sha: "target-a" },
      { gl_host: "https://git.example", gl_project_path: "group/b", target_sha: "target-b" },
    ],
  };

  const baseline = await captureDeploymentBaseline(state, "test", async (repo) => ({
    on: true,
    branch_sha: `tip-${repo.project_path}`,
  }));

  assert.equal(baseline.all_present, true);
  assert.equal(baseline.repositories["https://git.example::group/a"].target_present_before, true);
  assert.equal(baseline.repositories["https://git.example::group/b"].baseline_branch_sha, "tip-group/b");
});

test("keeps repositories with the same path on different GitLab hosts distinct", async () => {
  const state = {
    mrs: [
      { gl_host: "https://git-a.example", gl_project_path: "same/group", target_sha: "target-a" },
      { gl_host: "https://git-b.example", gl_project_path: "same/group", target_sha: "target-b" },
    ],
  };

  const baseline = await captureDeploymentBaseline(state, "test", async (repo) => ({
    on: repo.gl_host === "https://git-b.example",
    branch_sha: `${repo.gl_host}-tip`,
  }));

  assert.equal(Object.keys(baseline.repositories).length, 2);
  assert.equal(baseline.all_present, false);
});

test("changes the deployment fingerprint when the resolved target SHA changes", () => {
  const state = {
    mrs: [{ gl_host: "https://git.example", gl_project_path: "group/a", target_sha: "merge-b" }],
  };
  const record = deploymentRecord({
    "https://git.example::group/a": {
      ...repository("group/a", "source-a"),
      proj_base: "https://git.example/api/v4/projects/group%2Fa",
    },
  });

  assert.notEqual(recordTargetFingerprint(record), deploymentTargetFingerprint(state, "test"));
});

test("produces byte-identical fingerprints from state and from a saved record", () => {
  const state = {
    mrs: [
      { gl_host: "https://git.example", gl_project_path: "group/a", target_sha: "merge-a" },
      { gl_host: "https://git.example", gl_project_path: "group/b", target_sha: "merge-b" },
    ],
  };
  const record = {
    repositories: {
      "https://git.example::group/b": {
        proj_base: "https://git.example/api/v4/projects/group%2Fb",
        env_branch: "test",
        target_sha: "merge-b",
      },
      "https://git.example::group/a": {
        proj_base: "https://git.example/api/v4/projects/group%2Fa",
        env_branch: "test",
        target_sha: "merge-a",
      },
    },
  };

  assert.equal(recordTargetFingerprint(record), deploymentTargetFingerprint(state, "test"));
});

test("reads subsequent commit-ref pages before reporting a target missing", async () => {
  let calls = 0;
  const result = await shaOnBranch("https://git.example/api/v4/projects/x", "target", "test", async (url) => {
    calls++;
    if (new URL(url).searchParams.get("page") === "1") {
      return { status: 200, body: Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}` })) };
    }
    return { status: 200, body: [{ name: "test" }] };
  });

  assert.deepEqual(result, { on: true });
  assert.equal(calls, 2);
});

test("migrates legacy ok deployments to verification without retriggering", () => {
  const state = {
    head_sha: "head-1",
    skipped_envs: [],
    deploy_results: { yktest: { status: "ok" } },
  };

  normalizeRunState(state, [], { skipEnvs: [] });

  assert.equal(state.schema_version, 2);
  assert.equal(state.run_head_sha, "head-1");
  assert.equal(state.deploy_results.yktest.status, "verifying");
  assert.equal(state.deploy_results.yktest.trigger_status, "accepted");
  assert.equal(deploymentActionFor(state.deploy_results.yktest), "verify");
  assert.equal(deploymentActionFor({ status: "verifying", trigger_status: "possibly_accepted" }), "verify");
});

test("never retriggers an environment the platform refuses to ship to", () => {
  assert.equal(deploymentActionFor({ status: "failed", unsupported: true, trigger_status: "rejected" }), "blocked");
  assert.equal(deploymentActionFor({ status: "failed", unsupported: false, trigger_status: "rejected" }), "trigger");
});

test("reconciles an already-merged MR after an interrupted merge request", () => {
  const mr = { iid: 7, expected_sha: "source", state: "opened" };

  assert.deepEqual(applyMergedMrInfo(mr, {
    state: "merged",
    sha: "source",
    merge_commit_sha: "merge-target",
    squash_commit_sha: null,
  }), { ok: true });
  assert.equal(mr.state, "merged");
  assert.equal(mr.merge_commit_sha, "merge-target");
  assert.match(applyMergedMrInfo({ iid: 8, expected_sha: "source" }, { sha: "other" }).error, /不一致/);
});

test("rejects resume state from a different HEAD, branch, or origin", () => {
  const env = {
    devBranch: "dev-f-topic",
    fBranch: "f-topic",
    origin: "git@example:group/project.git",
  };
  const state = {
    run_head_sha: "head-1",
    dev_branch: "dev-f-topic",
    f_branch: "f-topic",
    origin: "git@example:group/project.git",
  };

  assert.equal(stateMatchesRun(env, state, "head-1"), true);
  assert.equal(stateMatchesRun(env, state, "head-2"), false);
  assert.equal(stateMatchesRun({ ...env, devBranch: "dev-f-other" }, state, "head-1"), false);
  assert.equal(stateMatchesRun({ ...env, origin: "git@example:other/project.git" }, state, "head-1"), false);
  assert.equal(stateMatchesRun(env, { ...state, origin: undefined }, "head-1"), false);
});

test("forces a new round when --from deploy meets a changed HEAD", () => {
  const opts = { from: "deploy", restart: false, skipEnvs: [] };

  const sameRun = resolveStartStep(RUN_ENV, runState(), "head-1", opts);
  assert.equal(sameRun.from, "deploy");

  const changedHead = resolveStartStep(RUN_ENV, runState(), "head-2", opts);
  assert.equal(changedHead.from, "sync");
  assert.equal(changedHead.sameRun, false);
  assert.match(changedHead.note, /另一轮/);

  const changedOrigin = resolveStartStep(RUN_ENV, runState({ origin: "git@example:other.git" }), "head-1", opts);
  assert.equal(changedOrigin.from, "sync");
});

test("auto-resumes the recorded step only within the same run", () => {
  const opts = { from: "", restart: false, skipEnvs: [] };

  assert.equal(resolveStartStep(RUN_ENV, runState(), "head-1", opts).from, "deploy");
  assert.equal(resolveStartStep(RUN_ENV, runState({ resume_from: null }), "head-1", opts).from, "sync");
  assert.equal(resolveStartStep(RUN_ENV, null, "head-1", opts).from, "sync");
  assert.equal(
    resolveStartStep(RUN_ENV, runState(), "head-1", { from: "deploy", restart: true, skipEnvs: [] }).from,
    "sync",
  );
});

test("migrates a legacy state so an in-flight trigger is verified, not retriggered", () => {
  const state = {
    head_sha: "head-1",
    dev_branch: "dev-f-topic",
    f_branch: "f-topic",
    deploy_results: {
      yktest: { status: "ok" },
      other: { status: "unknown" },
    },
  };

  normalizeRunState(state, [], { skipEnvs: [] }, RUN_ENV);

  assert.equal(state.origin, RUN_ENV.origin);
  assert.equal(stateMatchesRun(RUN_ENV, state, "head-1"), true);
  assert.equal(state.deploy_results.yktest.trigger_status, "accepted");
  assert.equal(state.deploy_results.other.trigger_status, "possibly_accepted");
  for (const record of Object.values(state.deploy_results)) {
    assert.equal(record.status, "verifying");
    assert.equal(deploymentActionFor(record), "verify");
  }
});

test("builds every deployment record from one shape", () => {
  const target = { env_code: "yktest", env_name: "云客测试环境" };
  const base = newDeployRecord(target, "test");
  const resumed = newDeployRecord(target, "test", { status: "verifying", trigger_status: "accepted" });

  assert.deepEqual(Object.keys(base).sort(), Object.keys(resumed).sort());
  assert.equal(base.status, "triggering");
  assert.equal(deploymentActionFor(resumed), "verify");
});

test("parses resume and skip arguments without executing the CLI", () => {
  const parsed = parseRunOptions(["run", "--from", "deploy", "--skip-env", "yk_huawei_test"]);

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.opts.from, "deploy");
  assert.deepEqual(parsed.opts.skipEnvs, ["yk_huawei_test"]);
  assert.match(parseRunOptions(["run", "--from", "invalid"]).error, /--from/);
});

test("does not invent a source candidate when no target SHA exists", () => {
  assert.deepEqual(targetShaCandidates({}), []);
});

test("accepts both dev-f and dev-bg branches and derives the matching target branch", () => {
  assert.deepEqual(resolveDevBranch("dev-f-20260805-topic"),
    { devBranch: "dev-f-20260805-topic", fBranch: "f-20260805-topic" });
  assert.deepEqual(resolveDevBranch("dev-bg-20260805-topic"),
    { devBranch: "dev-bg-20260805-topic", fBranch: "bg-20260805-topic" });
});

test("rejects branches that are not dev-f-* or dev-bg-*", () => {
  // 空分支名（detached HEAD）、其他前缀、以及缺少分隔符因而无法推导目标分支的形式
  for (const branch of ["", "main", "dev-api-topic", "dev-f", "dev-fixup", "dev-bgtopic", "feature/dev-f-topic"]) {
    const resolved = resolveDevBranch(branch);
    assert.equal(resolved.fBranch, undefined, `分支 ${branch} 不应被接受`);
    assert.match(resolved.error, /dev-f-\* 或 dev-bg-\*/);
  }
});

test("parses per-repo create success and reviewer-missing failures", () => {
  const parsed = parseCreateRepoResults(
    "应用分支 ID：128472\n" +
    "成功仓库：https://git.myscrm.cn/ai-sale/bff-ai-sale-inquries-bg\n" +
    "失败仓库：https://git.myscrm.cn/middletest/prod/330a8c33-668d-43c2-a2a1-aaaac27f4847: 获取审核人Id失败: [liangkd01]用户不存在\n",
  );

  assert.deepEqual(parsed.succeeded, ["https://git.myscrm.cn/ai-sale/bff-ai-sale-inquries-bg"]);
  assert.deepEqual(parsed.failed, [{
    url: "https://git.myscrm.cn/middletest/prod/330a8c33-668d-43c2-a2a1-aaaac27f4847",
    reason: "获取审核人Id失败: [liangkd01]用户不存在",
  }]);
});

test("treats Mars reviewer-id lookup failures as a missing merger", () => {
  assert.equal(isReviewerMissingFailure("获取审核人Id失败: [liangkd01]用户不存在"), true);
  assert.equal(isReviewerMissingFailure("创建mr失败：分支无差异"), false);
});

test("skips non-primary repos whose merger list does not include the reviewer", () => {
  const classified = classifyReviewerMissingRepos(
    [{
      url: "https://git.myscrm.cn/middletest/prod/330a8c33-668d-43c2-a2a1-aaaac27f4847",
      reason: "获取审核人Id失败: [liangkd01]用户不存在",
    }],
    {
      primaryUrl: "https://git.myscrm.cn/ai-sale/bff-ai-sale-inquries-bg",
      auditUser: "liangkd01",
    },
  );

  assert.equal(classified.hard.length, 0);
  assert.equal(classified.skipped.length, 1);
  assert.equal(
    classified.skipped[0].repository,
    "https://git.myscrm.cn/middletest/prod/330a8c33-668d-43c2-a2a1-aaaac27f4847",
  );
  assert.match(classified.skipped[0].reason, /liangkd01/);
  assert.match(classified.skipped[0].reason, /MR 合并人/);
});

test("does not skip the primary repo or unrelated create failures", () => {
  const classified = classifyReviewerMissingRepos(
    [
      {
        url: "https://git.myscrm.cn/ai-sale/bff-ai-sale-inquries-bg/",
        reason: "获取审核人Id失败: [liangkd01]用户不存在",
      },
      {
        url: "https://git.myscrm.cn/middletest/prod/other",
        reason: "创建mr失败：分支冲突",
      },
    ],
    {
      primaryUrl: "https://git.myscrm.cn/ai-sale/bff-ai-sale-inquries-bg",
      auditUser: "liangkd01",
    },
  );

  assert.equal(classified.skipped.length, 0);
  assert.equal(classified.hard.length, 2);
});
