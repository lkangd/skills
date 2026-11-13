---
name: plugin-portability
description: Migrate Claude Code plugins in agent-skills to Codex and Pi, or create new plugins for all three hosts. Use for cross-host plugin design, packaging, and installed-workflow verification.
---

# Plugin Portability

Build one plugin under `plugins/<category>/<name>/` with shared behavior and entry points that work in Claude Code, Codex, and Pi. Work on the plugin named in the request. Apply this workflow to each plugin as it is migrated or created.

1. **Define the behavior.** For a migration, inventory the existing manifest, skills, commands, agents, hooks, MCP, scripts, tests, and documented entry points. Trace arguments, configuration, permissions, side effects, output, and recovery from each user entry point. Preserve user-visible behavior and invocation policy unless the task changes them. For a new plugin, define those same contracts from the request. Ask about an unavailable host capability only when the answer would change the workflow or its guarantees.
2. **Choose the smallest entry point.** Use a shared `skills/<skill>/SKILL.md` for instructions and portable scripts. Keep existing Claude slash commands as thin entry points when their names or behavior matter. Use native adapters only for capabilities the shared skill cannot provide, such as a hook, custom tool, native dialog, or isolated background runner. For host-specific capabilities or a stateful runner, read [Runtime](references/runtime.md).
3. **Package and verify.** Follow [Packaging and verification](references/packaging.md) to register the plugin in this repository and test each installed entry point from a separate fixture workspace. Include packaged resources, relative path resolution, and the intended discovery policy in those checks. For a migration, exercise the preserved Claude entry point as well as the new ones.

Finish with the actual invocation for each host, the behaviors exercised, and any host-specific limits or untested paths. Keep test installations isolated. Treat updates to a user's installed plugins, release commits, and publishing as separate actions.
