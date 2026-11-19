#!/usr/bin/env python3
"""Check installed manual skills and exercise their scheduler with deterministic workers."""

import argparse
import json
import os
import selectors
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]
REPOSITORY = PLUGIN.parents[2]
EXTERNAL_RUNNER = "ccsp -g fixture claude"

FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
if args[:2] == ["debug", "models"]:
    print('{"models":[]}')
elif args[:2] == ["mcp", "list"]:
    print("[]")
elif args[0] == "app-server":
    for line in sys.stdin:
        req = json.loads(line)
        if "id" not in req:
            continue
        method = req["method"]
        result = {"config": {"model": "test-model"}} if method == "config/read" else {}
        if method == "model/list":
            result = {"data": [{"model": "test-model", "isDefault": True,
                      "supportedReasoningEfforts": [{"reasoningEffort": x}
                      for x in ("low", "medium", "high")]}]}
        print(json.dumps({"id": req["id"], "result": result}), flush=True)
else:
    from fixture_worker import receipt
    result = receipt(sys.stdin.read(), wrapped=True)
    Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(result))
    print('{"type":"turn.completed"}')
'''
FAKE_PI = r'''#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if "--mode" in args:
    model = {"provider": "fixture", "id": "review", "contextWindow": 30000, "reasoning": True}
    for line in sys.stdin:
        req = json.loads(line)
        data = {"models": [model]} if req["type"] == "get_available_models" else {"model": model}
        print(json.dumps({"id": req["id"], "data": data}), flush=True)
else:
    from fixture_worker import receipt
    print(json.dumps(receipt(sys.stdin.read())))
'''
FAKE_CCSP = r'''#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

assert sys.argv[1:4] == ["-g", "fixture", "claude"]
args = sys.argv[4:]
root = Path(__file__).resolve().parents[1]
with (root / "runners.log").open("a") as log:
    log.write(("discovery" if "--input-format" in args else
               "resume" if "--resume" in args else "launch") + "\n")
if "--input-format" in args:
    print(json.dumps({"type": "control_response", "response": {"response": {"models": [
        {"value": "default", "resolvedModel": "fixture-model",
         "supportedEffortLevels": ["low", "medium", "high"]}
    ]}}}))
    sys.exit(0)

prompt = args[args.index("-p") + (3 if args[args.index("-p") + 1].startswith("--") else 1)]
run = Path(re.search(r"(/[^\n ]+/\.code-review/runs/[^\n ]+/round-\d+)", prompt)[1])
assert os.environ["CODE_REVIEW_CHILD"] == "1"
plan_path = run / "review-plan.json"
plan = json.loads(plan_path.read_text())
if plan["late_waves"] and not any(task["id"] == "sweep" for task in plan["tasks"]):
    plan["tasks"].append({"id": "sweep", "angle": "sweep", "wave": 2, "complexity": "high"})
    plan_path.write_text(json.dumps(plan))
for task in plan["tasks"]:
    path = run / "out" / f"candidates-{task['id']}.json"
    if path.exists():
        continue
    findings = []
    if task["id"] == "correctness" and "return n - 1" in (run / "raw_diff.txt").read_text():
        findings.append({"severity": "major", "title": "Wrong arithmetic", "file": "math.py", "line": 2,
                         "evidence": "return n - 1", "why": "increment(1) yields 0",
                         "suggestion": "Return n + 1."})
    if (Path.cwd() / "pause-review").exists() and task["id"] != "correctness":
        time.sleep(20)
    path.write_text(json.dumps({"status": "completed", "findings": findings}))
    with (root / "workers.log").open("a") as log:
        log.write(task["id"] + "\n")
plugin = root / "source/plugins/engineering/code-review"
command = ["bash", str(plugin / "scripts/findings.sh")]
subprocess.run([*command, "prepare", "--run-dir", str(run), "--strict"], check=True)
for path in (run / "out").glob("verify-input-*.json"):
    batch = json.loads(path.read_text())
    verdicts = [{"index": item["index"], "verdict": "CONFIRMED", "evidence": "math.py:2"}
                for item in batch]
    (path.parent / path.name.replace("verify-input-", "verdicts-")).write_text(json.dumps(verdicts))
subprocess.run([*command, "build", "--run-dir", str(run), "--strict"], check=True)
print("CODE-REVIEW RESULT: completed")
'''
FIXTURE_WORKER = r'''
import json
import os
import re
import time
from pathlib import Path

def receipt(prompt, wrapped=False):
    task = re.search(r"^Task ID: (.+)$", prompt, re.M).group(1)
    with open(Path(__file__).resolve().parents[1] / "workers.log", "a") as output:
        output.write(task + "\n")
    marker = Path("pause-review")
    if marker.exists() and task != "correctness" and not task.startswith("verify-"):
        time.sleep(float(marker.read_text() or "20"))
    if task.startswith("verify-"):
        batch = prompt.split("## Candidate batch\n", 1)[1]
        candidates = json.JSONDecoder().raw_decode(batch)[0]
        data = [{"index": item["index"], "verdict": "CONFIRMED", "evidence": "math.py:2"}
                for item in candidates]
        return {"verdicts": data} if wrapped else data
    data = []
    if task == "correctness" and "- 1" in Path("math.py").read_text():
        data.append({"severity":"major","title":"Wrong arithmetic","file":"math.py","line":2,
                     "evidence":"return n - 1", "why":"increment(1) yields 0",
                     "suggestion":"Return n + 1."})
    return {"status":"completed", "findings":data}
'''
# Drive the installed skills through Pi’s ordinary Bash tool without calling a model API.
PI_DRIVER = r'''
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export default function (pi) {
  let cwd;
  let results = [];
  pi.on("session_start", (_event, ctx) => { cwd = ctx.cwd; });
  pi.registerProvider("fixture", {
    baseUrl: "https://example.invalid", apiKey: "fixture", api: "fixture-api",
    models: [{ id: "review", name: "Review", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 30000, maxTokens: 3000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter((message) => message.role === "user");
      const message = users.at(-1);
      const instruction = typeof message.content === "string" ? message.content
        : message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
      const source = instruction.match(/^Follow the manually invoked skill from (.+)\.$/m);
      if (!source || !instruction.includes("../../references/portable-workflow.md")) {
        throw new Error("Expected installed skill content: " + instruction);
      }
      const skillDir = dirname(JSON.parse(source[1]));
      const skill = basename(skillDir);
      const target = JSON.parse(instruction.match(/^Invocation arguments: (".*")$/m)[1]);
      const entry = resolve(skillDir, "../../scripts/review.py");
      const last = context.messages.at(-1);
      let args;
      if (last.role === "user") {
        results = [];
        if (skill === "setup") {
          args = ["config-template"];
        } else if (target.startsWith("resume ")) {
          args = ["resume", "--", target.slice("resume ".length)];
        } else {
          const mode = skill === "adversarial" ? "adversarial" : "normal";
          if (!instruction.includes("Pi session model for review runner selection: fixture/review")) {
            throw new Error("Missing Pi model context");
          }
          args = ["run", "--backend", "pi", "--mode", mode, "--active-model=fixture/review", "--", target];
        }
      } else {
        const text = last.content.find((item) => item.type === "text").text;
        const report = JSON.parse(text.split("\n").find((line) => line.startsWith("{")));
        results.push(report);
        if (skill === "adversarial" && results.length === 1 && report.status === "completed") {
          writeFileSync(join(cwd, "math.py"), "def increment(n):\n    return n + 1\n");
          args = ["next", "--fixed=1", "--known-issues=- [fixed] math.py: Wrong arithmetic",
            "--", report.run_dir];
        }
      }
      const request = args && ["python3", "-B", entry, "--repo", cwd, ...args].map(quote).join(" ");
      const final = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: request ? "toolUse" : "stop",
        content: request ? [{ type: "toolCall", id: "task-" + results.length,
          name: "bash", arguments: {command: request} }] : [{ type: "text", text: "Done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: final });
        stream.push({ type: "done", reason: final.stopReason, message: final });
        stream.end(final);
      });
      return stream;
    },
  });
}
'''

def command(argv, cwd, env=None, timeout=120):
    run = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if run.returncode:
        raise AssertionError(f"{argv[:3]} exited {run.returncode}\n{run.stdout}\n{run.stderr}")
    return run.stdout


def fixture(root):
    repo = root / "target"
    repo.mkdir()
    command(["git", "init", "-q"], repo)
    command(["git", "config", "user.name", "Test"], repo)
    command(["git", "config", "user.email", "test@example.com"], repo)
    (repo / "math.py").write_text("def increment(n):\n    return n\n")
    (repo / ".gitignore").write_text(".code-review/\npause-review\n")
    command(["git", "add", "."], repo)
    command(["git", "commit", "-qm", "fixture"], repo)
    reset(repo)
    return repo


def reset(repo):
    (repo / "math.py").write_text("def increment(n):\n    return n - 1\n")


def configure(repo, external=False, plugin=PLUGIN):
    argv = [sys.executable, "-B", str(plugin / "scripts/review.py"), "--repo", str(repo)]
    proposal = command([*argv, "config-template"], repo)
    config = repo / ".code-review/config.local.json"
    assert not config.exists()
    if external:
        settings = json.loads(proposal)
        for host in ("claude", "codex", "pi"):
            settings[host]["runner"] = EXTERNAL_RUNNER
        proposal = json.dumps(settings)
    partial = subprocess.run([*argv, "config-save"], cwd=repo, input="{}",
                             capture_output=True, text=True)
    assert partial.returncode and not config.exists(), partial
    saved = subprocess.run([*argv, "config-save"], cwd=repo, input=proposal,
                           capture_output=True, text=True, check=True)
    assert json.loads(config.read_text()) == json.loads(saved.stdout) == json.loads(proposal)


def exercise_cross_harness(repo, env):
    config = repo / ".code-review/config.local.json"
    original = config.read_text()
    entry = [sys.executable, "-B", str(PLUGIN / "scripts/review.py")]
    for host, runner in (("claude", "pi"), ("codex", "pi"), ("pi", "codex"), ("claude", "codex")):
        settings = json.loads(original)
        executable = Path(env["PATH"].split(os.pathsep)[0]) / runner
        settings[host]["runner"] = {"harness": runner, "command": str(executable)}
        config.write_text(json.dumps(settings))
        report = json.loads(command([*entry, "run", "--backend", host, "working-tree"], repo, env))
        assert_complete(report)
        assert report["backend"] == host and report["harness"] == runner, report
    config.write_text(original)


def installed_source(root):
    source = root / "source"
    source.mkdir()
    relative = PLUGIN.relative_to(REPOSITORY)
    shutil.copytree(PLUGIN, source / relative, ignore=shutil.ignore_patterns("__pycache__"))
    (source / ".claude-plugin").mkdir()
    shutil.copy(REPOSITORY / ".claude-plugin/marketplace.json", source / ".claude-plugin")
    shutil.copy(REPOSITORY / "package.json", source)
    command(["git", "init", "-q"], source)
    command(["git", "config", "user.name", "Test"], source)
    command(["git", "config", "user.email", "test@example.com"], source)
    command(["git", "add", "."], source)
    command(["git", "commit", "-qm", "plugin fixture"], source)
    return source


def environment(root):
    bin_dir = root / "bin"
    bin_dir.mkdir()
    for name, body in (("codex", FAKE_CODEX), ("pi", FAKE_PI), ("ccsp", FAKE_CCSP),
                       ("fixture_worker.py", FIXTURE_WORKER)):
        path = bin_dir / name
        path.write_text(body)
        path.chmod(0o755)
    return {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "REVIEW_FIXTURE_LOG": str(root / "workers.log")}


class Codex:
    def __init__(self, cli, repo, env):
        self.process = subprocess.Popen([cli, "app-server"], cwd=repo, env=env, bufsize=0,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.repo = repo
        self.seq = 0

    def send(self, body):
        self.process.stdin.write(json.dumps(body).encode() + b"\n")

    def call(self, method, params=None, timeout=45):
        self.seq += 1
        request = {"jsonrpc": "2.0", "id": self.seq, "method": method}
        if params is not None:
            request["params"] = params
        self.send(request)
        deadline = time.monotonic() + timeout
        while self.selector.select(max(0, deadline - time.monotonic())):
            raw = self.process.stdout.readline()
            if not raw:
                break
            item = json.loads(raw)
            if item.get("id") == self.seq and "method" not in item:
                assert "error" not in item, item
                return item["result"]
        raise AssertionError(f"No Codex response for {method}")

    def __enter__(self):
        return self

    def skills(self):
        self.call("initialize", {"clientInfo": {"name": "code-review-test", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "initialized"})
        return self.call("skills/list", {"cwds": [str(self.repo)]})["data"][0]["skills"]

    def __exit__(self, *_):
        self.selector.close()
        self.process.terminate()
        self.process.communicate(timeout=10)


def assert_complete(result, expected_round=1, count=1, *, external=False):
    if result["status"] != "completed":
        logs = Path(result["run_dir"]) / "out" if result.get("run_dir") else None
        errors = {path.name: path.read_text() for path in logs.glob("*.err")} if logs else {}
        raise AssertionError((result, errors))
    assert result["round"] == expected_round, result
    if external:
        assert result["runner"] == EXTERNAL_RUNNER and result["harness"] == "claude", result
    findings = json.loads(Path(result["findings"]).read_text())
    assert len(findings) == count, findings
    if findings:
        assert findings[0]["verdict"] == "CONFIRMED", findings


def wait_checkpoint(repo, known=()):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        for path in (repo / ".code-review/runs").glob("*/round-1/out/candidates-correctness.json"):
            if path not in known:
                return path.parent.parent
        time.sleep(0.05)
    raise AssertionError("The first review task did not checkpoint")


SKILLS = {"code-review", "adversarial", "setup"}
QUALIFIED = {f"code-review:{name}" for name in SKILLS}


def install_claude(cli, source, repo, root):
    home = root / "claude-home"
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(home),
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
           "ANTHROPIC_API_KEY": "fixture", "ANTHROPIC_BASE_URL": "http://127.0.0.1:9"}
    command([cli, "plugin", "install", "code-review", "--marketplace", str(source)], root, env)
    initialize = {"type": "control_request", "request_id": "skills",
                  "request": {"subtype": "initialize"}}
    probe = subprocess.run([cli, "-p", "--input-format", "stream-json", "--output-format",
                            "stream-json", "--verbose"], cwd=repo, env=env,
                           input=json.dumps(initialize) + "\n", text=True, capture_output=True,
                           timeout=20, check=True)
    responses = [json.loads(line) for line in probe.stdout.splitlines()]
    inventory = next(item["response"]["response"] for item in responses
                     if item.get("type") == "control_response")["commands"]
    assert {entry["name"] for entry in inventory if entry["name"].startswith("code-review:")} == QUALIFIED
    manifest = json.loads((home / "plugins/installed_plugins.json").read_text())
    return Path(manifest["plugins"]["code-review@lkangd-skills"][0]["installPath"])


def install_codex(cli, source, repo, root):
    env = {**os.environ, "CODEX_HOME": str(root / "codex-home")}
    (root / "codex-home").mkdir()
    command([cli, "plugin", "marketplace", "add", str(source)], root, env)
    installed = json.loads(command([cli, "plugin", "add", "code-review@lkangd-skills", "--json"],
                                   root, env))
    plugin = Path(installed["installedPath"]).resolve()
    with Codex(cli, repo, env) as codex:
        skills = {skill["name"]: skill for skill in codex.skills()
                  if skill["name"].startswith("code-review:")}
        assert skills.keys() == QUALIFIED, skills
        for name, skill in skills.items():
            assert Path(skill["path"]).resolve() == plugin / "skills" / name.split(":")[1] / "SKILL.md"
            assert "allow_implicit_invocation: false" in (
                Path(skill["path"]).parent / "agents/openai.yaml"
            ).read_text()
    return plugin


def exercise_scheduler(plugin, host, repo, env, external):
    entry = [sys.executable, "-B", str(plugin / "scripts/review.py"), "--repo", str(repo)]
    launch = [*entry, "run", "--backend", host]

    def invoke(*argv, error=None):
        result = subprocess.run(argv, cwd=repo, env=env, capture_output=True, text=True, timeout=45)
        report = json.loads(result.stdout)
        if error:
            assert result.returncode and error in report["error"], report
        else:
            assert result.returncode == 0, (report, result.stderr)
        return report

    invoke(*launch, "working-tree", error="Missing .code-review/")
    config = repo / ".code-review/config.local.json"
    config.parent.mkdir()
    config.write_text("{}")
    invoke(*launch, "working-tree", error="Incomplete .code-review/")
    config.unlink()
    assert not Path(env["REVIEW_FIXTURE_LOG"]).exists()
    configure(repo, external, plugin)
    assert_complete(invoke(*launch, "working-tree"), external=external)
    first = invoke(*launch, "--mode", "adversarial", "working-tree")
    assert_complete(first, external=external)
    assert (Path(first["run_dir"]) / "out/candidates-sweep.json").exists()
    (repo / "math.py").write_text("def increment(n):\n    return n + 1\n")
    assert_complete(invoke(*entry, "next", "--fixed=1", "--known-issues=- [fixed] Wrong arithmetic",
                           "--", first["run_dir"]), 2, 0, external=external)
    reset(repo)

    known = set((repo / ".code-review/runs").glob("*/round-1/out/candidates-correctness.json"))
    pause = repo / "pause-review"
    pause.touch()
    with subprocess.Popen([*launch, "--concurrency=2", "working-tree"], cwd=repo, env=env,
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            run = wait_checkpoint(repo, known)
            assert process.poll() is None
            process.terminate()
            output, errors = process.communicate(timeout=20)
            assert json.loads(output)["status"] == "incomplete", (output, errors)
            assert not (run / "out/findings.json").exists()
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            pause.unlink()
    assert str(run) in invoke(*entry, "resume")["run_dirs"]
    log = Path(env["REVIEW_FIXTURE_LOG"])
    seen = log.read_text().splitlines().count("correctness")
    assert_complete(invoke(*entry, "resume", "--", str(run)), external=external)
    assert log.read_text().splitlines().count("correctness") == seen
    print(f"{host.capitalize()}: installed manual entries and scheduler review, re-review and resume")


def exercise_pi(cli, source, repo, env, root, external):
    home = root / "pi-home"
    home.mkdir()
    git_config = root / "gitconfig"
    command(["git", "config", "-f", str(git_config), f"url.{source.as_uri()}.insteadOf",
             "https://github.com/example/code-review-fixture"], root)
    setup_env = {**os.environ, "PI_CODING_AGENT_DIR": str(home), "GIT_CONFIG_GLOBAL": str(git_config),
                 "npm_config_offline": "true", "npm_config_audit": "false"}
    command([cli, "install", "git:github.com/example/code-review-fixture"], root, setup_env)
    driver = root / "driver.ts"
    driver.write_text(PI_DRIVER)
    env = {**env, "PI_CODING_AGENT_DIR": str(home)}
    def invoke(text, interrupt=False):
        proc = subprocess.Popen([cli, "--mode", "rpc", "--no-session", "--no-mcp", "--offline",
                                 "--no-approve", "-e", str(driver), "--model", "fixture/review"],
                                cwd=repo, env=env, bufsize=0, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def send(body):
            proc.stdin.write(json.dumps(body).encode() + b"\n")
        known = set((repo / ".code-review/runs").glob("*/round-1/out/candidates-correctness.json"))
        logs = []
        results = []
        try:
            send({"id": "invoke", "type": "prompt", "message": text})
            if interrupt:
                interrupted_run = wait_checkpoint(repo, known)
                send({"id": "cancel", "type": "abort"})
            deadline = time.monotonic() + 40
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                while selector.select(max(0, deadline - time.monotonic())):
                    raw = proc.stdout.readline()
                    if not raw:
                        break
                    event = json.loads(raw)
                    logs.append(event)
                    if event.get("type") == "tool_execution_end" and event.get("toolName") == "bash":
                        for part in event.get("result", {}).get("content", []):
                            for line in part.get("text", "").splitlines():
                                if line.startswith("{"):
                                    results.append(json.loads(line))
                    if event.get("type") == "agent_end":
                        if results:
                            return results
                        if interrupt:
                            return [{"status": "incomplete", "run_dir": str(interrupted_run)}]
        finally:
            proc.terminate()
            stdout, stderr = proc.communicate(timeout=10)
        raise AssertionError(f"Pi did not finish {text}\n{logs[-12:]}\n{stdout.decode()}\n{stderr.decode()}")
    assert invoke("/code-review:setup")[0]["concurrency"] == 4
    missing = invoke("/code-review working-tree")[0]
    assert missing["status"] == "error" and "Missing .code-review/" in missing["error"], missing
    assert not Path(env["REVIEW_FIXTURE_LOG"]).exists()
    configure(repo, external)
    ordinary = invoke("/code-review working-tree")[0]
    assert_complete(ordinary, external=external)
    first, second = invoke("/code-review:adversarial working-tree")
    assert_complete(first, external=external)
    assert (Path(first["run_dir"]) / "out/candidates-sweep.json").exists()
    assert_complete(second, 2, 0, external=external)
    reset(repo)
    (repo / "pause-review").touch()
    interrupted = invoke("/code-review working-tree", interrupt=True)[0]
    assert interrupted["status"] == "incomplete", interrupted
    run = Path(interrupted["run_dir"])
    assert (run / "out/candidates-correctness.json").exists()
    (repo / "pause-review").unlink()
    log = Path(env["REVIEW_FIXTURE_LOG"])
    seen = log.read_text().splitlines().count("correctness")
    assert_complete(invoke(f"/code-review resume {run}")[0], external=external)
    assert log.read_text().splitlines().count("correctness") == seen
    print("Pi Git-installed: configuration required, normal, adversarial + re-review, interrupted + resumed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=("claude", "codex", "pi", "all", "both"), default="all", nargs="?")
    parser.add_argument("--external", action="store_true", help="use a Claude-compatible runner on every host")
    args = parser.parse_args()
    hosts = {"all": ("claude", "codex", "pi"), "both": ("codex", "pi")}.get(args.host, (args.host,))
    for host in hosts:
        cli = shutil.which(host)
        assert cli, f"{host} is required"
        with tempfile.TemporaryDirectory(prefix=f"installed-review-{host}-") as temp:
            root = Path(temp).resolve()
            source, repo, env = installed_source(root), fixture(root), environment(root)
            external = args.external or host == "claude"
            if host == "pi":
                exercise_pi(cli, source, repo, env, root, external)
            else:
                install = install_claude if host == "claude" else install_codex
                plugin = install(cli, source, repo, root)
                exercise_scheduler(plugin, host, repo, env, external)
                if host == "codex":
                    exercise_cross_harness(repo, env)
            if external:
                log = (root / "runners.log").read_text().splitlines()
                assert log.count("launch") == 4 and log.count("resume") == 1, log


if __name__ == "__main__":
    main()
