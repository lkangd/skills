# Decision rubric

Use the script output first, then apply this rubric with project context.

## Recommendations

### approve

Proceed when:

- No critical or high-severity red signals are present.
- The dependency is needed and its footprint is proportionate.
- Install scripts are absent or clearly justified.
- The package has credible maintenance and package history.
- For production/runtime use, the source-to-publish story is acceptable for the project's risk tolerance.

### review

Pause and inspect manually when:

- Provenance is missing but other signals are reasonable.
- The repository could not be inspected.
- Maintenance is weak but the package is small, dev-only, or easy to replace.
- CI/code-quality signals are missing but no direct security red flags were found.
- The package is useful but alternatives may be safer.

Ask the user before installing if the package will become production-critical, broad in blast radius, or hard to remove.

### block

Do not install by default when any of these are true:

- Package does not exist, is deprecated for security/abandonment reasons, or has no credible history.
- Unexplained direct or transitive install scripts with network, filesystem, shell download, encoded, or credential-like behavior.
- Known severe unresolved vulnerabilities.
- Suspicious tarball content, source capability tokens, binary/native artifacts, or repository mismatch.
- Newly published plausible AI-hallucination package with little/no repository history.
- A new release after a long dormant period that cannot be tied to expected source history.
- High transitive dependency footprint for a trivial helper.
- Non-npm registry lockfile sources unless the user/project explicitly expects that registry.

A user can still override, but the agent should make the risk explicit and suggest alternatives.

## Context multipliers

Increase scrutiny for:

- Runtime production dependencies.
- Packages that handle credentials, auth, crypto, HTTP clients, database access, file uploads, build/deploy pipelines, code generation, or shell execution.
- Dependencies used across many services/apps.
- Packages that will be hard to replace.

Decrease scrutiny slightly for:

- Dev-only packages in isolated experiments.
- Internal one-off tools.
- Packages that are easy to remove and do not run install scripts.

## Interpreting common signals

- **Missing provenance:** yellow by itself; red only when combined with suspicious release history, repo mismatch, or install scripts.
- **Single maintainer:** operational risk, not automatic rejection.
- **Old last publish:** acceptable for stable tiny packages; risky for complex packages or packages tied to fast-moving platforms.
- **No `exports`:** modernization concern, not security-critical.
- **No `SECURITY.md`:** concern for high-stakes packages; common for small libraries.
- **Recent version:** review the release diff; new versions are risky when combined with a long dormant gap, new scripts, new binaries, or maintainer changes.
- **Transitive install scripts:** treat as execution risk even if the top-level package has no scripts.
- **CLI/native/binary surface:** yellow by itself for tools that clearly need it; red when surprising for a simple library or combined with opaque source/publishing signals.
- **Sensitive source tokens:** inspect context before blocking; build tools may legitimately use `child_process`, but auth/UI/date helpers usually should not.
- **Non-npm lockfile sources:** acceptable only when the project intentionally uses a private registry or verified external tarball.
