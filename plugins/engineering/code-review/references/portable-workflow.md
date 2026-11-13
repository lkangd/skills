# Code review workflow

Use this procedure after the user explicitly invokes the plugin. The host session owns
configuration, target/spec selection, and applying fixes after a round. A separate runner
plans, executes, verifies, checkpoints and consolidates each round.

1. **Setup**. Follow [configuration.md](configuration.md) before resolving a target or
   resuming. For explicit `setup`, finish after saving. If setup needs user input, wait for
   it before proceeding.
2. **Target**. Resolve an explicit target. Ask if missing or ambiguous. Pass `kind` and
   `values` to `review_run`: `working-tree` and `staged` take no values, `files` takes
   repo-relative paths, `commit` takes one SHA or both endpoints of an inclusive range,
   and `branch` takes its base ref. Include user-declared intended behavior in `description`.
   Supply spec paths from `--spec` or the current conversation. Pass requirements from the
   conversation as `spec_context`. Ask once when neither source exists, with no spec as the default.
3. **Run**. Call `review_run` once with `mode: normal` or `mode: adversarial`. Pass flag
   overrides as `concurrency` and `max_rounds`. The adapter selects the runner from the
   invoking host's configuration and looks for the actual worker
   harness's model catalog and capability definitions. It applies explicit model/effort
   overrides, matches supported effort to task complexity and uses the harness defaults
   when discovery is unavailable. The result records the model selection for resume.
   Yield until the tool returns the final result. While it is pending, make no additional
   calls, including repo reads, status checks, and reviewer dispatch. If the runner fails
   or is unavailable, report the blocker or the resume command and stop. Never perform the
   review in the main session.
4. **Resume**. Call `review_resume` with the requested run directory. When the user omits
   it, call without a directory, offer the latest incomplete run, and confirm the choice.
   Wait for the selected resume call as for a new round. Resume uses its persisted runner,
   task plan and model settings. A `legacy` result
   identifies a Claude Code checkpoint. Use the Claude command in a Claude Code session,
   with the original compatible runner if needed.
5. **Act**. On a completed round, open the returned findings file. Use
   [review-core.md](review-core.md#5-verify-findings-and-act) §5 to verify each finding against
   the current code, consolidate duplicates, fix in-scope issues, backlog out-of-scope issues, and account for every
   disposition. Check stale and unverified findings especially carefully. Keep the working
   tree and index intact apart from authorized fixes and backlog edits. No stage, commit,
   push, revert, or worktree switching without explicit authorization.
6. **Loop**. In adversarial mode only, if this round fixed a confirmed major or critical
   finding and the cap permits it, call `review_next` with this round's directory,
   the one-based findings positions of the fixed items, and `known_issues` with one line
   per disposition from all rounds. The next round reviews the cumulative change. Repeat
   from step 5 until the result is clean of actionable major/critical issues or the cap
   is reached. Wait for each call as in step 3. Resume a stopped round from its checkpoint.
7. **Report**. Give the severity, verdict, file and disposition for each finding, note the
   spec sources, and include the round count, stop reason, and run directory. Report a failed
   round as incomplete and include its resume invocation.
