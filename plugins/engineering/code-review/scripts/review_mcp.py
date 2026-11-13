#!/usr/bin/env python3
"""Local Codex launcher for the code-review plugin."""

import hashlib
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from review_workspace import ROOT, repo_root, write_json, read_json

TOOLS = {
    "review_run": ("Start one read-only code review round.", {
        "workspace": {"type": "string"}, "kind": {"enum": [
            "working-tree", "staged", "files", "commit", "branch"]},
        "values": {"type": "array", "items": {"type": "string"}},
        "mode": {"enum": ["normal", "adversarial"]},
        "description": {"type": "string"}, "spec": {"type": "array", "items": {"type": "string"}},
        "spec_context": {"type": "string"}, "concurrency": {"type": "integer", "minimum": 0},
        "max_rounds": {"type": "integer", "minimum": 1},
    }, ["workspace", "kind"]),
    "review_resume": ("List or resume review checkpoints in this repository.", {
        "workspace": {"type": "string"}, "run_dir": {"type": "string"},
    }, ["workspace"]),
    "review_next": ("Start the next adversarial round after fixing a major or critical finding.", {
        "workspace": {"type": "string"}, "run_dir": {"type": "string"},
        "fixed": {"type": "array", "minItems": 1, "items": {"type": "integer", "minimum": 1}},
        "known_issues": {"type": "string"},
    }, ["workspace", "run_dir", "fixed", "known_issues"]),
    "review_status": ("Check a scheduled review. Wait up to 20 seconds for a result.", {
        "workspace": {"type": "string"}, "job": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
    }, ["workspace", "job"]),
    "review_cancel": ("Interrupt a scheduled review and retain its checkpoints.", {
        "workspace": {"type": "string"}, "job": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
    }, ["workspace", "job"]),
}


def descriptor(name, spec):
    description, fields, required = spec
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": fields, "required": required,
                            "additionalProperties": False},
            "annotations": {"readOnlyHint": name == "review_status",
                            "destructiveHint": False, "openWorldHint": True}}


def validate(name, arguments):
    if name not in TOOLS or not isinstance(arguments, dict):
        raise ValueError("Unknown review tool or invalid arguments")
    _, fields, required = TOOLS[name]
    if set(arguments) - fields.keys() or not set(required) <= arguments.keys():
        raise ValueError("Unexpected or missing review arguments")
    for key, value in arguments.items():
        field = fields[key]
        kind = field.get("type")
        if kind == "string" and (not isinstance(value, str) or "\0" in value):
            raise ValueError(f"{key} must be text")
        if kind == "integer" and (type(value) is not int or value < field["minimum"]):
            raise ValueError(f"{key} must be an integer of at least {field['minimum']}")
        if "enum" in field and value not in field["enum"]:
            raise ValueError(f"Unsupported {key}")
        if kind == "array":
            expected = {"string": str, "integer": int}[field["items"]["type"]]
            if not isinstance(value, list) or len(value) < field.get("minItems", 0) or any(
                type(item) is not expected or expected is str and "\0" in item
                or expected is int and item < field["items"]["minimum"] for item in value
            ):
                raise ValueError(f"Invalid {key}")
        if "pattern" in field and not re.fullmatch(field["pattern"], value):
            raise ValueError(f"Invalid {key}")


def options(args, names):
    result = []
    for name in names:
        value = args.get(name)
        if value is None:
            continue
        flag = "--" + name.replace("_", "-")
        result.extend(f"{flag}={item}" for item in (value if isinstance(value, list) else [value]))
    return result


class Launcher:
    def __init__(self):
        self.data = Path(os.environ["PLUGIN_DATA"])
        self.child_env = dict(os.environ)
        # Codex starts plugin stdio processes with a filtered environment. Its installed
        # cache provides the native config root when CODEX_HOME is absent.
        for parent in ROOT.parents:
            if parent.name == "cache" and parent.parent.name == "plugins":
                self.child_env.setdefault("CODEX_HOME", str(parent.parent.parent))
                break
        self.data.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.jobs = {}
        self.inbox = queue.Queue()

    def send(self, message):
        print(json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=True), flush=True)

    def read(self):
        for line in sys.stdin:
            try:
                self.inbox.put(json.loads(line))
            except ValueError:
                pass
        self.inbox.put(None)

    def scope(self, name, args):
        workspace = Path(args["workspace"])
        if not workspace.is_absolute():
            raise ValueError("Pass the absolute Git root from the current Codex workspace")
        repo = repo_root(workspace)
        if repo != workspace.resolve():
            raise ValueError("Pass the Git root of the workspace")
        if name in ("review_status", "review_cancel") and args["job"] not in self.jobs:
            raise ValueError("This job belongs to a different launcher session. Use review_resume.")
        key = hashlib.sha256(os.fsencode(repo)).hexdigest()
        authorization = self.data / f"workspace-{key}.json"
        if authorization.exists() and read_json(authorization) == {"workspace": str(repo)}:
            return repo
        if name in ("review_status", "review_cancel"):
            raise ValueError("This repository has no review authorization")
        request = f"workspace-{uuid.uuid4().hex}"
        self.send({
            "id": request, "method": "elicitation/create",
            "params": {"message": f"Authorize code review for {repo}? The selected model provider "
                       "will receive review context from this repository.",
                       "requestedSchema": {"type": "object", "required": ["authorize"],
                                           "properties": {"authorize": {"type": "boolean",
                                               "title": "Authorize this repository"}}}},
        })
        deferred = []
        deadline = time.monotonic() + 120
        try:
            while True:
                reply = self.inbox.get(timeout=max(0, deadline - time.monotonic()))
                if reply is None:
                    self.inbox.put(None)
                    raise ValueError("Codex closed before approving the repository")
                if reply.get("id") == request and "method" not in reply:
                    answer = reply.get("result", {})
                    content = answer.get("content") or {}
                    if answer.get("action") != "accept" or content.get("authorize") is not True:
                        raise ValueError("Repository approval was declined")
                    write_json(authorization, {"workspace": str(repo)})
                    return repo
                deferred.append(reply)
        except queue.Empty:
            raise ValueError("Repository approval timed out") from None
        finally:
            for reply in deferred:
                self.inbox.put(reply)

    def call(self, name, args):
        validate(name, args)
        repo = self.scope(name, args)
        if name in ("review_status", "review_cancel"):
            job = args["job"]
            if job not in self.jobs or self.jobs[job][0] != repo:
                raise ValueError("This job belongs to a different launcher session or repository. Use review_resume.")
            _, process, result = self.jobs[job]
            if name == "review_cancel" and process.poll() is None:
                process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                return {"status": "running", "job": job}
            try:
                return read_json(result)
            except (ValueError, OSError):
                return {"status": "error", "error": f"Review process exited {process.returncode}. Use review_resume."}
        if name == "review_run":
            argv = ["run", "--backend", "codex", *options(args, [
                "mode", "description", "spec", "spec_context", "concurrency", "max_rounds"]),
                "--", args["kind"], *args.get("values", [])]
        elif name == "review_resume":
            argv = ["resume", "--", *([args["run_dir"]] if args.get("run_dir") else [])]
        else:
            argv = ["next", *options(args, ["fixed", "known_issues"]), "--", args["run_dir"]]
        if name == "review_resume" and not args.get("run_dir"):
            completed = subprocess.run([sys.executable, "-B", str(ROOT / "scripts/review.py"),
                                        "--repo", str(repo), *argv], capture_output=True, timeout=15)
            return json.loads(completed.stdout)
        job = uuid.uuid4().hex
        result = self.data / f"job-{job}.json"
        with result.open("wb") as output:
            process = subprocess.Popen(
                [sys.executable, "-B", str(ROOT / "scripts/review.py"), "--repo", str(repo), *argv],
                cwd=repo, env=self.child_env, stdin=subprocess.DEVNULL, stdout=output, stderr=sys.stderr,
                start_new_session=True,
            )
        self.jobs[job] = (repo, process, result)
        return {"status": "running", "job": job}

    def serve(self):
        threading.Thread(target=self.read, daemon=True).start()
        try:
            while (request := self.inbox.get()) is not None:
                method = request.get("method")
                if "id" not in request:
                    continue
                request_id = request["id"]
                params = request.get("params", {})
                if method == "initialize":
                    result = {"protocolVersion": params.get("protocolVersion", "2025-03-26"),
                              "capabilities": {"tools": {}},
                              "serverInfo": {"name": "code-review", "version": "1.0.0"}}
                elif method == "ping":
                    result = {}
                elif method == "tools/list":
                    result = {"tools": [descriptor(name, spec) for name, spec in TOOLS.items()]}
                elif method == "tools/call":
                    try:
                        data = self.call(params.get("name"), params.get("arguments", {}))
                    except (ValueError, OSError, subprocess.SubprocessError) as error:
                        data = {"status": "error", "error": str(error)}
                    result = {"content": [{"type": "text", "text": json.dumps(data)}],
                              "isError": data.get("status") == "error"}
                else:
                    self.send({"id": request_id, "error": {"code": -32601, "message": "Method not found"}})
                    continue
                self.send({"id": request_id, "result": result})
        finally:
            for _, process, result in self.jobs.values():
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                result.unlink(missing_ok=True)


if __name__ == "__main__":
    Launcher().serve()
