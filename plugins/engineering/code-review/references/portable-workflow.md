# Code review workflow

Use this procedure after the user explicitly invokes the plugin. The host session owns
target/spec selection and applying fixes. The review tools execute and checkpoint one round.

1. **Setup**. For an explicit `setup`, read [configuration.md](configuration.md), edit the
   shared project settings with the user, and finish. Otherwise use the project settings or
   built-in defaults.
2. **Target**. Resolve an explicit target. Ask if missing or ambiguous. Pass `kind` and
   `values` to `review_run`: `working-tree` and `staged` take no values, `files` takes
   repo-relative paths, `commit` takes one SHA or both endpoints of an inclusive range,
   and `branch` takes its base ref. Include user-declared intended behavior in `description`.
   Supply spec paths from `--spec` or the current conversation. Pass requirements from the
   conversation as `spec_context`. Ask once when neither source exists, with no spec as the default.
3. **Run**. Call `review_run` once with `mode: normal` or `mode: adversarial`. Pass flag
   overrides as `concurrency` and `max_rounds`. The adapter looks for the actual worker
   harness's model catalog and capability definitions. It applies explicit model/effort
   overrides, matches supported effort to task complexity and uses the harness defaults
   when discovery is unavailable. The result records the model selection for resume.
   When a tool returns `running` with a job ID, use `review_status` until it settles. The
   status tool waits for progress and returns promptly when the job ends. If the host
   restarts or the job ID is lost, use resume to recover the on-disk round.
4. **Resume**. Call `review_resume` with the requested run directory. When the user omits
   it, call without a directory, offer the latest incomplete run, and confirm the choice.
   Resume uses its persisted backend, task plan and model settings. A `legacy` result
   identifies a Claude Code checkpoint. Use the Claude command in a Claude Code session,
   with the original compatible runner if needed.
5. **Act**. On a completed round, open the returned findings file. Use
   [review-core.md](review-core.md#5-verify-findings-and-act) §5 to verify each finding against
   the current code, fix in-scope issues, backlog out-of-scope issues, and account for every
   disposition. Check stale and unverified findings especially carefully. Keep the working
   tree and index intact apart from authorized fixes and backlog edits. No stage, commit,
   push, revert, or worktree switching without explicit authorization.
6. **Loop**. In adversarial mode only, if this round fixed a confirmed major or critical
   finding and the cap permits it, call `review_next` with this round's directory,
   the one-based findings positions of the fixed items, and `known_issues` with one line
   per disposition from all rounds. The next round reviews the cumulative change. Repeat
   from step 5 until the result is clean of actionable major/critical issues or the cap
   is reached. A failed or interrupted job returns a run directory for resume.
7. **Report**. Give the severity, verdict, file and disposition for each finding, note the
   spec sources, and include the round count, stop reason, and run directory. Report a failed
   round as incomplete and include its resume invocation.
