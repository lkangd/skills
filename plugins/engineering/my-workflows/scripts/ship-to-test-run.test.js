const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyMergedMrInfo,
  captureDeploymentBaseline,
  classifyReviewerMissingRepos,
  deploymentActionFor,
  deploymentTargetFingerprint,
  filterMrsForExpectedSha,
  isReviewerMissingFailure,
  newDeployRecord,
  normalizeRunState,
  parseCreateRepoResults,
  parseRunOptions,
  pollDeploymentVerification,
  recordTargetFingerprint,
  resolveDevBranch,
  resolveStartStep,
  resolveTargetShaOnBranch,
  shaOnBranch,
  stateMatchesRun,
  targetShaCandidates,
} = require("./ship-to-test-run.js");

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
