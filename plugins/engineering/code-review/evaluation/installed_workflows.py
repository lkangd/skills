#!/usr/bin/env python3
"""Exercise installed Codex and Pi entry points with reproducible local model doubles."""

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
# The installed Pi extension runs its normal model tool path. This provider supplies
# predictable parent turns without using network or credentials.
PI_DRIVER = r'''
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
      const mode = instruction.match(/in (\w+) mode/)[1];
      const input = JSON.parse(instruction.match(/^Command arguments: (.*)\.$/m)[1]);
      const last = context.messages.at(-1);
      let request;
      if (last.role === "user") {
        results = [];
        request = mode === "resume" ? {operation: "resume", run_dir: input}
          : {operation: "run", kind: "working-tree"};
      } else {
        const report = JSON.parse(last.content.find((item) => item.type === "text").text);
        results.push(report);
        if (mode === "adversarial" && results.length === 1 && report.status === "completed") {
          writeFileSync(join(cwd, "math.py"), "def increment(n):\n    return n + 1\n");
          request = {operation: "next", run_dir: report.run_dir,
            fixed: [1], known_issues: "- [fixed] math.py: Wrong arithmetic"};
        }
      }
      const final = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: request ? "toolUse" : "stop",
        content: request ? [{ type: "toolCall", id: "task-" + results.length,
          name: "code_review_round", arguments: request }] : [{ type: "text", text: "Done" }],
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


def configure(repo):
    argv = [sys.executable, "-B", str(PLUGIN / "scripts/review.py"), "--repo", str(repo)]
    proposal = command([*argv, "config-template"], repo)
    config = repo / ".code-review/config.local.json"
    assert not config.exists()
    partial = subprocess.run([*argv, "config-save"], cwd=repo, input="{}",
                             capture_output=True, text=True)
    assert partial.returncode and not config.exists(), partial
    saved = subprocess.run([*argv, "config-save"], cwd=repo, input=proposal,
                           capture_output=True, text=True, check=True)
    assert json.loads(config.read_text()) == json.loads(saved.stdout) == json.loads(proposal)


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
    for name, body in (("codex", FAKE_CODEX), ("pi", FAKE_PI), ("fixture_worker.py", FIXTURE_WORKER)):
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
        self.authorized = False

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
            if item.get("method") == "mcpServer/elicitation/request":
                assert str(self.repo) in item["params"]["message"], item
                self.authorized = True
                self.send({"jsonrpc": "2.0", "id": item["id"], "result": {
                    "action": "accept", "content": {"authorize": True}}})
            elif item.get("id") == self.seq and "method" not in item:
                assert "error" not in item, item
                return item["result"]
        raise AssertionError(f"No Codex response for {method}")

    def __enter__(self):
        self.call("initialize", {"clientInfo": {"name": "code-review-test", "version": "1"}})
        self.send({"jsonrpc": "2.0", "method": "initialized"})
        self.thread = self.call("thread/start", {"cwd": str(self.repo), "sandbox": "read-only",
                                               "approvalPolicy": "on-request"})["thread"]["id"]
        status = self.call("mcpServerStatus/list", {"threadId": self.thread})
        server = next(entry for entry in status["data"] if "code-review" in entry["name"])
        assert set(server["tools"]) == {"review_run", "review_resume", "review_next"}, server
        self.server = server["name"]
        skills = self.call("skills/list", {"cwds": [str(self.repo)]})
        assert any(skill["name"] == "code-review:code-review"
                   for entry in skills["data"] for skill in entry["skills"]), skills
        return self

    def __exit__(self, *_):
        self.selector.close()
        self.process.terminate()
        self.process.communicate(timeout=10)

    def tool(self, name, timeout=45, **args):
        response = self.call("mcpServer/tool/call", {
            "threadId": self.thread, "server": self.server, "tool": name,
            "arguments": {"workspace": str(self.repo), **args},
        }, timeout=timeout)
        return json.loads(response["content"][0]["text"])


def assert_complete(result, expected_round=1, count=1):
    if result["status"] != "completed":
        logs = Path(result["run_dir"]) / "out" if result.get("run_dir") else None
        errors = {path.name: path.read_text() for path in logs.glob("*.err")} if logs else {}
        raise AssertionError((result, errors))
    assert result["round"] == expected_round, result
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


def interrupt_codex_launcher(installed, repo, env):
    launcher = installed / "scripts/review_mcp.py"
    proc = subprocess.Popen([sys.executable, "-B", str(launcher)], cwd=installed, env=env,
                            bufsize=0, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    def send(body):
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", **body}).encode() + b"\n")

    known = set((repo / ".code-review/runs").glob("*/round-1/out/candidates-correctness.json"))
    (repo / "pause-review").touch()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            send({"id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}})
            assert selector.select(5) and json.loads(proc.stdout.readline())["id"] == 1
            send({"id": 2, "method": "tools/call", "params": {"name": "review_run", "arguments": {
                "workspace": str(repo), "kind": "working-tree", "concurrency": 2}}})
            run = wait_checkpoint(repo, known)
            assert not selector.select(0), "Review returned before the round finished"
            send({"method": "notifications/cancelled", "params": {"requestId": 2}})
            # An idle tools/list reply proves the launcher has stopped and joined its runner.
            send({"id": 3, "method": "tools/list"})
            assert selector.select(10) and json.loads(proc.stdout.readline())["id"] == 3
            assert not (run / "out/findings.json").exists(), run
            return run
    finally:
        proc.terminate()
        proc.communicate(timeout=10)
        (repo / "pause-review").unlink()


def exercise_codex(cli, source, repo, env, root, long_wait):
    setup_env = {**os.environ, "CODEX_HOME": str(root / "codex-home")}
    (root / "codex-home").mkdir()
    command([cli, "plugin", "marketplace", "add", str(source)], root, setup_env)
    installed = json.loads(command([cli, "plugin", "add", "code-review@lkangd-skills", "--json"],
                                   root, setup_env))
    plugin_root = Path(installed["installedPath"])
    assert (plugin_root / "skills/code-review/SKILL.md").is_file(), installed
    env = {**env, "CODEX_HOME": setup_env["CODEX_HOME"]}
    with Codex(cli, repo, env) as codex:
        missing = codex.tool("review_run", kind="working-tree")
        assert missing["status"] == "error" and "Missing .code-review/" in missing["error"], missing
        config = repo / ".code-review/config.local.json"
        config.parent.mkdir()
        config.write_text("{}")
        partial = codex.tool("review_run", kind="working-tree")
        assert partial["status"] == "error" and "Incomplete .code-review/" in partial["error"], partial
        config.unlink()
        assert not codex.authorized and not Path(env["REVIEW_FIXTURE_LOG"]).exists()
        configure(repo)
        assert_complete(codex.tool("review_run", kind="working-tree"))
        assert codex.authorized
        first = codex.tool("review_run", kind="working-tree", mode="adversarial")
        assert_complete(first)
        assert (Path(first["run_dir"]) / "out/candidates-sweep.json").exists()
        (repo / "math.py").write_text("def increment(n):\n    return n + 1\n")
        assert_complete(codex.tool("review_next", run_dir=first["run_dir"],
                                   fixed=[1], known_issues="- [fixed] math.py"), 2, 0)
        reset(repo)
        run = interrupt_codex_launcher(plugin_root, repo, env)
        assert str(run) in codex.tool("review_resume")["run_dirs"]
        log = Path(env["REVIEW_FIXTURE_LOG"])
        seen = log.read_text().splitlines().count("correctness")
        assert_complete(codex.tool("review_resume", run_dir=str(run)))
        assert log.read_text().splitlines().count("correctness") == seen
        print("Codex installed: configuration required, normal, adversarial + re-review, interrupted + resumed",
              flush=True)
        if long_wait:
            (repo / "pause-review").write_text("305")
            start = time.monotonic()
            assert_complete(codex.tool("review_run", timeout=360, kind="working-tree"))
            elapsed = time.monotonic() - start
            assert elapsed > 300, elapsed
            print(f"Codex installed: one call returned its final result after {elapsed:.1f}s", flush=True)


def exercise_pi(cli, source, repo, env, root):
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
                    assert not (event.get("type") == "tool_execution_update"
                                and event.get("toolName") == "code_review_round"), event
                    if event.get("type") == "tool_execution_end" and event.get("toolName") == "code_review_round":
                        result = event.get("result", {})
                        if result.get("details"):
                            results.append(result["details"])
                    if event.get("type") == "agent_end":
                        if results:
                            return results
                        if interrupt:
                            return [{"status": "incomplete", "run_dir": str(interrupted_run)}]
        finally:
            proc.terminate()
            stdout, stderr = proc.communicate(timeout=10)
        raise AssertionError(f"Pi did not finish {text}\n{logs[-12:]}\n{stdout.decode()}\n{stderr.decode()}")
    missing = invoke("/code-review working-tree")[0]
    assert missing["status"] == "error" and "Missing .code-review/" in missing["error"], missing
    assert not Path(env["REVIEW_FIXTURE_LOG"]).exists()
    configure(repo)
    assert_complete(invoke("/code-review working-tree")[0])
    first, second = invoke("/code-review:adversarial working-tree")
    assert_complete(first)
    assert (Path(first["run_dir"]) / "out/candidates-sweep.json").exists()
    assert_complete(second, 2, 0)
    reset(repo)
    (repo / "pause-review").touch()
    interrupted = invoke("/code-review working-tree", interrupt=True)[0]
    assert interrupted["status"] == "incomplete", interrupted
    run = Path(interrupted["run_dir"])
    assert (run / "out/candidates-correctness.json").exists()
    (repo / "pause-review").unlink()
    log = Path(env["REVIEW_FIXTURE_LOG"])
    seen = log.read_text().splitlines().count("correctness")
    assert_complete(invoke(f"/code-review resume {run}")[0])
    assert log.read_text().splitlines().count("correctness") == seen
    print("Pi Git-installed: configuration required, normal, adversarial + re-review, interrupted + resumed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=("codex", "pi", "both"), default="both", nargs="?")
    parser.add_argument("--long-wait", action="store_true", help="verify one Codex tool call lasting over 300s")
    args = parser.parse_args()
    hosts = ("codex", "pi") if args.host == "both" else (args.host,)
    for host in hosts:
        cli = shutil.which(host)
        assert cli, f"{host} is required"
        with tempfile.TemporaryDirectory(prefix=f"installed-review-{host}-") as temp:
            root = Path(temp).resolve()
            if host == "codex":
                exercise_codex(cli, installed_source(root), fixture(root), environment(root), root, args.long_wait)
            else:
                exercise_pi(cli, installed_source(root), fixture(root), environment(root), root)


if __name__ == "__main__":
    main()
