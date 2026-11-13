# package-release

Prepare a release from conventional commits: detect the current version, propose a
version bump and changelog, then create a release commit and local tag after the
user confirms the proposal. Requires Git and Python 3; no Python packages are needed.

## Install in Codex

Add the marketplace and install the plugin:

```bash
codex plugin marketplace add lkangd/skills
codex plugin add package-release@lkangd-skills
```

For local development, run `codex plugin marketplace add .` from the checkout root,
then install the plugin with the same `codex plugin add` command.

In the target project's Codex CLI or IDE conversation, invoke
`$package-release:package-release` (the plugin-qualified name shown by Codex).
The skill is explicit-only through `skills/package-release/agents/openai.yaml`.
If it does not appear in an existing conversation, start a new conversation.

## Install in Claude Code

```text
/plugin marketplace add lkangd/skills
/plugin install package-release@lkangd-skills
```

In the target project's conversation, invoke `/package-release:package-release`.
The shared skill preserves Claude's `disable-model-invocation: true` setting.

## Shared implementation

Both hosts load `skills/package-release/SKILL.md` and the same bundled Python
scripts. Root `plugin.json` supplies the portable plugin metadata;
`.claude-plugin/plugin.json` supplies Claude's metadata. Keep their name, version,
description, and author in sync. Both installation paths use the repository's
[marketplace manifest](../../../.claude-plugin/marketplace.json), which lists
`package-release` alongside the other plugins.

Scripts run from the target project's Git root using absolute paths resolved from
the loaded skill directory. They must work from an installed cache as well as a
repository checkout. The helpers analyze the whole repository; monorepo release
scope needs to be clarified before use.

The workflow preserves existing changelog sections and unrelated changes. It
requires confirmation of the release proposal and does not push commits or tags.

Packaging and invocation references: [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
and [Codex skills](https://learn.chatgpt.com/docs/build-skills).
