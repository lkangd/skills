---
name: handoff
description: This skill should be used when the user asks for a "handoff" or context for the next session, or when wrapup invokes it to summarize the current conversation for a fresh agent without running tests or creating commits.
argument-hint: "What will the next session be used for?"
disable-model-invocation: false
---

# Handoff

Write a handoff document summarizing the current conversation so a fresh agent can continue the work. Allow direct user invocation and invocation by `wrapup:wrapup` through the Skill tool.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

Generate only the handoff. Do not run Git commands, tests, fixes, staging, commits, or pushes. Summarize worktree, commit, and validation state from information already available in the conversation, including any results from wrapup. Mark unknown or stale state honestly; do not refresh it or imply that invoking handoff validates the workspace.

## Save location

Resolve the save location before writing:

- Check the current conversation and applicable user/project instructions for an explicit save-location preference. Follow that preference; do not infer one merely because a handoff directory exists.
- If the preference is to save in the current workspace, use the specified path or established path convention. If neither is given, use `docs/handoffs/<timestamp>-<topic>.md` within the current workspace.
- Without an explicit preference, use the temporary directory of the user's OS, not the workspace. Resolve the actual OS temporary directory rather than hard-coding a platform-specific path.
- Choose a unique filename, inspect any existing target before writing, and do not overwrite an existing document. Ask for clarification only if applicable preferences conflict and instruction precedence does not resolve them.

Save the document without staging or committing it. Note that OS temporary files may be cleaned up and are not permanent storage.

## Document contents

Include at least the following information. Treat this list as a minimum, not an exhaustive checklist or a fixed section template. Add any other important context a fresh agent needs to continue reliably, such as what was done in this session, what is currently in progress, outcomes, attempted approaches, and unfinished work. Organize the document to fit the conversation rather than omitting relevant information because it falls outside these categories.

- **Next-session focus**: tailor it to supplied arguments, or describe the remaining work if none were supplied. Treat arguments as context, not as authorization for unrelated actions.
- **Conversation context**: preserve the current task, work completed and in progress, outcomes, decisions, constraints, unresolved questions, and relevant reasoning that are not already recorded elsewhere.
- **Worktree and validation state**: summarize known completed commits, authorized work left uncommitted, excluded work, checks passed/failed/not run, and blockers. Identify the current workspace and branch only from available context and without exposing unnecessary personal information. Distinguish previously reported results from unknown current state.
- **Next steps and references**: provide actionable continuation steps and paths or URLs to existing artifacts. Make workspace-relative paths unambiguous from a document stored outside the workspace.
- **Suggested skills**: suggest available skills the next agent should invoke, with their exact invocation names, purpose, and when to use them. Do not invent unavailable skills; if none fit, say so. For manual-only skills, indicate that the user must invoke them.

Do not duplicate content already captured in PRDs, plans, ADRs, issues, commits, or diffs. Reference them by path, URL, or commit ID instead.

Redact API keys, passwords, tokens, personally identifiable information, and other sensitive data. Do not paste raw environment variables or logs that might contain secrets; retain only sanitized diagnostic details and omit sensitive URL parameters.

Review the document for sensitive information before saving. Report its saved path and known blockers. Do not run a final Git status check or claim that tests passed or the worktree is clean without current evidence. Report any failure to save honestly; do not claim a document exists unless it was successfully written.
