---
name: npm-package-evaluate
description: This skill should be used before an agent installs or adds an npm dependency, including npm install, pnpm add, yarn add, bun add, package selection, or AI-suggested package names. It runs a repeatable npm package risk evaluation and returns an agent-friendly approve/review/block decision from cached package facts and current usage context.
---

# npm Package Evaluate

Use this skill as a dependency gate before installing an npm package. The goal is not to prove a package is safe; it is to make the installation decision explicit, repeatable, and auditable.

The core workflow is automated by [`scripts/evaluate_npm_package.py`](scripts/evaluate_npm_package.py). It gathers npm registry metadata, checks release-age anomalies, downloads the package tarball with lifecycle scripts disabled for static inspection, scans execution surfaces such as install scripts, CLI entrypoints, native/binary files, bundled/optional dependencies, and sensitive source-code tokens, optionally inspects the GitHub repository, optionally creates an isolated temporary package-lock for transitive dependency/source/lifecycle-script checks plus `npm audit`, caches package facts in the temp directory, and prints a concise decision summary for the current usage context.

## Quick start

Run the evaluator before any install command:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/evaluate_npm_package.py" <package[@version]> --context <prod|dev|tool|unknown> --necessity "<why this dependency is needed>"
```

Examples:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/evaluate_npm_package.py" date-fns@latest --context prod --necessity "date formatting replacement under consideration"
python3 "${CLAUDE_SKILL_DIR}/scripts/evaluate_npm_package.py" @types/node --context dev --necessity "TypeScript declarations for Node APIs"
python3 "${CLAUDE_SKILL_DIR}/scripts/evaluate_npm_package.py" vite --context tool --json --fail-on review
```

The evaluator caches package facts under:

```text
${TMPDIR:-/tmp}/claude-npm-package-evaluate/<sanitized-package>/<version>/facts.json
```

For scoped packages, `/` is sanitized to `__`; for example, `@scope/pkg@1.2.3` caches under `@scope__pkg/1.2.3/facts.json`.

Facts are cached by resolved `<package>@<version>`. Each invocation recomputes `decision` for the current `--context`, because production, dev, and tooling dependencies have different risk tolerance. If a cached facts file was generated with lighter options such as `--no-audit` or `--no-github`, a later stricter run refreshes the facts automatically. If a stricter cached facts file already exists, lighter runs may reuse those facts and include previously collected audit/GitHub signals; skip flags only prevent fresh collection when the cache does not already satisfy the request.

## Decision workflow

1. **Run the script first.** Do not install the package into the user project before evaluation. This matters for LLM-suggested packages because plausible names can be slopsquatting candidates.
2. **Explain necessity.** Pass `--necessity` when possible. If omitted, the report will remind you to state why local code or an existing dependency is insufficient.
3. **Read `decision.recommendation`.** Use it as the default action:
   - `approve` — proceed only if the dependency is genuinely needed.
   - `review` — pause and inspect the listed concerns; ask the user when risk tolerance is unclear.
   - `block` — do not install unless the user explicitly accepts the risk or provides a safer source/version.
4. **Treat critical flags as blockers.** Unexplained install scripts, deprecation, missing package history, severe vulnerabilities, suspicious tarball contents, repository mismatch, or strong typosquat/slopsquat indicators should override popularity signals.
5. **Apply context.** Production/runtime dependencies deserve stricter scrutiny than dev-only tools. A tiny internal script can accept more operational maturity risk than an auth, crypto, HTTP, database, build, or deployment dependency.
6. **Compare alternatives when needed.** If the report says `review` or `block`, evaluate a better-known alternative before installing.
7. **State the decision before installing.** Summarize the package, version, recommendation, top risks, and necessity.

## Agent-friendly output

The script writes cached facts and prints structured data with this shape:

```json
{
  "target": {"name": "pkg", "version": "1.2.3", "specifier": "pkg@1.2.3"},
  "context": "prod",
  "necessity": "why the dependency is needed",
  "decision": {"recommendation": "approve|review|block", "risk_score": 0, "risk_level": "low|medium|high|critical", "summary": "..."},
  "signals": [{"id": "install_scripts", "status": "green|yellow|red|unknown", "severity": "low|medium|high|critical", "message": "..."}],
  "evaluation_options": {"include_github": true, "include_audit": true},
  "cache": {"hit": false, "path": "/tmp/.../facts.json"}
}
```

Use `--json` when another agent or script will consume the result directly. Use `--fail-on block` to make blocked packages exit non-zero, or `--fail-on review` to enforce manual review in automation. Exit codes: `0` means evaluation completed and did not cross the fail-on threshold, `1` means evaluation failed and the package should be treated as blocked, `2` means the npm CLI is unavailable, and `3` means the recommendation crossed the configured fail-on threshold.

## Scope and limitations

The automated script is conservative and static. It checks signals and indicators; it does not prove safety.

- **Provenance:** the script checks available npm metadata and workflow hints, but npm CLI output does not always expose full provenance details. Manually check npmjs.com or run `npm audit signatures` after installation when provenance is important.
- **Slopsquatting:** the script checks package existence, age, and history. It does not fully prove that a near-name package is legitimate.
- **CI and code quality:** the script checks basic CI/code-quality signals such as workflow presence, mutable action refs, `exports`, and `types`. For production-critical dependencies, manually inspect tests, coverage thresholds, lint/typecheck jobs, and TypeScript strictness.
- **Audit mode:** when enabled, the script creates an isolated temporary project and runs `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` followed by `npm audit --json`. It does not install into the user project and does not run lifecycle scripts.
- **Static source scanning:** sensitive source-code tokens, native files, CLI entrypoints, bundled dependencies, and transitive install-script signals indicate review-worthy execution surface. They are not automatic proof of malware; inspect whether the behavior is expected for the package type and usage context.

## Manual follow-up for high-stakes dependencies

For production-critical dependencies, also consult:

- [`references/evaluation-checklist.md`](references/evaluation-checklist.md) for the full manual review checklist.
- [`references/decision-rubric.md`](references/decision-rubric.md) for how to convert signals into an install decision.
- [`references/decision-note-template.md`](references/decision-note-template.md) when you need to leave a human-readable dependency decision in a PR, issue, or conversation. Fill it manually from the JSON report and your necessity rationale.

## Common pitfalls

- **Do not trust stars/downloads alone.** They indicate popularity, not source-to-publish integrity or current maintainer responsiveness.
- **Do not install first and evaluate later.** Install hooks may execute during installation; static tarball inspection should happen first.
- **Do not ignore a missing version history.** A newly registered package with a plausible name is exactly the shape of slopsquatting risk.
- **Do not treat missing provenance as automatic malware.** Many legitimate packages lack provenance, but missing provenance means the source-to-registry chain is not cryptographically verified.
- **Do not let cache hide changing risk when stakes are high.** Use `--refresh` after a new release or when you want a fresh audit/GitHub check.
