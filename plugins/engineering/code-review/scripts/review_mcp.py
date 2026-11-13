#!/usr/bin/env python3
"""Local Codex launcher for the code-review plugin."""

import hashlib
import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from review_workspace import ROOT, read_json, repo_root, settings, write_json

TOOLS = {
    "review_run": ("Run one read-only code review round and wait for the final result.", {
        "workspace": {"type": "string"}, "kind": {"enum": [
            "working-tree", "staged", "files", "commit", "branch"]},
        "values": {"type": "array", "items": {"type": "string"}},
        "mode": {"enum": ["normal", "adversarial"]},
        "description": {"type": "string"}, "spec": {"type": "array", "items": {"type": "string"}},
        "spec_context": {"type": "string"}, "concurrency": {"type": "integer", "minimum": 0},
        "max_rounds": {"type": "integer", "minimum": 1},
    }, ["workspace", "kind"]),
    "review_resume": ("List incomplete rounds, or resume the selected round and wait for its final result.", {
        "workspace": {"type": "string"}, "run_dir": {"type": "string"},
    }, ["workspace"]),
    "review_next": ("Run the next adversarial round and wait for the final result.", {
        "workspace": {"type": "string"}, "run_dir": {"type": "string"},
        "fixed": {"type": "array", "minItems": 1, "items": {"type": "integer", "minimum": 1}},
        "known_issues": {"type": "string"},
    }, ["workspace", "run_dir", "fixed", "known_issues"]),
}


def descriptor(name, spec):
    description, fields, required = spec
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": fields, "required": required,
                            "additionalProperties": False},
            "annotations": {"readOnlyHint": False,
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
        self.child_env = dict(os.environ)
        data = os.environ.get("PLUGIN_DATA")
        previous_data = None
        for parent in ROOT.parents:
            if parent.name == "cache" and parent.parent.name == "plugins":
                self.child_env.setdefault("CODEX_HOME", str(parent.parent.parent))
                if data is None:
                    # Preserve repository approvals from the portable package.
                    market = ROOT.parent.parent.name
                    plugin = ROOT.parent.name
                    identity = hashlib.sha256(f"{market}\0{plugin}".encode()).hexdigest()
                    storage = parent.parent / "data" / "agent-plugins"
                    data = storage / identity
                    previous_data = storage / identity[:32]
                break
        if data is None:
            raise ValueError("Install the code-review plugin before starting its launcher")
        self.data = Path(data)
        self.previous_data = previous_data
        self.data.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.inbox = queue.Queue()
        self.deferred = []
        self.closing = False

    def send(self, message):
        print(json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=True), flush=True)

    def read(self):
        for line in sys.stdin:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict):
                self.inbox.put(message)
        self.inbox.put(None)

    def scope(self, workspace, request_id):
        workspace = Path(workspace)
        if not workspace.is_absolute():
            raise ValueError("Pass the absolute Git root from the current Codex workspace")
        repo = repo_root(workspace)
        if repo != workspace.resolve():
            raise ValueError("Pass the Git root of the workspace")
        settings(repo)
        key = hashlib.sha256(os.fsencode(repo)).hexdigest()
        authorization = self.data / f"workspace-{key}.json"
        if authorization.exists() and read_json(authorization) == {"workspace": str(repo)}:
            return repo
        if self.previous_data is not None:
            previous = self.previous_data / authorization.name
            if previous.exists() and read_json(previous) == {"workspace": str(repo)}:
                write_json(authorization, {"workspace": str(repo)})
                return repo
        request = f"workspace-{uuid.uuid4().hex}"
        self.send({
            "id": request, "method": "elicitation/create",
            "params": {"message": f"Authorize code review for {repo}? The selected model provider "
                       "will receive review context from this repository.",
                       "requestedSchema": {"type": "object", "required": ["authorize"],
                                           "properties": {"authorize": {"type": "boolean",
                                               "title": "Authorize this repository"}}}},
        })
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            reply = self.receive_during_call(request_id, min(1, deadline - time.monotonic()))
            if reply is None:
                continue
            if reply.get("id") != request or "method" in reply:
                self.deferred.append(reply)
                continue
            answer = reply.get("result", {})
            content = answer.get("content") or {}
            if answer.get("action") != "accept" or content.get("authorize") is not True:
                raise ValueError("Repository approval was declined")
            write_json(authorization, {"workspace": str(repo)})
            return repo
        raise ValueError("Repository approval timed out")

    def receive_during_call(self, request_id, timeout):
        if self.closing:
            raise InterruptedError
        try:
            message = self.inbox.get(timeout=max(0, timeout))
        except queue.Empty:
            return None
        if message is None:
            self.closing = True
            raise InterruptedError
        if message.get("method") == "notifications/cancelled":
            cancelled = message.get("params", {}).get("requestId")
            if cancelled == request_id:
                raise InterruptedError
            self.deferred = [pending for pending in self.deferred if pending.get("id") != cancelled]
            return None
        if message.get("method") == "ping" and "id" in message:
            self.send({"id": message["id"], "result": {}})
            return None
        return message

    def call(self, name, args, request_id):
        validate(name, args)
        repo = self.scope(args["workspace"], request_id)
        if name == "review_run":
            argv = ["run", "--backend", "codex", *options(args, [
                "mode", "description", "spec", "spec_context", "concurrency", "max_rounds"]),
                "--", args["kind"], *args.get("values", [])]
        elif name == "review_resume":
            argv = ["resume", "--", *([args["run_dir"]] if args.get("run_dir") else [])]
        else:
            argv = ["next", *options(args, ["fixed", "known_issues"]), "--", args["run_dir"]]
        with tempfile.TemporaryFile(mode="w+", encoding="utf-8", dir=self.data) as output:
            process = subprocess.Popen(
                [sys.executable, "-B", str(ROOT / "scripts/review.py"), "--repo", str(repo), *argv],
                cwd=repo, env=self.child_env, stdin=subprocess.DEVNULL, stdout=output, stderr=sys.stderr,
            )
            try:
                while process.poll() is None:
                    message = self.receive_during_call(request_id, 0.25)
                    if message is not None:
                        self.deferred.append(message)
                output.seek(0)
                try:
                    return json.load(output)
                except ValueError as error:
                    raise ValueError(
                        f"Review runner exited {process.returncode} without a result. Use review_resume."
                    ) from error
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait()

    def stop(self, *_):
        self.closing = True
        self.inbox.put(None)

    def serve(self):
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        threading.Thread(target=self.read, daemon=True).start()
        while not self.closing:
            request = self.deferred.pop(0) if self.deferred else self.inbox.get()
            if request is None:
                break
            method = request.get("method")
            if "id" not in request or method is None:
                continue
            request_id = request["id"]
            params = request.get("params", {})
            if method == "initialize":
                result = {"protocolVersion": params.get("protocolVersion", "2025-03-26"),
                          "capabilities": {"tools": {}},
                          "serverInfo": {"name": "code-review", "version": "1.0.5"}}
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": [descriptor(name, spec) for name, spec in TOOLS.items()]}
            elif method == "tools/call":
                try:
                    data = self.call(params.get("name"), params.get("arguments", {}), request_id)
                except InterruptedError:
                    continue
                except (ValueError, OSError, subprocess.SubprocessError) as error:
                    data = {"status": "error", "error": str(error)}
                result = {"content": [{"type": "text", "text": json.dumps(data)}],
                          "isError": data.get("status") == "error"}
            else:
                self.send({"id": request_id, "error": {"code": -32601, "message": "Method not found"}})
                continue
            self.send({"id": request_id, "result": result})


if __name__ == "__main__":
    Launcher().serve()
