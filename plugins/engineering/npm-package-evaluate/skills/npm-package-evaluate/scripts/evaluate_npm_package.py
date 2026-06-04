#!/usr/bin/env python3
"""Evaluate an npm package before installation.

This script avoids installing into the user's project and disables package
lifecycle scripts. It gathers npm registry metadata, downloads the package
tarball with `npm pack --ignore-scripts`, optionally creates an isolated
temporary package-lock for `npm audit`, caches package facts in a temp directory,
and prints an agent-friendly recommendation for the current usage context.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

CACHE_ROOT = Path(os.environ.get("TMPDIR") or "/tmp") / "claude-npm-package-evaluate"
SCHEMA_VERSION = "1.2"
BOT_NAME_RE = re.compile(r"(bot|dependabot|renovate|github-actions)", re.I)
INSTALL_SCRIPT_RE = re.compile(r"(^|:)(preinstall|install|postinstall)$")
SUSPICIOUS_SCRIPT_RE = re.compile(
    r"(curl|wget|Invoke-WebRequest|powershell|bash\s+-c|sh\s+-c|nc\s|netcat|\.env|process\.env|"
    r"base64|atob|eval\(|Function\(|child_process|rm\s+-rf|chmod\s+\+x|ssh|scp|token|secret|password)",
    re.I,
)
SUSPICIOUS_SOURCE_RE = re.compile(
    r"(child_process|execSync|spawnSync|process\.env|os\.homedir|\.npmrc|eval\(|Function\(|"
    r"atob|fromCharCode|base64|curl|wget|powershell|token|secret|password|private[_-]?key)"
)
SUSPICIOUS_FILE_RE = re.compile(r"(\.npmrc$|id_rsa|\.pem$|\.p12$|\.key$|token|secret|password)", re.I)
SOURCE_FILE_RE = re.compile(r"\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$", re.I)
NATIVE_BINARY_RE = re.compile(r"\.(node|wasm|dll|dylib|exe|so)$", re.I)
NATIVE_BUILD_RE = re.compile(r"(^|/)(binding\.gyp|CMakeLists\.txt|Makefile)$|\.(cc|cpp|cxx|h|hpp)$", re.I)
ACTION_USE_RE = re.compile(r"uses:\s*([^\s#]+)")
FULL_SHA_RE = re.compile(r"@[0-9a-f]{40}$", re.I)
MUTABLE_ACTION_RE = re.compile(r"@(main|master|latest|v\d+|v\d+\.\d+|v\d+\.\d+\.\d+)$", re.I)


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 60) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired as exc:
        return 124, exc.stdout or "", exc.stderr or f"Command timed out after {timeout}s"


def npm_json(args: list[str], timeout: int = 60) -> Any:
    code, out, err = run(["npm", *args, "--json"], timeout=timeout)
    if code != 0:
        raise RuntimeError((err or out or "npm command failed").strip())
    if not out.strip():
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"npm returned non-JSON output: {exc}: {out[:500]}") from exc


def parse_specifier(specifier: str) -> tuple[str, str | None]:
    """Return package name and optional explicit version/range.

    Handles scoped names such as @scope/pkg@1.2.3.
    """
    if specifier.startswith("@"):
        slash = specifier.find("/")
        if slash == -1:
            return specifier, None
        at = specifier.find("@", slash + 1)
        if at == -1:
            return specifier, None
        return specifier[:at], specifier[at + 1 :]
    if "@" in specifier:
        name, version = specifier.rsplit("@", 1)
        return name, version or None
    return specifier, None


def safe_cache_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.@-]+", "_", name).replace("/", "__")


def cache_path(name: str, version: str) -> Path:
    # Cache package facts by resolved package@version. Decisions are recomputed
    # for each run because prod/dev/tool risk tolerance differs.
    return CACHE_ROOT / safe_cache_name(name) / version / "facts.json"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def days_since(iso_like: str | None) -> int | None:
    if not iso_like:
        return None
    try:
        parsed = dt.datetime.fromisoformat(iso_like.replace("Z", "+00:00"))
        delta_days = (dt.datetime.now(dt.timezone.utc) - parsed).days
        return max(0, delta_days)
    except Exception:
        return None


def parse_time(iso_like: str | None) -> dt.datetime | None:
    if not iso_like:
        return None
    try:
        return dt.datetime.fromisoformat(iso_like.replace("Z", "+00:00"))
    except Exception:
        return None


def signal(sig_id: str, status: str, severity: str, message: str, evidence: Any = None) -> dict[str, Any]:
    result = {"id": sig_id, "status": status, "severity": severity, "message": message}
    if evidence is not None:
        result["evidence"] = evidence
    return result


def lockfile_package_name(path: str) -> str:
    parts = path.split("node_modules/")
    if len(parts) < 2:
        return path or "root"
    name = parts[-1]
    if name.startswith("@"):
        scope_parts = name.split("/", 2)
        return "/".join(scope_parts[:2])
    return name.split("/", 1)[0]


def npm_registry_host(url: str, allowed_hosts: set[str] | None = None) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    expected_hosts = allowed_hosts or {"registry.npmjs.org", "registry.npmjs.com"}
    return host in expected_hosts


def npm_registry_hosts() -> set[str]:
    hosts = {"registry.npmjs.org", "registry.npmjs.com"}
    code, out, _ = run(["npm", "config", "get", "registry"], timeout=20)
    if code == 0:
        parsed = urllib.parse.urlparse(out.strip())
        if parsed.netloc:
            hosts.add(parsed.netloc.lower())
    return hosts


def extract_repo_url(meta: dict[str, Any]) -> str | None:
    repo = meta.get("repository")
    if isinstance(repo, str):
        raw = repo
    elif isinstance(repo, dict):
        raw = repo.get("url") or repo.get("directory")
    else:
        raw = None
    return normalize_repo_url(raw)


def normalize_repo_url(raw: Any) -> str | None:
    if not raw or not isinstance(raw, str):
        return None
    value = raw.strip()
    value = re.sub(r"^(git\+|git://)", "", value)
    value = re.sub(r"\.git$", "", value)
    if value.startswith("github:"):
        value = "https://github.com/" + value[len("github:") :]
    if value.startswith("git@github.com:"):
        value = "https://github.com/" + value[len("git@github.com:") :]
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        value = "https://github.com/" + value
    return value


def comparable_repo_url(raw: Any) -> str | None:
    normalized = normalize_repo_url(raw)
    if not normalized:
        return None
    parsed = urllib.parse.urlparse(normalized)
    host = parsed.netloc.lower().removeprefix("www.")
    path = parsed.path.strip("/").removesuffix(".git").lower()
    if not host or not path:
        return normalized.lower().rstrip("/")
    return f"{host}/{path}"


def github_owner_repo(repo_url: str | None) -> tuple[str, str] | None:
    if not repo_url:
        return None
    parsed = urllib.parse.urlparse(repo_url)
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        return None
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    if len(parts) < 2:
        return None
    return parts[0], parts[1].removesuffix(".git")


def github_api(path: str, timeout: int = 20) -> Any | None:
    url = "https://api.github.com" + path
    headers = {"User-Agent": "claude-code-npm-package-evaluate"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def inspect_github(repo_url: str | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    gh = github_owner_repo(repo_url)
    details: dict[str, Any] = {"repository": repo_url, "github": None}
    if not gh:
        return [signal("repository", "unknown", "medium", "Repository is missing or not hosted on GitHub.", repo_url)], details

    owner, repo = gh
    details["github"] = {"owner": owner, "repo": repo}
    signals: list[dict[str, Any]] = []

    repo_data = github_api(f"/repos/{owner}/{repo}")
    if not isinstance(repo_data, dict):
        signals.append(signal("github_access", "unknown", "medium", "Could not inspect GitHub repository metadata."))
        return signals, details

    details["github"].update(
        {
            "default_branch": repo_data.get("default_branch"),
            "archived": repo_data.get("archived"),
            "stars": repo_data.get("stargazers_count"),
            "open_issues": repo_data.get("open_issues_count"),
            "pushed_at": repo_data.get("pushed_at"),
        }
    )

    if repo_data.get("archived"):
        signals.append(signal("repository_archived", "red", "high", "GitHub repository is archived."))
    else:
        signals.append(signal("repository_archived", "green", "low", "GitHub repository is not archived."))

    pushed_days = days_since(repo_data.get("pushed_at"))
    if pushed_days is None:
        signals.append(signal("recent_activity", "unknown", "medium", "Could not determine recent repository activity."))
    elif pushed_days <= 180:
        signals.append(signal("recent_activity", "green", "low", f"Repository was pushed {pushed_days} days ago."))
    elif pushed_days <= 730:
        signals.append(signal("recent_activity", "yellow", "medium", f"Repository has limited recent activity: last push {pushed_days} days ago."))
    else:
        signals.append(signal("recent_activity", "red", "high", f"Repository appears stale: last push {pushed_days} days ago."))

    contributors = github_api(f"/repos/{owner}/{repo}/contributors?per_page=10")
    if isinstance(contributors, list) and contributors:
        humanish = [c for c in contributors if not BOT_NAME_RE.search(str(c.get("login", "")))]
        details["github"]["top_contributors"] = [c.get("login") for c in humanish[:5]]
        if len(humanish) >= 3:
            signals.append(signal("maintainer_concentration", "green", "low", f"Repository has {len(humanish)} visible non-bot top contributors."))
        elif len(humanish) == 1:
            signals.append(signal("maintainer_concentration", "yellow", "medium", "Repository appears concentrated around one visible maintainer."))
        else:
            signals.append(signal("maintainer_concentration", "yellow", "medium", "Repository has few visible non-bot contributors."))
    else:
        signals.append(signal("maintainer_concentration", "unknown", "medium", "Could not inspect repository contributors."))

    # Security policy endpoint returns 404 if absent.
    security_policy = github_api(f"/repos/{owner}/{repo}/community/profile")
    files = security_policy.get("files", {}) if isinstance(security_policy, dict) else {}
    if isinstance(files, dict) and files.get("code_of_conduct") is not None:
        details["github"]["community_profile_seen"] = True
    security_file = files.get("security_policy") if isinstance(files, dict) else None
    if security_file:
        signals.append(signal("security_policy", "green", "low", "Repository has a GitHub security policy."))
    else:
        signals.append(signal("security_policy", "yellow", "medium", "No SECURITY.md/GitHub security policy was detected."))

    workflows = github_api(f"/repos/{owner}/{repo}/contents/.github/workflows")
    if isinstance(workflows, list) and workflows:
        signals.append(signal("ci_workflows", "green", "low", f"Repository has {len(workflows)} GitHub Actions workflow file(s)."))
        mutable_refs: list[str] = []
        provenance_hint = False
        workflow_names = [w.get("name") for w in workflows if isinstance(w, dict)]
        details["github"]["workflow_files"] = workflow_names
        for wf in workflows[:8]:
            if not isinstance(wf, dict) or wf.get("type") != "file":
                continue
            download_url = wf.get("download_url")
            if not download_url:
                continue
            try:
                with urllib.request.urlopen(download_url, timeout=15) as resp:
                    text = resp.read().decode("utf-8", errors="replace")
            except Exception:
                continue
            if "--provenance" in text or "id-token: write" in text:
                provenance_hint = True
            for match in ACTION_USE_RE.finditer(text):
                ref = match.group(1).strip().strip("'\"")
                if FULL_SHA_RE.search(ref):
                    continue
                if MUTABLE_ACTION_RE.search(ref):
                    mutable_refs.append(ref)
        if provenance_hint:
            signals.append(signal("trusted_publish_workflow", "green", "low", "Workflow hints at provenance/OIDC publishing."))
        else:
            signals.append(signal("trusted_publish_workflow", "yellow", "medium", "No provenance/OIDC publishing hints found in sampled workflows."))
        if mutable_refs:
            signals.append(signal("pinned_actions", "yellow", "medium", "Some GitHub Actions use mutable refs instead of full SHAs.", mutable_refs[:10]))
        else:
            signals.append(signal("pinned_actions", "green", "low", "No mutable GitHub Action refs found in sampled workflows."))
    elif isinstance(workflows, list):
        signals.append(signal("ci_workflows", "yellow", "medium", "No GitHub Actions workflows were found."))
    else:
        signals.append(signal("ci_workflows", "unknown", "medium", "Could not inspect GitHub Actions workflows."))

    return signals, details


def pack_and_inspect(specifier: str, temp_root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    pack_dir = temp_root / "pack"
    pack_dir.mkdir(parents=True, exist_ok=True)
    code, out, err = run(["npm", "pack", specifier, "--json", "--pack-destination", str(pack_dir), "--ignore-scripts"], timeout=90)
    details: dict[str, Any] = {"pack_error": None, "files": [], "package_json": None}
    signals: list[dict[str, Any]] = []
    if code != 0:
        details["pack_error"] = (err or out).strip()
        signals.append(signal("tarball_inspection", "unknown", "high", "Could not download package tarball for static inspection.", details["pack_error"][:500]))
        return signals, details

    try:
        pack_info = json.loads(out)[0]
    except Exception:
        pack_info = {}
    tgz_files = list(pack_dir.glob("*.tgz"))
    if not tgz_files:
        signals.append(signal("tarball_inspection", "unknown", "high", "npm pack did not produce a tarball."))
        return signals, details

    tgz = tgz_files[0]
    details["tarball"] = str(tgz)
    details["npm_pack"] = pack_info

    package_json: dict[str, Any] | None = None
    suspicious_files: list[str] = []
    suspicious_source_hits: list[str] = []
    native_files: list[str] = []
    workflow_files: dict[str, str] = {}
    sample_files: list[str] = []

    with tarfile.open(tgz, "r:gz") as tar:
        members = tar.getmembers()
        details["file_count"] = len(members)
        for member in members:
            name = member.name
            rel = name.removeprefix("package/")
            if len(sample_files) < 200:
                sample_files.append(rel)
            if SUSPICIOUS_FILE_RE.search(rel):
                suspicious_files.append(rel)
            if NATIVE_BINARY_RE.search(rel) or NATIVE_BUILD_RE.search(rel):
                native_files.append(rel)
            if member.isfile() and SOURCE_FILE_RE.search(rel) and member.size <= 250_000 and len(suspicious_source_hits) < 20:
                f = tar.extractfile(member)
                if f:
                    text = f.read().decode("utf-8", errors="replace")
                    match = SUSPICIOUS_SOURCE_RE.search(text)
                    if match:
                        suspicious_source_hits.append(f"{rel}: {match.group(0)}")
            if rel == "package.json":
                f = tar.extractfile(member)
                if f:
                    package_json = json.loads(f.read().decode("utf-8", errors="replace"))
            if rel.startswith(".github/workflows/") and rel.endswith((".yml", ".yaml")):
                f = tar.extractfile(member)
                if f:
                    workflow_files[rel] = f.read().decode("utf-8", errors="replace")[:20000]

    details["files"] = sample_files
    details["package_json"] = package_json
    if package_json:
        details["repository"] = extract_repo_url(package_json)

    if package_json:
        scripts = package_json.get("scripts") if isinstance(package_json.get("scripts"), dict) else {}
        install_scripts = {k: v for k, v in scripts.items() if INSTALL_SCRIPT_RE.search(k)}
        if not install_scripts:
            signals.append(signal("install_scripts", "green", "low", "No preinstall/install/postinstall scripts found in package.json."))
        else:
            suspicious = {k: v for k, v in install_scripts.items() if SUSPICIOUS_SCRIPT_RE.search(str(v))}
            status = "red" if suspicious else "yellow"
            severity = "critical" if suspicious else "high"
            msg = "Install scripts contain suspicious tokens." if suspicious else "Package has install scripts; verify they are justified before installing."
            signals.append(signal("install_scripts", status, severity, msg, install_scripts))

        deps = package_json.get("dependencies") if isinstance(package_json.get("dependencies"), dict) else {}
        dep_count = len(deps)
        if dep_count == 0:
            signals.append(signal("dependency_footprint", "green", "low", "Package declares zero runtime dependencies."))
        elif dep_count <= 5:
            signals.append(signal("dependency_footprint", "green", "low", f"Package declares {dep_count} runtime dependencies."))
        elif dep_count <= 20:
            signals.append(signal("dependency_footprint", "yellow", "medium", f"Package declares {dep_count} runtime dependencies; review footprint."))
        else:
            signals.append(signal("dependency_footprint", "red", "high", f"Package declares {dep_count} runtime dependencies; large transitive attack surface."))

        exports = package_json.get("exports")
        main = package_json.get("main")
        types = package_json.get("types") or package_json.get("typings")
        if exports:
            signals.append(signal("modern_exports", "green", "low", "package.json declares an exports field."))
        elif main:
            signals.append(signal("modern_exports", "yellow", "low", "package.json uses main without exports; modern package boundary is absent."))
        else:
            signals.append(signal("modern_exports", "yellow", "medium", "package.json has no exports or main field."))
        if types:
            signals.append(signal("types", "green", "low", "Package declares TypeScript types."))

        bin_entries = package_json.get("bin")
        if bin_entries:
            signals.append(signal("executable_entrypoints", "yellow", "medium", "Package exposes command-line binaries; review executable behavior before broad use.", bin_entries))

        optional_deps = package_json.get("optionalDependencies") if isinstance(package_json.get("optionalDependencies"), dict) else {}
        if optional_deps:
            signals.append(signal("optional_dependencies", "yellow", "medium", f"Package declares {len(optional_deps)} optional dependencies; review platform-specific install surface.", list(optional_deps)[:20]))

        bundled_deps = package_json.get("bundledDependencies") or package_json.get("bundleDependencies")
        if bundled_deps:
            signals.append(signal("bundled_dependencies", "yellow", "high", "Package bundles dependencies into the published artifact; audit visibility may be reduced.", bundled_deps))
    else:
        signals.append(signal("package_json", "red", "critical", "Tarball did not contain package/package.json."))

    if suspicious_files:
        signals.append(signal("suspicious_files", "red", "high", "Tarball contains sensitive-looking file names.", suspicious_files[:20]))
    else:
        signals.append(signal("suspicious_files", "green", "low", "No sensitive-looking file names found in sampled tarball contents."))

    if native_files:
        signals.append(signal("native_or_binary_surface", "yellow", "high", "Tarball contains native build files or binary artifacts; verify they are expected for this package.", native_files[:20]))
    else:
        signals.append(signal("native_or_binary_surface", "green", "low", "No native build files or binary artifacts found in sampled tarball contents."))

    if suspicious_source_hits:
        signals.append(signal("suspicious_source_tokens", "yellow", "medium", "Published source contains sensitive capability tokens; inspect whether the usage is justified.", suspicious_source_hits[:20]))
    else:
        signals.append(signal("suspicious_source_tokens", "green", "low", "No sensitive capability tokens found in sampled source files."))

    if workflow_files:
        mutable_refs: list[str] = []
        provenance_hint = False
        for path, text in workflow_files.items():
            if "--provenance" in text or "id-token: write" in text:
                provenance_hint = True
            for match in ACTION_USE_RE.finditer(text):
                ref = match.group(1).strip().strip("'\"")
                if not FULL_SHA_RE.search(ref) and MUTABLE_ACTION_RE.search(ref):
                    mutable_refs.append(f"{path}: {ref}")
        if provenance_hint:
            signals.append(signal("tarball_publish_workflow", "green", "low", "Packaged workflow files contain provenance/OIDC hints."))
        if mutable_refs:
            signals.append(signal("tarball_pinned_actions", "yellow", "medium", "Packaged workflow files contain mutable GitHub Action refs.", mutable_refs[:10]))

    return signals, details


def inspect_registry(specifier: str, context: str) -> tuple[str, str, list[dict[str, Any]], dict[str, Any]]:
    meta = npm_json(["view", specifier], timeout=60)
    if isinstance(meta, list):
        if not meta:
            raise RuntimeError("npm view returned no versions")
        meta = meta[-1]
    if not isinstance(meta, dict):
        raise RuntimeError("npm view returned unexpected metadata shape")

    name = str(meta.get("name") or parse_specifier(specifier)[0])
    version = str(meta.get("version") or parse_specifier(specifier)[1] or "unknown")
    details: dict[str, Any] = {
        "name": name,
        "version": version,
        "dist_tags": meta.get("dist-tags"),
        "repository": extract_repo_url(meta),
        "license": meta.get("license"),
        "maintainers": meta.get("maintainers"),
        "time": meta.get("time"),
        "deprecated": meta.get("deprecated"),
        "dist": meta.get("dist"),
        "context": context,
    }
    signals: list[dict[str, Any]] = []

    if meta.get("deprecated"):
        signals.append(signal("deprecated", "red", "high", f"Package version is deprecated: {meta.get('deprecated')}"))
    else:
        signals.append(signal("deprecated", "green", "low", "Package version is not marked deprecated on npm."))

    time_data = meta.get("time") if isinstance(meta.get("time"), dict) else {}
    created_days = days_since(time_data.get("created"))
    modified_days = days_since(time_data.get("modified"))
    version_days = days_since(time_data.get(version))
    version_dates = sorted(
        (key, parsed)
        for key, value in time_data.items()
        if key not in {"created", "modified"} and (parsed := parse_time(value)) is not None
    )
    version_dates.sort(key=lambda item: item[1])
    version_index = next((idx for idx, item in enumerate(version_dates) if item[0] == version), None)
    release_gap_days = None
    if version_index is not None and version_index > 0:
        release_gap_days = (version_dates[version_index][1] - version_dates[version_index - 1][1]).days
    details["age_days"] = {"created": created_days, "modified": modified_days, "version": version_days}
    details["release_gap_days_before_version"] = release_gap_days

    if created_days is not None and created_days < 30:
        signals.append(signal("package_history", "red", "high", f"Package was created only {created_days} days ago; high slopsquatting/novelty risk."))
    elif created_days is not None and created_days < 180:
        signals.append(signal("package_history", "yellow", "medium", f"Package is relatively new: created {created_days} days ago."))
    elif created_days is not None:
        signals.append(signal("package_history", "green", "low", f"Package has registry history: created {created_days} days ago."))
    else:
        signals.append(signal("package_history", "unknown", "medium", "Could not determine package creation date."))

    if version_days is not None and version_days <= 2:
        signals.append(signal("new_version", "yellow", "high", f"Requested version was published only {version_days} days ago; inspect release diff before installing."))
    elif version_days is not None and version_days <= 14:
        signals.append(signal("new_version", "yellow", "medium", f"Requested version is recent: published {version_days} days ago."))
    elif version_days is not None:
        signals.append(signal("new_version", "green", "low", f"Requested version has been published for {version_days} days."))

    if release_gap_days is not None and release_gap_days >= 365 and version_days is not None and version_days <= 30:
        signals.append(signal("release_gap_anomaly", "yellow", "high", f"Package released this version after a {release_gap_days}-day gap; inspect for maintainer compromise or unexpected changes."))

    if modified_days is not None and modified_days <= 180:
        signals.append(signal("release_activity", "green", "low", f"Package registry metadata changed {modified_days} days ago."))
    elif modified_days is not None and modified_days <= 730:
        signals.append(signal("release_activity", "yellow", "medium", f"Package has limited recent registry activity: modified {modified_days} days ago."))
    elif modified_days is not None:
        signals.append(signal("release_activity", "yellow", "medium", f"Package may be stale: modified {modified_days} days ago."))
    else:
        signals.append(signal("release_activity", "unknown", "medium", "Could not determine package modified date."))

    dist = meta.get("dist") if isinstance(meta.get("dist"), dict) else {}
    if dist.get("integrity"):
        signals.append(signal("registry_integrity", "green", "low", "npm metadata includes dist.integrity."))
    else:
        signals.append(signal("registry_integrity", "yellow", "medium", "npm metadata did not expose dist.integrity."))

    provenance = dist.get("attestations") or meta.get("_npmUser") is None and None
    # npm view does not consistently expose provenance badge details. Keep this as unknown unless metadata has attestations.
    if provenance:
        signals.append(signal("provenance", "green", "low", "npm metadata exposes attestation/provenance-related data."))
    else:
        signals.append(signal("provenance", "unknown", "low", "npm CLI metadata did not expose provenance. Manually check npmjs.com or run npm audit signatures after install if needed."))

    maintainers = meta.get("maintainers") if isinstance(meta.get("maintainers"), list) else []
    if len(maintainers) >= 3:
        signals.append(signal("npm_maintainers", "green", "low", f"npm package lists {len(maintainers)} maintainers."))
    elif len(maintainers) == 1:
        signals.append(signal("npm_maintainers", "yellow", "medium", "npm package lists one maintainer; maintainer concentration risk."))
    elif maintainers:
        signals.append(signal("npm_maintainers", "yellow", "low", f"npm package lists {len(maintainers)} maintainers."))
    else:
        signals.append(signal("npm_maintainers", "unknown", "medium", "Could not determine npm maintainers."))

    return name, version, signals, details


def vulnerability_check(specifier: str, temp_root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    # npm audit needs a project manifest/lock. Create an isolated temp project with package-lock only.
    audit_dir = temp_root / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    (audit_dir / "package.json").write_text(json.dumps({"name": "claude-npm-eval", "private": True, "dependencies": {}}), encoding="utf-8")
    code, out, err = run(["npm", "install", specifier, "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=audit_dir, timeout=120)
    details: dict[str, Any] = {"install_lock_code": code, "install_lock_error": err.strip()[:1000]}
    if code != 0:
        return [signal("vulnerabilities", "unknown", "medium", "Could not create isolated package-lock for npm audit.", details["install_lock_error"])], details

    signals: list[dict[str, Any]] = []
    lock_path = audit_dir / "package-lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except Exception:
        lock = {}
    packages = lock.get("packages", {}) if isinstance(lock, dict) and isinstance(lock.get("packages"), dict) else {}
    dependency_entries = {path: data for path, data in packages.items() if path and isinstance(data, dict)}
    package_count = len(dependency_entries)
    max_depth = max((path.count("node_modules/") for path in dependency_entries), default=0)
    install_script_packages = [lockfile_package_name(path) for path, data in dependency_entries.items() if data.get("hasInstallScript")]
    deprecated_packages = [lockfile_package_name(path) for path, data in dependency_entries.items() if data.get("deprecated")]
    non_registry_sources = []
    allowed_registry_hosts = npm_registry_hosts()
    for path, data in dependency_entries.items():
        resolved = data.get("resolved")
        if isinstance(resolved, str) and urllib.parse.urlparse(resolved).scheme in {"http", "https"} and not npm_registry_host(resolved, allowed_registry_hosts):
            non_registry_sources.append({"package": lockfile_package_name(path), "resolved": resolved})
    details["lockfile_summary"] = {
        "package_count": package_count,
        "max_depth": max_depth,
        "allowed_registry_hosts": sorted(allowed_registry_hosts),
        "install_script_packages": install_script_packages[:50],
        "deprecated_packages": deprecated_packages[:50],
        "non_registry_sources": non_registry_sources[:50],
    }

    if package_count <= 20:
        signals.append(signal("transitive_dependency_tree", "green", "low", f"Isolated lockfile contains {package_count} package(s).", details["lockfile_summary"]))
    elif package_count <= 100:
        signals.append(signal("transitive_dependency_tree", "yellow", "medium", f"Isolated lockfile contains {package_count} package(s); review transitive footprint.", details["lockfile_summary"]))
    else:
        signals.append(signal("transitive_dependency_tree", "red", "high", f"Isolated lockfile contains {package_count} package(s); large transitive attack surface.", details["lockfile_summary"]))

    if install_script_packages:
        signals.append(signal("transitive_install_scripts", "yellow", "high", "One or more transitive packages declare lifecycle install scripts.", install_script_packages[:50]))
    else:
        signals.append(signal("transitive_install_scripts", "green", "low", "No transitive lifecycle install scripts found in the isolated lockfile."))

    if deprecated_packages:
        signals.append(signal("transitive_deprecated", "yellow", "medium", "One or more transitive packages are deprecated.", deprecated_packages[:50]))

    if non_registry_sources:
        signals.append(signal("lockfile_sources", "red", "high", "Isolated lockfile resolves packages from non-npm registry hosts.", non_registry_sources[:20]))
    else:
        signals.append(signal("lockfile_sources", "green", "low", "Isolated lockfile resolved packages from expected npm registry host(s)."))

    code, out, err = run(["npm", "audit", "--json"], cwd=audit_dir, timeout=120)
    audit_parse_error = None
    try:
        audit = json.loads(out) if out.strip() else None
    except Exception as exc:
        audit = None
        audit_parse_error = str(exc)
    details["audit"] = audit
    details["audit_code"] = code
    details["audit_error"] = err.strip()[:1000]
    if audit_parse_error:
        details["audit_parse_error"] = audit_parse_error
    metadata = audit.get("metadata", {}) if isinstance(audit, dict) else {}
    vulns = metadata.get("vulnerabilities") if isinstance(metadata, dict) else None
    if not isinstance(vulns, dict):
        evidence = {"exit_code": code, "stderr": details["audit_error"], "parse_error": audit_parse_error}
        return signals + [signal("vulnerabilities", "unknown", "medium", "npm audit did not return parseable vulnerability metadata.", evidence)], details
    total = sum(int(v or 0) for v in vulns.values())
    high = int(vulns.get("high", 0) or 0)
    critical = int(vulns.get("critical", 0) or 0)
    if critical:
        sig = signal("vulnerabilities", "red", "critical", f"npm audit reports {critical} critical vulnerabilities.", vulns)
    elif high:
        sig = signal("vulnerabilities", "red", "high", f"npm audit reports {high} high vulnerabilities.", vulns)
    elif total:
        sig = signal("vulnerabilities", "yellow", "medium", f"npm audit reports {total} vulnerabilities.", vulns)
    else:
        sig = signal("vulnerabilities", "green", "low", "npm audit reports no known vulnerabilities for the isolated dependency tree.", vulns)
    return signals + [sig], details


def score(signals: list[dict[str, Any]], context: str) -> dict[str, Any]:
    severity_points = {"low": 1, "medium": 3, "high": 7, "critical": 15}
    status_factor = {"green": 0, "unknown": 1, "yellow": 1, "red": 2}
    total = 0
    blockers: list[str] = []
    blocker_severities: list[str] = []
    concerns: list[str] = []
    for sig in signals:
        status = sig.get("status")
        severity = sig.get("severity")
        points = severity_points.get(str(severity), 3) * status_factor.get(str(status), 1)
        # Production/runtime dependencies should not normalize away unknown source-chain risk.
        if context == "prod" and status in {"yellow", "red", "unknown"} and severity in {"medium", "high", "critical"}:
            points += 1
        total += points
        if status == "red" and severity in {"high", "critical"}:
            blockers.append(f"{sig.get('id')}: {sig.get('message')}")
            blocker_severities.append(str(severity))
        elif status in {"yellow", "unknown"} and severity in {"medium", "high", "critical"}:
            concerns.append(f"{sig.get('id')}: {sig.get('message')}")

    if blockers or total >= 35:
        recommendation = "block"
        risk_level = "critical" if "critical" in blocker_severities or total >= 50 else "high"
    elif total >= 16 or concerns:
        recommendation = "review"
        risk_level = "medium" if total < 28 else "high"
    else:
        recommendation = "approve"
        risk_level = "low"

    if recommendation == "approve":
        summary = "No blocking package-risk signals were found. Proceed only if the dependency is necessary."
    elif recommendation == "review":
        summary = "Non-blocking concerns or unknowns were found. Inspect them and compare alternatives before installing."
    else:
        summary = "Blocking supply-chain or maintenance risk signals were found. Do not install by default."

    return {
        "recommendation": recommendation,
        "risk_score": total,
        "risk_level": risk_level,
        "summary": summary,
        "blockers": blockers,
        "concerns": concerns[:12],
    }


def requested_options(include_github: bool, include_audit: bool) -> dict[str, bool]:
    return {"include_github": include_github, "include_audit": include_audit}


def cached_options_satisfy(cached: dict[str, Any], requested: dict[str, bool]) -> bool:
    if cached.get("schema_version") != SCHEMA_VERSION:
        return False
    cached_options = cached.get("evaluation_options", {}) if isinstance(cached, dict) else {}
    return all(not requested.get(key, False) or bool(cached_options.get(key)) for key in requested)


def build_report_from_facts(
    facts: dict[str, Any],
    *,
    context: str,
    requested_specifier: str,
    requested_version: str | None,
    necessity: str | None,
    cache_hit: bool,
    report_path: Path,
) -> dict[str, Any]:
    signals = list(facts.get("signals", []))
    decision = score(signals, context)
    target = dict(facts.get("target", {}))
    target.update({"requested": requested_specifier, "requested_version": requested_version})
    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "source_article": facts.get("source_article"),
        "target": target,
        "context": context,
        "necessity": necessity,
        "decision": decision,
        "signals": signals,
        "details": facts.get("details", {}),
        "evaluation_options": facts.get("evaluation_options", {}),
        "cache": {"hit": cache_hit, "path": str(report_path), "facts_generated_at": facts.get("facts_generated_at")},
        "next_steps": next_steps(decision, context, necessity),
    }
    return report


def evaluate(specifier: str, context: str, refresh: bool, include_github: bool, include_audit: bool, necessity: str | None) -> dict[str, Any]:
    name, explicit = parse_specifier(specifier)
    registry_name, version, registry_signals, registry_details = inspect_registry(specifier, context)
    name = registry_name or name
    report_path = cache_path(name, version)
    options = requested_options(include_github, include_audit)
    if report_path.exists() and not refresh:
        facts = json.loads(report_path.read_text(encoding="utf-8"))
        if cached_options_satisfy(facts, options):
            return build_report_from_facts(
                facts,
                context=context,
                requested_specifier=specifier,
                requested_version=explicit,
                necessity=necessity,
                cache_hit=True,
                report_path=report_path,
            )

    with tempfile.TemporaryDirectory(prefix="npm-package-evaluate-") as tmp:
        tmp_path = Path(tmp)
        pack_signals, pack_details = pack_and_inspect(f"{name}@{version}", tmp_path)
        repo_registry = comparable_repo_url(registry_details.get("repository"))
        repo_tarball = comparable_repo_url(pack_details.get("repository"))
        repo_signals: list[dict[str, Any]] = []
        if repo_registry and repo_tarball and repo_registry != repo_tarball:
            repo_signals.append(signal("repository_mismatch", "red", "high", "Registry repository and tarball package.json repository differ.", {"registry": repo_registry, "tarball": repo_tarball}))
        elif repo_registry and repo_tarball:
            repo_signals.append(signal("repository_mismatch", "green", "low", "Registry repository and tarball package.json repository match."))
        audit_signals: list[dict[str, Any]] = []
        audit_details: dict[str, Any] = {}
        if include_audit:
            audit_signals, audit_details = vulnerability_check(f"{name}@{version}", tmp_path)
        github_signals: list[dict[str, Any]] = []
        github_details: dict[str, Any] = {}
        if include_github:
            github_signals, github_details = inspect_github(registry_details.get("repository"))

    all_signals = registry_signals + pack_signals + repo_signals + audit_signals + github_signals
    facts = {
        "schema_version": SCHEMA_VERSION,
        "facts_generated_at": now_iso(),
        "source_article": "https://blog.gaborkoos.com/posts/2026-05-29-How-to-Evaluate-an-npm-Package-2026-Edition/",
        "target": {"name": name, "version": version, "specifier": f"{name}@{version}"},
        "signals": all_signals,
        "details": {"registry": registry_details, "tarball": pack_details, "audit": audit_details, "github": github_details},
        "evaluation_options": options,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(facts, indent=2, ensure_ascii=False), encoding="utf-8")
    return build_report_from_facts(
        facts,
        context=context,
        requested_specifier=specifier,
        requested_version=explicit,
        necessity=necessity,
        cache_hit=False,
        report_path=report_path,
    )


def next_steps(decision: dict[str, Any], context: str, necessity: str | None) -> list[str]:
    prefix = [] if necessity else ["Before installing, state why this dependency is necessary and why local code or an existing dependency is insufficient."]
    if decision["recommendation"] == "approve":
        return prefix + [
            "Confirm the dependency is necessary and proportionate.",
            "State the approved package@version and top green signals before installing.",
        ]
    if decision["recommendation"] == "review":
        steps = prefix + [
            "Inspect concerns and unknowns in the report before installing.",
            "Evaluate a better-known alternative if this package is not clearly necessary.",
        ]
        if context == "prod":
            steps.append("Ask the user to accept residual production dependency risk if concerns remain.")
        return steps
    return prefix + [
        "Do not install by default.",
        "Suggest safer alternatives or ask the user for explicit override with the report path.",
    ]


def print_human(report: dict[str, Any]) -> None:
    target = report["target"]
    decision = report["decision"]
    cache = report.get("cache", {})
    print(f"npm-package-evaluate: {target['specifier']}")
    print(f"recommendation: {decision['recommendation']} ({decision['risk_level']}, score {decision['risk_score']})")
    print(f"summary: {decision['summary']}")
    if report.get("necessity"):
        print(f"necessity: {report.get('necessity')}")
    print(f"cache: {'hit' if cache.get('hit') else 'miss'} -> {cache.get('path')}")
    blockers = decision.get("blockers") or []
    concerns = decision.get("concerns") or []
    if blockers:
        print("blockers:")
        for item in blockers[:8]:
            print(f"- {item}")
    if concerns:
        print("concerns:")
        for item in concerns[:8]:
            print(f"- {item}")
    greens = [s for s in report.get("signals", []) if s.get("status") == "green"]
    if greens:
        print("green signals:")
        for sig in greens[:8]:
            print(f"- {sig.get('id')}: {sig.get('message')}")
    print("next steps:")
    for step in report.get("next_steps", []):
        print(f"- {step}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Evaluate an npm package before installation.")
    parser.add_argument("specifier", help="Package specifier, e.g. react, lodash@4.17.21, @types/node@latest")
    parser.add_argument("--context", choices=["prod", "dev", "tool", "unknown"], default="unknown", help="How the dependency will be used.")
    parser.add_argument("--refresh", action="store_true", help="Ignore cached package facts and re-check.")
    parser.add_argument("--json", action="store_true", help="Print full JSON report.")
    parser.add_argument("--no-github", action="store_true", help="Skip GitHub repository API inspection.")
    parser.add_argument("--no-audit", action="store_true", help="Skip isolated package-lock npm audit.")
    parser.add_argument("--necessity", help="Short justification for why this dependency is needed.")
    parser.add_argument("--fail-on", choices=["never", "block", "review"], default="never", help="Exit non-zero when the recommendation is at least this severe.")
    args = parser.parse_args(argv)

    if shutil.which("npm") is None:
        print("error: npm CLI is required", file=sys.stderr)
        return 2

    try:
        report = evaluate(
            specifier=args.specifier,
            context=args.context,
            refresh=args.refresh,
            include_github=not args.no_github,
            include_audit=not args.no_audit,
            necessity=args.necessity,
        )
    except Exception as exc:
        failure = {
            "target": {"requested": args.specifier},
            "decision": {"recommendation": "block", "risk_score": 999, "risk_level": "critical", "summary": "Package evaluation failed; do not install by default."},
            "error": str(exc),
            "cache": {"hit": False, "path": None},
        }
        if args.json:
            print(json.dumps(failure, indent=2, ensure_ascii=False))
        else:
            print(f"npm-package-evaluate: {args.specifier}")
            print("recommendation: block (critical)")
            print(f"error: {exc}")
        return 1

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print_human(report)

    recommendation = report.get("decision", {}).get("recommendation")
    if args.fail_on == "block" and recommendation == "block":
        return 3
    if args.fail_on == "review" and recommendation in {"review", "block"}:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
