# Code review workflow

Use this procedure after an explicit skill invocation. The current session resolves the
target and configuration and acts on the report. The bundled scheduler owns each review
round, including planning, reviewer dispatch, verification, and checkpoints.

1. Run `printenv CODE_REVIEW_CHILD` before other tool calls. If it prints a nonempty
   value, refuse the recursive invocation and stop. Use the Git root of the workspace
   where the user invoked the skill. In Claude Code, copy the rendered plugin install
   path from the skill into tool calls as an absolute path. In Codex and Pi, start
   at the directory containing the loaded `SKILL.md` and go up two levels to the
   plugin root. Use `python3 -B "<plugin-root>/scripts/review.py" --repo "<git-root>"`
   for the scheduler commands below.
2. Follow [configuration.md](configuration.md). In setup mode, finish after the
   configuration procedure. Ask through the host's question tool when available or in
   the conversation. Wait for an answer when target, resume selection, or configuration
   needs one.
3. For a new review, resolve an explicit target. Ask when it is missing or ambiguous.
   Use `staged` for the index, `files` with repo-relative paths, `commit` with one SHA
   or both endpoints of an inclusive range, or `branch <base>` for committed changes
   since the merge base. For cumulative changes including local edits and untracked
   files, use `working-tree <baseline-commit>`. Use the supplied baseline, or resolve
   the merge base when the user asks for branch changes plus local work. Plain
   `working-tree` compares with HEAD. Include intended behavior in the description. Pass the
   spec paths from `--spec=<path>[,<path>…]` or the conversation and pass requirements
   present only in the conversation as spec context. If neither source exists, ask once
   with no spec as the default.
4. Launch one `run` per new review. Set `--backend` to the **current host**
   (`claude`, `codex`, or `pi`). Its project profile selects the worker harness and
   model overrides. In Pi, pass `--active-model=<provider/id>` when the Pi alias
   supplies its session model. Translate `-c=N` to `--concurrency=N` and pass each
   spec path as a separate `--spec`. Include optional flags only when applicable.
   Quote each value so the shell treats it as a literal argument.

   ```text
   run --backend <host> --mode <normal|adversarial> [--concurrency=<N>]
       [--max-rounds=<N>] [--description=<text>] [--spec=<path>]...
       [--spec-context=<text>] [--active-model=<provider/id>]
       -- <target-kind> [<value>...]
   ```

5. For resume, run `resume -- [<run-dir>]`. With no directory, the scheduler lists
   incomplete rounds. Offer the latest candidate and confirm it before resuming.
   Resume uses the recorded runner, task plan, and models. A `legacy` result identifies
   a Claude checkpoint from before parent run records existed. Follow
   [the legacy resume procedure](review-core.md#resuming-a-failed-round) with the original
   compatible runner. If that runner is unavailable, report the blocker.
6. Wait for the scheduler to finish before reading the report or making edits.
   In Claude Code, launch each round as a background Bash task and wait for its
   completion notification. In Codex, allow the shell command to return a running
   session and wait on that same session until it exits. In Pi, use Bash with its
   timeout unset. While a round is running, wait for its result before doing other
   work or launching again. For an incomplete result, give the error and the resume
   invocation with the returned round path. For a launch error, report the blocker.
7. For a completed round, open the returned findings file. If the user requested
   review only, verify and report findings without applying fixes or writing backlog
   entries. For a review-and-fix request or the default workflow, use
   [the review core](review-core.md#5-verify-findings-and-act) to verify each finding
   against current code, consolidate duplicates, fix in-scope issues, backlog
   out-of-scope issues, and account for every disposition. Check stale and
   unverified findings carefully. Keep Git staging, commits, pushes, reverts, and
   worktree changes under the user's explicit control.
8. In adversarial mode, continue if this round fixed a confirmed major or critical
   finding and the cap permits another round. Pass the completed round path,
   one-based findings positions of all fixed items from that round, and a line per
   disposition across all rounds. The next round reviews the cumulative change.
   Wait and process the new result as above.

   ```text
   next --fixed=<index> [--fixed=<index>...] --known-issues=<text> -- <run-dir>
   ```

9. Report severity, verdict, file and disposition for each finding, the spec sources,
   round count, stop reason, and run directory.
