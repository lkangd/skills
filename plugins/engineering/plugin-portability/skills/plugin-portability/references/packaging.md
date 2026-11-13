# Packaging and verification

## Choose the package layout

In `agent-skills`, use the existing category and plugin identity for migrations. Choose a category, a unique plugin name, and a skill folder matching its frontmatter `name` for new plugins. Keep helper scripts and references inside the installed package. Resolve them from the skill or adapter location. Resolve project inputs and state from the invocation's workspace, which can be outside the plugin checkout.

| Host | Repository wiring | Installed invocation |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` in the plugin. Register its root in the repository's `.claude-plugin/marketplace.json`. | `/<plugin>:<skill>` or the existing command. |
| Codex | Root `plugin.json` for portable components. Use a Codex compatibility manifest only if a required component or setting needs that format on the supported version. This repository's configured marketplace resolves entries from `.claude-plugin/marketplace.json`. | `$<plugin>:<skill>`. Check the name exposed after installation. |
| Pi | Append the skill directory to `pi.skills` in the repository root `package.json`. For native commands or tools, append the extension file to `pi.extensions`. Use `pi.prompts` if the design includes prompt templates. | `/skill:<skill>` or an explicit command registered by the extension. |

Preserve sibling marketplace entries and Pi resource paths. Use exact Pi paths so the package exposes only the resources it declares. Keep identity and any plugin versions consistent across manifests for the same release. The repository's root npm package is a separate distribution unit.

For an explicit-only skill, set `disable-model-invocation: true` in shared skill frontmatter for Claude Code and Pi, and `policy.allow_implicit_invocation: false` in the skill's `agents/openai.yaml` for Codex. For a model-selected skill, leave automatic invocation enabled and make its description specific enough to route the task.

In the target checkout, use `plugins/engineering/package-release/` as the shared skill and manifest example. Use `plugins/engineering/code-review/` as the shared scheduler example. Verify each target host's current loader behavior, especially when adding a manifest alongside an existing one.

## Check from an installation

Use a disposable fixture workspace and isolated host state. Record the host versions. Install from a local checkout or a temporary committed copy for a Git install. Check paths from a workspace outside the source checkout so missing packaged resources surface.

- **Claude Code.** Run `claude plugin validate <plugin-directory>`. Install with `claude plugin install <plugin> --marketplace <repository-root>` in a temporary `CLAUDE_CONFIG_DIR`. Confirm the installed inventory and exercise the skill or retained slash command in a fresh session.
- **Codex.** In a temporary `CODEX_HOME`, run `codex plugin marketplace add <repository-root>` and `codex plugin add <plugin>@lkangd-skills`. Verify the installed skill through App Server `skills/list` or the desktop. Exercise its entry point and, when present, invoke the installed MCP tool. Check the result as well as registration.
- **Pi.** In a temporary `PI_CODING_AGENT_DIR`, run `pi install <repository-root>` and check `get_commands` in a fresh RPC session or the interactive skill picker. Check the source path or package origin as well as the command name, since Pi may also discover user-wide skills. Exercise the registered skill or command. If Git distribution is part of the change, test installation from a committed local fixture or a published ref so uncommitted files cannot hide packaging gaps.

Use deterministic fixture inputs and model doubles for automated behavior tests where practical. Check the workflow's observable result and any confirmation boundary, including the cancellation or refusal path when it matters. For a stateful runner, use the additional checks in [Runtime](runtime.md). Report discovery, installed invocation, and live model execution according to which checks actually ran.

Primary references for the formats and commands in this guide are the [Claude Code plugin manifest](https://code.claude.com/docs/en/plugins-reference) and [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins) and [skill invocation policy](https://learn.chatgpt.com/docs/build-skills), and Pi [packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), [skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), and [RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md).
