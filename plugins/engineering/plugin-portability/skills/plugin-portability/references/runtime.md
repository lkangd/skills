# Runtime adapters

## Translate the behavior at the boundary

- **Commands and prompts.** Preserve arguments, explicit triggers, and existing Claude command names. Move shared instructions into the skill or a common reference. Add a Pi extension only when a skill or prompt template cannot provide the required native behavior.
- **Hooks, tools, and agents.** Identify what each host component enforces or makes possible. Map it to a supported host facility or a shared script. A prose instruction cannot replace an enforced permission, a lifecycle event, or a process boundary. If a host has no equivalent, document the affected operation and how it is exposed or disabled. Keep authorization and mutations at their original boundaries.
- **Settings.** Keep project settings in a shared, validated format when the behavior is shared across hosts. Preserve existing settings and migration semantics unless the task explicitly changes them. If setup requires user confirmation, show the full effective settings and confirm them before writing. Enforce required configuration at the launcher as well as the entry point. Keep credentials in the selected host's credential store and runtime artifacts out of source control when appropriate.

## Keep a stateful runner independent

Apply this section when the plugin contract calls for isolated scheduling, long-running work, or resume. Use a shared runtime to own dispatch, validation, retry, checkpointing, and aggregation. The calling session handles input and authorization, launches one runner per round, and awaits its final result through a blocking call or the host's completion notification. Report an unavailable runner as a blocker. Preserve any post-result actions the user requested or the plugin already defines.

Keep the calling host separate from the configured runner. When workers are meant to be read-only, give them inspection tools and block recursive plugin invocation at the launcher. Where model choice varies by task, discover the runner's model and reasoning capabilities, preserve explicit overrides, and use the runner's defaults when discovery cannot distinguish them. If slicing is necessary, budget the full prompt each worker actually receives, including shared instructions, and send only its assigned slice.

In Codex, verify the installed MCP manifest actually supports the transport fields and timeout required by the workflow. Check manifest precedence and the installed server before reusing this layout. For Pi extensions, resolve resources from the extension module and propagate cancellation to the child process. On Claude Code, use the host's completion notification if the workflow outlasts foreground Bash.

Persist enough metadata to identify the target, runner, plan, and completed steps on resume. Write checkpoints atomically. Use the same receipt rules when saving, resuming, and declaring completion. Verify coverage against the planned work, so an absent input or checkpoint cannot turn a partial run into a successful one. Treat interruption, incomplete work, and a complete empty result as distinct outcomes.

For installed tests, exercise an ordinary run, any user-facing iteration the plugin supports, and cancellation after partial completion followed by resume. Check that resume uses the original runner and reuses the completed work. If a single call must survive the host's default timeout, include a test long enough to demonstrate that contract. Confirm that post-result actions happen at the intended layer. For `code-review`, the calling session verifies each finding and fixes, defers, or rejects it after the runner completes.

In the target checkout, look under `plugins/engineering/code-review/` for `references/portable-workflow.md` and `evaluation/installed_workflows.py`. See the primary references for [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp), [Claude Code component paths](https://code.claude.com/docs/en/plugins-reference), and [Pi extension APIs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
