# Platform notes: Claude Code and Codex

The skill body is platform-neutral. What differs is how it is invoked and which mechanisms can
actually enforce the approval boundary. The skill itself enforces nothing.

## Claude Code

Invocation

- Installed as a plugin: `/senior-plan-review:senior-plan-review <optional focus>`; the bare
  `/senior-plan-review` also works when no other command uses that name.
- Copied to `.claude/skills/senior-plan-review/` or `~/.claude/skills/senior-plan-review/`:
  `/senior-plan-review`.
- Claude may also load the skill on its own when the description matches (the frontmatter does
  not set `disable-model-invocation`). This is advisory; it is not a gate.

Enforcement that exists outside the skill

- Plan mode (`--permission-mode plan`, or `Shift+Tab`): Claude can read but not edit or run
  commands until the user leaves plan mode. Review in plan mode, approve by exiting it.
- Permission rules in `settings.json`: deny `Bash(npm run purge*)`, `Bash(psql*)`,
  `Bash(git push --force*)` and similar so CRITICAL operations always prompt or fail.
- `PreToolUse` hooks can block a tool call unless an approval marker exists (for example a
  `.claude/plans/<name>.approved` file written by the user, not by Claude). This is the only way
  to make `REAPPROVAL_REQUIRED` survive context loss. Keep it out of the plugin by default;
  it is a per-project policy decision.
- Sandboxing (`sandbox` settings / `--restricted`) removes the ability to run commands at all.

## Codex CLI

Invocation

- Put the skill directory at `.agents/skills/senior-plan-review/` (repo) or
  `~/.agents/skills/senior-plan-review/` (user); a symlink to the plugin checkout works.
- Explicit: `$senior-plan-review` in the prompt. Implicit matching uses the description.
- `agents/openai.yaml` is optional; the skill does not ship one, so implicit invocation stays
  enabled.

Enforcement that exists outside the skill

- Sandbox mode: `--sandbox read-only` for review sessions; `workspace-write` for execution.
  Network and out-of-workspace writes stay blocked unless configured.
- Approval policy (`approval_policy` in `config.toml`, or `--ask-for-approval`): commands that
  escape the sandbox prompt the user. `--dangerously-bypass-approvals-and-sandbox` defeats every
  gate this skill describes; do not combine it with the skill and expect protection.
- Codex has no plan mode equivalent; use a read-only sandbox for the review turn and switch
  only after the user approves.

## What neither platform gives you

- Durable plan state across sessions. The status line in the brief is a convention. If the
  team needs an audit trail, keep the plan in a file under version control and record status
  and approved scope there, or add a hook/CI gate that checks for an approval artifact.
- A guarantee that the model classifies risk correctly. Treat the tier as a prompt for human
  attention, and put the real guard rails (deny rules, sandbox, backups, change tickets) around
  the operations that would hurt if the tier were wrong.
