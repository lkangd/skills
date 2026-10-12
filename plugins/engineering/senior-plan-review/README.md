# senior-plan-review

Risk-tiered plan review for engineers who audit an agent's **decisions** instead of its code.
Given an implementation plan (or a mid-execution checkpoint), the skill verifies the plan's
claims against the repository, classifies the most dangerous action as LOW / MEDIUM / HIGH /
CRITICAL, and returns a decision brief: intent, approach, alternatives, risks, impact,
validation, open decisions, recommendation, and an explicit plan status
(`REVIEWED`, `REVISION_REQUIRED`, `REAPPROVAL_REQUIRED`, ...).

Design principle: *simplify the explanation, not the engineering.* The brief is short for LOW
plans and complete for HIGH/CRITICAL ones; it never approves anything by itself.

## Install

### Claude Code

From this marketplace:

```
/plugin marketplace add lkangd/agent-skills   # once, if not already added
/plugin install senior-plan-review@lkangd-skills
```

Or for a single session without installing:

```
claude --plugin-dir /path/to/agent-skills/plugins/engineering/senior-plan-review
```

Or copy `skills/senior-plan-review/` to `~/.claude/skills/senior-plan-review/` (personal) or
`.claude/skills/senior-plan-review/` (project).

### Codex CLI

Codex reads skills from `.agents/skills/` (repo) or `~/.agents/skills/` (user). Symlink or copy
the skill directory:

```
mkdir -p ~/.agents/skills
ln -s /path/to/agent-skills/plugins/engineering/senior-plan-review/skills/senior-plan-review ~/.agents/skills/senior-plan-review
```

## Invoke

| Platform | Explicit | Implicit |
| --- | --- | --- |
| Claude Code (plugin) | `/senior-plan-review:senior-plan-review [focus]` (bare `/senior-plan-review` also resolves when unambiguous) | Claude may load it when the request matches the description (plan review, approve/sanity-check a plan, migrations, auth, concurrency, destructive ops) |
| Claude Code (skills dir) | `/senior-plan-review` | same |
| Codex CLI | `$senior-plan-review` in the prompt | Codex matches on the description; disable with `agents/openai.yaml` `policy.allow_implicit_invocation: false` if unwanted |

Typical flow:

1. Ask the agent to plan (`--permission-mode plan` in Claude Code, `--sandbox read-only` in Codex).
2. `/senior-plan-review:senior-plan-review` — get the brief.
3. Reply with an explicit approval that names the plan (and, for CRITICAL operations, the
   specific operation). For LOW plans the brief says the agent may proceed under existing
   authorization.
4. If the agent discovers extra scope during execution, the skill tells it to stop and report
   `REAPPROVAL_REQUIRED`; the same checkpoint can be reviewed again with the skill.

## Input and output

Input is whatever is already in context: the user's request, the drafted plan (or the transcript
of an in-progress execution), the repository, project conventions, prior approvals. If no plan
exists the skill asks the agent to draft one from the codebase first and says so.

Output for a LOW plan (abridged real output from the evaluation):

```
Recommendation: APPROVE (LOW risk)
Intent: make the Overdue badge red so support sees it in screenshots; keep it readable by
screen readers.
Approach: edit web/src/components/StatusBadge.tsx only; used in OrderTable.tsx:30 (verified).
Issue: role="status" creates a live region per table row — drop it; visible text already
announces the status.
Validation: npm run lint + npm test; no component tests exist (verified).
Plan status: REVIEWED
```

Output for a HIGH plan (abridged):

```
## Recommendation
REVISE. Risk tier: HIGH (concurrency fix that does not work in production topology).
Plan status: REVISION_REQUIRED

## Intent ...
## Approach ...
## Alternatives
- SELECT ... FOR UPDATE inside the existing transaction, or UPDATE ... WHERE stock >= $1 and
  check rowCount: both fix the race across replicas, no new infrastructure.
## Risks
1. In-process mutex only serialises one Node process; docker-compose.yml runs replicas: 3,
   so the oversell persists exactly where it was observed (verified).
...
## Decisions
1. Blocking (FOR UPDATE) vs fail-fast (conditional UPDATE) under contention. My pick: ...
```

## Risk tiers and approval protocol

See [`skills/senior-plan-review/SKILL.md`](skills/senior-plan-review/SKILL.md) for the tier
table, the brief format and the approval rules, and
[`references/risk-tiers.md`](skills/senior-plan-review/references/risk-tiers.md) for borderline
cases (schema changes, concurrency, auth, dependencies, destructive operations, escalation
during execution).

## Known limitations

- **The skill enforces nothing.** It shapes the agent's judgement and output. A model can
  misclassify a tier or be talked out of its rules. Put real guard rails around the operations
  that would hurt: Claude Code plan mode / permission deny rules / `PreToolUse` hooks, Codex
  read-only sandbox and approval policy, backups, change tickets. Details in
  [`references/platform-notes.md`](skills/senior-plan-review/references/platform-notes.md).
- **No durable approval state.** `Plan status:` is a convention inside the conversation. Across
  sessions, record status and approved scope in the plan file or add a hook/CI gate.
- **Review costs tokens and words.** The skill makes the agent read the files the plan
  references. Measured on the evaluation fixture (Claude Sonnet): +42% input tokens, +24% output
  tokens, +10% wall time, median brief 611 vs 523 words. The model treats the per-tier word
  budgets as soft when it has many findings. Do not invoke it for LOW changes.
- **Length is the main quality regression.** In the blinded evaluation the skill scored lower
  than the unassisted baseline on conciseness (−0.45 / 5) while scoring higher on approval
  discipline (+0.84), risk calibration (+0.66) and actionability (+0.61). See `EVALUATION.md`.
- **Verified/inferred labels reduce but do not eliminate over-claiming.** The agent occasionally
  labels a plausible inference as verified; read the `verified` tags as "the agent says it read
  this", not as proof.
- **Implicit triggering is platform-dependent.** Claude Code and Codex both match on the
  description, but neither guarantees it; use explicit invocation in a Plan → Approve workflow.

## Evaluation

`evaluation/` contains a reproducible Baseline-vs-Skill harness on an isolated fixture
repository (18 scenarios, 12 dev + 6 holdout), a 10-dimension rubric with 0–5 anchors, hard
safety gates, a blinded cross-model judge, and the results. See
[`EVALUATION.md`](EVALUATION.md) for the report and `evaluation/run_eval.py --help` for the
commands.

## Directory layout

```
plugins/engineering/senior-plan-review/
├── .claude-plugin/plugin.json
├── README.md
├── EVALUATION.md
├── skills/senior-plan-review/
│   ├── SKILL.md
│   └── references/
│       ├── risk-tiers.md          borderline tier decisions and escalation rules
│       ├── review-examples.md     one LOW and one HIGH brief at the expected density
│       └── platform-notes.md      Claude Code vs Codex invocation and enforcement
└── evaluation/
    ├── fixtures/ledgerly/         isolated sample repository (Node/TS/Postgres)
    ├── scenarios/*.json           18 scenarios with answer keys (never read by the skill)
    ├── prompts/                   agent prompt templates, judge prompt + JSON schema
    ├── rubric.json                scoring anchors and hard gates
    ├── run_eval.py                run baseline/skill arms on Claude Code or Codex
    ├── grade.py                   hard gates + blinded LLM judge
    ├── report.py                  aggregate to summary JSON and markdown tables
    ├── trigger_check.py           implicit-invocation check (should / should not trigger)
    └── results/<run-id>/          raw agent events, final texts, grades, summaries
```

## Author

Curtis Liong (<lkangd@gmail.com>)
