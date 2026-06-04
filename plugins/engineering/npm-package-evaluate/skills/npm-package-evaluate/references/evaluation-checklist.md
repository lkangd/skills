# npm package evaluation checklist

Use this checklist when the automated evaluator reports `review`, when the dependency is production-critical, or when the package touches credentials, network traffic, build/deploy systems, auth, crypto, data storage, or generated code.

## 0. Necessity and blast radius

- Can this dependency be avoided or replaced with a few lines of local code?
- If it disappeared tomorrow, how much code would need to change?
- Will it be imported broadly across services/apps, or isolated to one small tool?
- Is it runtime, dev-only, build-time, or test-only?
- Does its dependency footprint match its job? A tiny utility with a large transitive tree deserves skepticism.

## 1. Package existence and slopsquatting risk

- Verify the exact name exists on npm and has real history.
- Be extra careful with package names suggested by an AI assistant.
- Look for near-name alternatives, typos, unexpected scopes, or new packages with names that sound like common hallucinations.
- Prefer packages with a coherent README, real repository, multiple versions over time, and external references.

## 2. Active maintenance

- Oldest open issues: are maintainers responding?
- Recent commits: are meaningful source changes happening, not only bot or CI noise?
- Release cadence: regular enough for the package scope, with no suspicious long gap followed by sudden activity.
- Maintainer concentration: is all work done by one person?
- Changelog quality: does it explain user-visible changes, fixes, and migration notes?
- Migration guides: are breaking changes documented with upgrade paths?

## 3. Published artifact trust

- npm provenance badge/details: does the version have a provenance attestation tied to the expected repository, commit, and workflow?
- `npm audit signatures`: can installed packages' signatures/provenance be verified?
- Publish workflow:
  - Uses `npm publish --provenance`.
  - Has `id-token: write` permission for OIDC.
  - Avoids long-lived `NPM_TOKEN` secrets when trusted publishing is possible.
- GitHub Actions are pinned to full commit SHAs, especially third-party actions.
- Package tarball content matches expectations and contains no surprising generated/minified/obfuscated code for the package type.

## 4. Install scripts

Install hooks (`preinstall`, `install`, `postinstall`) execute during installation. They are security-critical.

Green:
- No install scripts.
- Native addon build scripts with an obvious reason and transparent source.

Red:
- Network calls, shell downloads, environment-variable reads, credential references, encoded blobs, or opaque scripts.
- Install scripts in packages that do not clearly need native compilation or binary setup.

## 5. CI and test reality

- CI runs on `pull_request`, not only after merging to the default branch.
- Recent merged PRs waited for CI.
- Test files mirror the source layout or cover meaningful edge cases.
- Coverage thresholds exist and are enforced (for example 80%+ lines/functions/branches where appropriate).
- Type checks and lint checks run in CI.

## 6. Visible code quality

- Non-trivial lint configuration exists.
- `exports` is modern and explicit; TypeScript packages publish `types`.
- `prepublishOnly` or release workflow runs build/tests before publishing.
- TypeScript uses `strict: true`.
- `any` and `@ts-ignore` are rare and justified.
- Public API shape is documented and stable enough for the intended usage.

## 7. Security response posture

- `SECURITY.md` or GitHub security policy provides private disclosure instructions and contact details.
- GitHub advisories, if any, were handled responsibly with clear affected versions and fixes.
- OSV/Snyk/Socket-style sources do not show unresolved severe issues.
- Past critical issues were fixed quickly enough for your risk tolerance.

## Fast path: top three checks

When time is limited, check these first:

1. Do you actually need it?
2. Does the published package have provenance or another trustworthy source-to-publish story?
3. Does it have unexplained install scripts?

For production-critical dependencies, add: are maintainers responsive when something goes wrong?
