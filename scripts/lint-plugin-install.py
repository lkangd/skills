#!/usr/bin/env python3
"""Check plugin installation docs against the repository's distribution metadata."""

import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = r"""(?:"([^"]+)"|'([^']+)'|([^\s`|]+))"""
MARKETPLACE_ADD = re.compile(
    r"(?:/plugin|\b(?:claude|codex)\s+plugin)\s+marketplace\s+add\s+" + SOURCE
)
MARKETPLACE_INSTALL = re.compile(
    r"(?:/plugin|\bclaude\s+plugin)\s+install\s+[^\s`|]+\s+--marketplace(?:=|\s+)" + SOURCE
)
PLUGIN_INSTALL = re.compile(
    r"(?:/plugin\s+install|\bclaude\s+plugin\s+install|\bcodex\s+plugin\s+add)\s+"
    r"([\w-]+)@([^\s`|]+)"
)
PI_INSTALL = re.compile(r"\bpi\s+install\s+" + SOURCE)
LOCAL_SOURCES = {".", "./"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sources(pattern, line):
    for match in pattern.finditer(line):
        yield next(value for value in match.groups() if value is not None)


def check(root):
    package = read_json(root / "package.json")
    repository_url = package["repository"]["url"].removesuffix(".git")
    repository = re.fullmatch(r"https://github\.com/([\w.-]+/[\w.-]+)", repository_url)
    if not repository:
        return ["package.json: repository.url must identify the publishing GitHub repository"]

    slug = repository[1]
    errors = []
    catalog = read_json(root / ".claude-plugin/marketplace.json")
    marketplace = catalog["name"]
    plugins = {plugin["name"] for plugin in catalog["plugins"]}
    git_urls = {repository_url, repository_url + ".git"}
    marketplace_sources = LOCAL_SOURCES | git_urls | {slug, f"git@github.com:{slug}.git"}
    pi_source = "git:github.com/" + slug
    pi_sources = LOCAL_SOURCES | git_urls | {pi_source}
    pi_paths = [
        (root / path).resolve()
        for kind in ("skills", "extensions", "prompts", "themes")
        for path in package["pi"].get(kind, [])
    ]

    plugin_root = root / "plugins"
    for readme in sorted(plugin_root.glob("*/*/README.md")):
        plugin_dir = readme.parent
        for number, line in enumerate(readme.read_text(encoding="utf-8").splitlines(), 1):
            location = f"{readme.relative_to(root)}:{number}"
            for pattern in (MARKETPLACE_ADD, MARKETPLACE_INSTALL):
                for source in sources(pattern, line):
                    if source not in marketplace_sources:
                        errors.append(
                            f"{location}: use marketplace source {slug} or . from the checkout root, found {source}"
                        )
            for name, catalog_name in PLUGIN_INSTALL.findall(line):
                if catalog_name != marketplace or name not in plugins:
                    errors.append(f"{location}: {name}@{catalog_name} is not in the {marketplace} marketplace")
            for source in sources(PI_INSTALL, line):
                if source not in pi_sources:
                    errors.append(
                        f"{location}: use Pi source {pi_source} or . from the checkout root, found {source}"
                    )
                if not any(path.is_relative_to(plugin_dir) and path.exists() for path in pi_paths):
                    errors.append(f"{location}: no existing Pi resource for this plugin in package.json")

    manifests = list(plugin_root.glob("*/*/plugin.json"))
    for host_dir in (".claude-plugin", ".codex-plugin"):
        manifests.extend(plugin_root.glob(f"*/*/{host_dir}/plugin.json"))
    for manifest in sorted(manifests):
        repository_field = read_json(manifest).get("repository")
        if repository_field and repository_field.removesuffix(".git") != repository_url:
            errors.append(f"{manifest.relative_to(root)}: expected repository {repository_url}, found {repository_field}")

    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="checkout or Git index snapshot")
    errors = check(parser.parse_args().root.resolve())
    if errors:
        raise SystemExit("\n".join(errors))
    print("Plugin installation docs and distribution metadata passed.")
