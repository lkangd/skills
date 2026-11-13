# code-review

Review an explicit Git change from the session that wrote it. Independent, read-only
reviewers examine the diff from several angles. Separate agents verify bug findings.
The invoking session checks the evidence, fixes confirmed in-scope issues and files
deferred findings in the backlog. An adversarial review repeats after fixing a
confirmed major or critical finding, up to the configured round cap.

## Install

The local workflows require Git, Bash, jq and Python 3.9 or newer. Each host uses its
own CLI and authentication. The installed workflows were verified on Codex 0.166.0
and Pi 1.5.2. Pi Git installation also uses its configured package manager.

| Host | Install | Invoke |
|---|---|---|
| Claude Code | `/plugin marketplace add lkangd/agent-skills` then `/plugin install code-review@lkangd-skills` | `/code-review <target>`, `/code-review:adversarial <target>`, `/code-review:setup` |
| Codex | `codex plugin marketplace add lkangd/agent-skills` then `codex plugin add code-review@lkangd-skills` | `$code-review:code-review <target>`, or pass `adversarial <target>`, `resume [<run-dir>]` or `setup` to the same skill |
| Pi | `pi install git:github.com/lkangd/agent-skills` | `/code-review <target>`, `/code-review:adversarial <target>`, `/code-review:setup` |

For development, add the repository checkout as the Codex marketplace or run
`pi install /absolute/path/to/agent-skills`. Start a new host session in the project
after installation. The Codex entry uses the bundled local MCP launcher. Approve the
displayed repository when it prompts on first use. Each command launches one independent
scheduler per round. The invoking session waits for its final result before acting on findings.

## Review and resume

Targets are explicit. Use a commit SHA, inclusive commit range, `staged`,
`working-tree`, file paths, or `branch <base>`. Provide requirements with
`--spec=<path>[,<path>…]`. The invoking session can also use relevant requirements
already in the conversation. Use `-c=N` for a per-run concurrency override and
`--max-rounds=N` in adversarial mode.

A run writes its plan, task receipts and final `out/findings.json` under
`.code-review/runs/`. Use the host's stop control to interrupt a round. Resume via
`/code-review resume [<run-dir>]` in Claude Code or
Pi, or the Codex skill's `resume` argument. A portable run resumes with its original
Codex or Pi backend, even when the other host initiates recovery. Its backend CLI must
be available and authenticated. Claude checkpoints use the Claude command and retain
the compatible runner. For older checkpoints without runner metadata, provide the
original command when asked.

The shared scheduler saves each valid receipt when its task finishes. A completed
empty receipt counts as work done. A round with failed tasks stays incomplete after
one retry, and resume reuses completed work. In adversarial mode, the first round
also runs a gap sweep. Later rounds review the cumulative diff and carry forward
handled findings. The plugin leaves staging and commits to the user.

## Configuration and model selection

All hosts require [.code-review/config.local.json](references/configuration.md) in the
reviewed project. When it is missing or incomplete, provide or accept the proposed
settings and confirm the complete JSON before the first round. Run the setup command
again to edit it. Claude supports an external runner such as `claude` or a compatible
prefix such as `ccsp -g <preset> claude`.

Tasks are classified as high, medium or low complexity. The backend checks its
available models and supported reasoning settings when it can. Configure per-host
model or effort overrides in `models`. For Pi providers loaded only by extensions, configure all three worker model levels
with models available to the restricted worker.

For a large diff, the planner considers the task's context budget and balances
related files across the available reviewer slots. It can assign separate hunks
from a large file to different reviewers. It retains a single scope when splitting
would leave a small tail and the whole scope fits. The persisted plan is the source
of truth on resume.

For scheduler diagnostics, inspect the round's `out/` directory. To use the
shared scheduler directly, run `python3 -B scripts/review.py --help` from the
plugin directory. The CLI produces a review report for the invoking agent to act on.

## Verification

Run `python3 -B evaluation/installed_workflows.py` from the plugin directory.
It installs both entry points in isolated homes and exercises normal review, the
adversarial fix and re-review loop, and interruption with checkpoint reuse. The
suite uses deterministic test models. Run the existing Bash suites for Claude
launcher and receipt compatibility.

Use `python3 -B evaluation/installed_workflows.py codex --long-wait` to test a single
installed MCP call that stays open for over five minutes.
