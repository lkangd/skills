"""Git snapshot and review plan shared by the plugin entry points."""

import hashlib
import json
import math
import os
import re
import shlex
import subprocess
import tempfile
from dataclasses import dataclass
from itertools import islice
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = Path(".code-review/runs")
CONFIG = Path(".code-review/config.local.json")
CONFIG_TEMPLATE = {
    "concurrency": 4,
    "max_rounds": 3,
    "backlog_dir": "docs/code-review-backlog",
    "claude": {"runner": "claude"},
    "codex": {},
    "pi": {},
}
NORMAL = ["correctness", "removed-behavior", "callers", "cleanup", "conventions"]
DEEP = ["design", "pitfalls", "wrapper"]
LEVELS = ("low", "medium", "high")
BACKENDS = ("claude", "codex", "pi")
STANDARDS = (
    "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "CODING_STANDARDS.md",
    "CODE_STYLE.md", "STYLE_GUIDE.md", "STYLEGUIDE.md", ".cursorrules",
    "docs/CONTRIBUTING.md", "docs/CODING_STANDARDS.md", "docs/STYLE_GUIDE.md",
    ".github/CONTRIBUTING.md",
)


def atomic_text(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as temp:
        try:
            temp.write(value)
            temp.close()
            os.replace(temp.name, path)
        finally:
            Path(temp.name).unlink(missing_ok=True)


def write_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=True, indent=2, allow_nan=False) + "\n")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def config_path(repo):
    path = repo / CONFIG
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError(f"{CONFIG} must be inside the current repository")
    return path


def settings(repo):
    path = config_path(repo)
    if not path.is_file():
        raise ValueError(f"Missing {CONFIG}. Run code-review setup and confirm the complete configuration.")
    return validate_settings(repo, read_json(path))


def save_settings(repo, value):
    path = config_path(repo)
    result = validate_settings(repo, value)
    path.parent.mkdir(exist_ok=True)
    write_json(path, result)
    return result


def validate_settings(repo, result):
    if not isinstance(result, dict):
        raise ValueError(f"{CONFIG} must contain a JSON object")
    missing = CONFIG_TEMPLATE.keys() - result.keys()
    if missing:
        raise ValueError(f"Incomplete {CONFIG}: missing {', '.join(sorted(missing))}. "
                         "Run code-review setup to confirm the complete configuration.")
    for key, minimum in (("concurrency", 0), ("max_rounds", 1)):
        if type(result[key]) is not int or result[key] < minimum:
            raise ValueError(f"{key} must be an integer of at least {minimum}")
    backlog = result["backlog_dir"]
    if not isinstance(backlog, str) or not backlog.strip():
        raise ValueError("backlog_dir must be a repository-relative path")
    relative = Path(backlog)
    if (relative.is_absolute() or relative == Path(".") or ".." in relative.parts
            or not (repo / relative).resolve().is_relative_to(repo)):
        raise ValueError("backlog_dir must be a repository-relative path")
    for backend in BACKENDS:
        if not isinstance(result[backend], dict):
            raise ValueError(f"{backend} settings must be an object")
        profiles = result[backend].get("models", {})
        if not isinstance(profiles, dict) or set(profiles) - set(LEVELS):
            raise ValueError(f"{backend}.models must map low, medium or high to settings")
        for profile in profiles.values():
            if not isinstance(profile, dict) or set(profile) - {"model", "effort"}:
                raise ValueError(f"{backend} model profiles accept model and effort")
            if any(not isinstance(item, str) or not item.strip()
                   or any(char in item for char in "\0\r\n") for item in profile.values()):
                raise ValueError(f"{backend} model and effort overrides must be nonempty strings")
        if backend == "claude" or "runner" in result[backend]:
            try:
                runner_command(result[backend].get("runner"))
            except ValueError as error:
                raise ValueError(f"{backend}.runner must select an external Claude, Codex or Pi runner") from error
    return result


def runner_command(runner):
    harness = None
    if isinstance(runner, dict) and set(runner) == {"harness", "command"}:
        harness = runner["harness"]
        if harness not in BACKENDS:
            raise ValueError("Unknown runner harness")
        runner = runner["command"]
    if not isinstance(runner, str) or any(char in runner for char in "\0\n\r"):
        raise ValueError("Expected an external runner command")
    argv = shlex.split(runner)
    if not argv or not argv[0] or Path(argv[0]).name == "in-session":
        raise ValueError("Expected an external runner command")
    executable = Path(argv[0]).name
    return harness or (executable if executable in BACKENDS else "claude"), argv


def claude_runner_argv(runner):
    harness, argv = runner_command(runner)
    if harness != "claude":
        raise ValueError("Expected a Claude-compatible runner command")
    return argv


def git(repo, *args, data=None, env=None):
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(repo), *args],
                            input=data, capture_output=True, env=env)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors="replace").strip() or f"git {args[0]} failed")
    return result.stdout


def repo_root(cwd):
    return Path(os.fsdecode(git(cwd, "rev-parse", "--show-toplevel").rstrip(b"\n"))).resolve()


def commit(repo, ref):
    return git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}").decode().strip()


def target(repo, kind, values):
    if kind in ("staged", "working-tree") and not values:
        return {"kind": kind, "refs": [commit(repo, "HEAD")], "paths": []}
    if kind == "files" and values:
        paths = []
        for value in values:
            if not value or Path(value).is_absolute() or ".." in Path(value).parts:
                raise ValueError("review paths must be relative to the repository root")
            paths.append(value)
        return {"kind": kind, "refs": [commit(repo, "HEAD")], "paths": paths}
    if kind == "commit" and len(values) in (1, 2):
        left, right = values[0], values[-1]
        left_id = commit(repo, left)
        try:
            before = commit(repo, left_id + "^")
        except ValueError:
            before = git(repo, "hash-object", "-t", "tree", "--stdin", data=b"").decode().strip()
        return {"kind": kind, "refs": [before, commit(repo, right)], "paths": []}
    if kind == "branch" and len(values) == 1:
        head = commit(repo, "HEAD")
        base = git(repo, "merge-base", commit(repo, values[0]), head).decode().strip()
        return {"kind": kind, "refs": [base, head], "paths": []}
    raise ValueError("expected an explicit staged, working-tree, files, commit or branch target")


@dataclass(frozen=True)
class Change:
    path: str
    patch: str
    weight: int


def split_paths(raw):
    paths = []
    for path in raw.split(b"\0"):
        if not path:
            continue
        try:
            paths.append(path.decode("utf-8"))
        except UnicodeDecodeError:
            raise ValueError(f"Cannot review a Git path that is not UTF-8: {path!r}") from None
    return paths


def diff_changes(repo, args, paths, env=None):
    options = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--find-renames",
               "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/"]
    command = ["--literal-pathspecs", "-c", "core.quotePath=false", "diff", *options]
    names = split_paths(git(repo, *command, "--name-only", "-z", *args, "--", *paths, env=env))
    patch = git(repo, *command, "--patch", *args, "--", *paths, env=env).decode("utf-8", errors="replace")
    sections = re.split(r"(?m)(?=^diff --git )", patch)[1:]
    if len(names) != len(sections):
        raise ValueError("Git returned different file and patch lists. Check the Git diff configuration.")
    return [Change(name, section, patch_weight(section)) for name, section in zip(names, sections)]


def patch_weight(patch):
    body = patch.split("\n")
    if patch.startswith("diff --git "):
        first_hunk = next((i for i, line in enumerate(body) if line.startswith("@@ ")), len(body))
        body = body[first_hunk:]
    return max(1, sum(line.startswith(("+", "-")) for line in body))


def untracked_paths(repo, paths):
    names = split_paths(git(repo, "--literal-pathspecs", "ls-files", "--others", "--exclude-standard",
                            "-z", "--", *paths))
    return [name for name in names if Path(name).parts[0] != ".code-review"]


def untracked(repo, paths, names=None, line_limit=None):
    for name in untracked_paths(repo, paths) if names is None else names:
        path = repo / name
        if path.is_symlink():
            yield Change(name, f"### {name}\nSymbolic link to {os.readlink(path)}.\n", 1)
        elif path.is_file():
            data = path.read_bytes()
            binary = b"\0" in data
            lines = [] if binary else data.decode("utf-8", errors="replace").splitlines(keepends=True)
            excerpt = "(binary content omitted)" if binary else "".join(lines[:line_limit])
            checksum = hashlib.sha256(data).hexdigest()
            yield Change(name, f"### {name} (untracked, {len(lines)} lines, sha256 {checksum})\n"
                         f"````\n{excerpt}\n````\n", max(1, len(lines)))


def staged_scope(repo, project, selection):
    # Use private Git state to apply the post-launch worktree delta to the original index.
    objects = project / "staged-objects"
    objects.mkdir(exist_ok=True)
    if objects.resolve() != objects:
        raise ValueError("staged review objects must stay inside the run directory")
    git_objects = os.fsdecode(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "objects")
                              .rstrip(b"\n"))
    with tempfile.TemporaryDirectory(dir=project) as scratch:
        env = {**os.environ, "GIT_OBJECT_DIRECTORY": str(objects),
               "GIT_ALTERNATE_OBJECT_DIRECTORIES": git_objects,
               "GIT_INDEX_FILE": str(Path(scratch) / "index")}
        index = git(repo, "ls-files", "--stage", "-z")
        modified = set(git(repo, "diff-files", "--name-only", "--no-ext-diff",
                           "--no-textconv", "-z").split(b"\0"))
        git(repo, "update-index", "-z", "--index-info", data=index, env=env)
        staged = selection.get("staged_tree")
        if staged is None:
            staged = git(repo, "write-tree", env=env).decode().strip()
        entries = []
        for entry in index.rstrip(b"\0").split(b"\0") if index else ():
            attributes, name = entry.split(b"\t", 1)
            if name not in modified:
                continue
            mode, oid, _ = attributes.split()
            path = repo / os.fsdecode(name)
            inside = path.parent.resolve().is_relative_to(repo)
            if mode == b"160000" and inside and path.is_dir() and not path.is_symlink():
                if (path / ".git").exists():
                    head = commit(path, "HEAD").encode()
                    entries.append(mode + b" " + head + b"\t" + name + b"\0")
                continue
            if inside and path.is_symlink():
                contents, mode = os.fsencode(os.readlink(path)), b"120000"
            elif inside and path.is_file():
                contents = path.read_bytes()
                mode = b"100755" if path.stat().st_mode & 0o111 else b"100644"
            else:
                entries.append(b"0 " + b"0" * len(oid) + b"\t" + name + b"\0")
                continue
            blob = git(repo, "hash-object", "-w", "--stdin", data=contents, env=env).strip()
            entries.append(mode + b" " + blob + b"\t" + name + b"\0")
        git(repo, "update-index", "-z", "--index-info", data=b"".join(entries), env=env)
        worktree = git(repo, "write-tree", env=env).decode().strip()
        if "staged_tree" not in selection:
            return staged, worktree
        delta = git(repo, "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv",
                    "--no-color", "--no-relative", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/",
                    selection["staged_worktree"], worktree, env=env)
        if delta:
            git(repo, "read-tree", staged, env=env)
            try:
                git(repo, "apply", "--cached", "--3way", "--whitespace=nowarn", "-", data=delta, env=env)
            except ValueError as error:
                raise ValueError("Post-launch edits overlap pre-existing unstaged changes. "
                                 "The staged review cannot isolate the follow-up patch.") from error
            staged = git(repo, "write-tree", env=env).decode().strip()
        return diff_changes(repo, [selection["refs"][0], staged], [], env=env)


def snapshot(repo, selection, subsequent=False, project=None):
    kind, refs, paths = (selection[key] for key in ("kind", "refs", "paths"))
    if subsequent and kind == "staged" and "staged_tree" in selection:
        changes = staged_scope(repo, project, selection)
        changes.extend(new_untracked(repo, selection))
        return changes
    if subsequent and kind in ("commit", "branch", "staged"):
        # Review the original target plus the working-tree delta since that round started.
        # Compare against the saved baseline so unrelated pre-existing edits stay outside it.
        current = {change.path: change for change in diff_changes(repo, [refs[0]], [])}
        initial = {item["path"]: Change(**item) for item in selection["initial_changes"]}
        workspace_before = selection["workspace_before"]
        scope = initial.keys() | {
            path for path in current.keys() | workspace_before.keys()
            if workspace_before.get(path) != (digest(current[path].patch) if path in current else None)
        }
        changes = []
        for path in sorted(scope):
            now = current.get(path)
            if workspace_before.get(path) == (digest(now.patch) if now else None):
                if path in initial:
                    changes.append(initial[path])
            elif now:
                changes.append(now)
        changes.extend(new_untracked(repo, selection, initial))
        return changes
    args = [*refs, "--cached"] if kind == "staged" else refs
    changes = diff_changes(repo, args, paths)
    if kind in ("working-tree", "files"):
        changes.extend(untracked(repo, paths))
    return changes


def digest(value):
    return hashlib.sha256(value.encode("utf-8", errors="surrogateescape")).hexdigest()


def fingerprints(changes):
    return {change.path: digest(change.patch) for change in changes}


def untracked_state(repo):
    return workspace_fingerprints(repo, untracked_paths(repo, []))


def new_untracked(repo, selection, include=()):
    if "untracked_state" not in selection:
        before = selection["untracked_before"]
        current = fingerprints(untracked(repo, [], line_limit=400))
    else:
        before = selection["untracked_state"]
        current = untracked_state(repo)
    names = [name for name in current if name in include or current[name] != before.get(name)]
    return list(untracked(repo, [], names=names))


def workspace_fingerprints(repo, paths):
    fingerprints = {}
    for name in paths:
        path = repo / name
        if not path.parent.resolve().is_relative_to(repo):
            fingerprints[name] = None
        elif path.is_symlink():
            fingerprints[name] = ["link", digest(os.readlink(path))]
        elif path.is_file():
            try:
                with path.open("rb") as source:
                    checksum = hashlib.sha256()
                    for block in iter(lambda: source.read(65536), b""):
                        checksum.update(block)
                    fingerprints[name] = ["file", bool(os.fstat(source.fileno()).st_mode & 0o111),
                                          checksum.hexdigest()]
            except (FileNotFoundError, IsADirectoryError):
                fingerprints[name] = None
        else:
            fingerprints[name] = ["directory"] if path.is_dir() else None
    return fingerprints


def conventions(repo, changes):
    names = dict.fromkeys(STANDARDS)
    for change in changes:
        for directory in Path(change.path).parents:
            if directory == Path("."):
                break
            for name in ("CLAUDE.md", "AGENTS.md"):
                names[str(directory / name)] = None
    excerpts = []
    for name in names:
        path = repo / name
        if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(repo):
            with path.open(encoding="utf-8", errors="replace") as source:
                excerpt = "".join(islice(source, 300))
            excerpts.append(f"### {name}\n````\n{excerpt}\n````\n")
    return excerpts


def complexity(angle, changes):
    if angle in ("cleanup", "conventions"):
        return "low"
    weight = sum(change.weight for change in changes)
    if angle in ("design", "pitfalls", "wrapper", "spec", "sweep", "re-review"):
        return "high"
    if angle in ("correctness", "removed-behavior", "callers") and (len(changes) >= 4 or weight >= 500):
        return "high"
    return "medium"


HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


def split_hunk(hunk, line_budget, byte_budget):
    lines = hunk.split("\n")
    match = HUNK.fullmatch(lines[0])
    body = [line + "\n" for line in lines[1:-1]]
    if lines[-1]:
        body.append(lines[-1])
    if not match or (patch_weight(hunk) <= line_budget and len(hunk.encode()) <= byte_budget):
        return [hunk]
    old, new = int(match[1]), int(match[3])
    # In a zero-count range Git gives the line preceding the insertion or deletion.
    old += match[2] == "0"
    new += match[4] == "0"
    groups = []
    current = []
    old_count = new_count = size = 0
    for line in body:
        if current and line.startswith((" ", "+", "-")) and (
            len(current) >= line_budget or size + len(line.encode()) > byte_budget
        ):
            groups.append((old, new, old_count, new_count, current))
            old += old_count
            new += new_count
            current = []
            old_count = new_count = size = 0
        current.append(line)
        size += len(line.encode())
        old_count += line.startswith((" ", "-"))
        new_count += line.startswith((" ", "+"))
    if current:
        groups.append((old, new, old_count, new_count, current))
    return [f"@@ -{a - (a_count == 0)},{a_count} +{b - (b_count == 0)},{b_count} @@{match[5]}\n"
            + "".join(body) for a, b, a_count, b_count, body in groups]


def pieces(change, line_budget, byte_budget):
    if len(change.patch.encode()) <= byte_budget and change.weight <= line_budget:
        return [change]
    if not change.patch.startswith("diff --git "):
        header, fence, body = change.patch.partition("\n````\n")
        if fence and body.endswith("\n````\n"):
            lines = body[:-len("\n````\n")].splitlines(keepends=True)
            parts = []
            start = size = 0
            budget = max(1, byte_budget - len(header.encode()) - 80)
            for end, line in enumerate(lines):
                line_size = len(line.encode())
                if end > start and (size + line_size > budget or end - start >= line_budget):
                    excerpt = "".join(lines[start:end])
                    parts.append(Change(change.path, f"{header}, lines {start + 1}–{end}{fence}"
                                        f"{excerpt}\n````\n", end - start))
                    start, size = end, 0
                size += line_size
            if start < len(lines):
                excerpt = "".join(lines[start:])
                parts.append(Change(change.path, f"{header}, lines {start + 1}–{len(lines)}{fence}"
                                    f"{excerpt}\n````\n", len(lines) - start))
            if parts:
                return parts
        return [change]
    header, *hunks = re.split(r"(?m)(?=^@@ -)", change.patch)
    if not hunks:
        return [change]
    budget = max(1, byte_budget - len(header.encode()) - 120)
    return [Change(change.path, header + chunk, patch_weight(chunk))
            for hunk in hunks for chunk in split_hunk(hunk, line_budget, budget)]


def balance(changes, slots, context_window=None, overhead=0, prefer_unsplit=False):
    if not changes:
        return [[]]
    # Reserve room for instructions, output and reading surrounding code. Byte estimates are
    # conservative for diffs and remain useful when the harness publishes no context limit.
    available = max(1, int((context_window or 100_000) * 2 - overhead))
    total = sum(change.weight for change in changes)
    total_bytes = sum(len(change.patch.encode()) for change in changes)
    fits = total_bytes <= available
    if fits and (prefer_unsplit or total <= 1100):
        return [changes]
    part_lines = min(2400, max(600, math.ceil(total / max(2, slots))))
    units = [part for change in changes for part in pieces(
        change, part_lines if change.weight > 2400 or len(change.patch.encode()) > available
        else 2400, available
    )]
    ideal = max(2, math.ceil(total / 1250), math.ceil(total_bytes / available))
    by_directory = {}
    for unit in units:
        by_directory.setdefault(str(Path(unit.path).parent), []).append(unit)
    groups = list(by_directory.values())
    group_target = max(total / min(ideal, slots), 1)
    groups = [piece for group in groups for piece in (
        [group] if sum(unit.weight for unit in group) <= 1.3 * group_target
        and sum(len(unit.patch.encode()) for unit in group) <= available else [[unit] for unit in group]
    )]
    for count in range(min(ideal, slots, len(groups)), min(slots, len(groups)) + 1):
        if count <= 1:
            continue
        buckets = [[] for _ in range(count)]
        weights = [0] * count
        sizes = [0] * count
        def group_weight(group):
            return sum(unit.weight for unit in group)
        for group in sorted(groups, key=lambda g: (-max(group_weight(g) / group_target,
                                                        sum(len(unit.patch.encode()) for unit in g) / available),
                                                   g[0].path)):
            size = sum(len(unit.patch.encode()) for unit in group)
            index = min(range(count), key=lambda i: (max(
                (weights[i] + group_weight(group)) / group_target,
                (sizes[i] + size) / available,
            ), i))
            buckets[index].extend(group)
            weights[index] += group_weight(group)
            sizes[index] += size
        if max(sizes) > available:
            continue
        if not fits or (min(weights) >= total / count * 0.45 and max(weights) <= total * 0.78):
            return buckets
        break
    if not fits:
        raise ValueError("The review target exceeds the model context available for a coherent slice. "
                         "Narrow the target or configure a model with a larger context window.")
    return [changes]


def render_prompt(template, run, repo, packet_note, known):
    contract = (ROOT / "references/receipt-contract.md").read_text()
    fields = {"PACKET_PATH": str(run / "packet.md"), "PACKET_NOTE": packet_note,
              "REPO_ROOT": str(repo), "KNOWN_ISSUES": known, "RECEIPT_CONTRACT": contract}
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda match: fields.get(match[1], match[0]), template)
