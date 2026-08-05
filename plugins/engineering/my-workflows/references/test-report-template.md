# Test Report Presentation Guide

Use this guide to turn repository evidence into a test-submission report that a reviewer or tester can scan quickly. It defines content priorities and presentation patterns, not a rigid list of mandatory headings.

## Language and tone

- Write the report in Simplified Chinese unless the user explicitly requests another language.
- Use product language for E2E content and precise implementation language for Code Review content.
- Lead with impact and expected behavior. Keep file-level evidence concise and secondary.
- State uncertainty plainly. Use a natural localized equivalent of “To be provided” for missing operational details and “Cannot be confirmed from this change” for unsupported behavior.

## Adaptive structure

Always start with:

1. A localized title equivalent to “Test Submission Report”.
2. A compact metadata table containing the normalized scope, base, target, included commits or working-tree state, selected perspective, and output time only when the time is known.
3. A short change summary that explains the purpose and the highest-impact behavior in two or three sentences.

After that, include only sections that help explain the actual change. Do not emit empty sections, “not applicable” rows, or headings for surfaces that do not exist in the project.

Examples of surface-specific sections:

- Use a localized “Affected pages and entry points” section only when pages, routes, or user navigation are affected.
- For services or backend changes, use sections such as affected APIs, jobs, events, data contracts, or integrations.
- For CLI tools, use affected commands, flags, input/output, and exit behavior.
- For libraries, use affected public APIs, consumers, compatibility, and migration impact.
- For configuration or infrastructure, use affected environments, rollout controls, and operational behavior.

A report may combine multiple relevant surfaces. Name sections naturally for the project instead of appending labels such as “frontend project”.

## E2E perspective

Include this perspective by default unless the request selects Code Review only.

### Impact overview

Prefer a table when there are multiple areas or flows:

| Area or flow | What changed | User or system impact | Regression priority |
|---|---|---|---|
| Use a product-facing name | Summarize the functional change | Explain the observable consequence | High / Medium / Low with a brief reason |

Merge closely related files into one area or flow. Mention key paths only as supporting evidence.

### Behavior changes

Use a comparison table when before-and-after behavior can be stated clearly:

| Scenario | Before | After | What must remain unchanged |
|---|---|---|---|
| Describe the trigger or user goal | Observable previous behavior | Expected new behavior | Adjacent behavior that needs regression coverage |

If the change is easier to understand as a sequence or state transition, use a short flow or ordered list instead of forcing it into a table.

### Test scenarios

Create one scenario per meaningful user or system journey. Name scenarios by intent, not by filename.

Use a compact context table when several prerequisites matter:

| Item | Details |
|---|---|
| Preconditions | Account, permission, feature flag, data state, environment, or a localized “To be provided” marker |
| Entry point | Confirmed page, route, API, command, event, or other interaction surface |
| Test data | Concrete known data or a clearly marked missing-data requirement |

Map each action directly to an observable result:

| Step | Action | Expected result |
|---:|---|---|
| 1 | A concrete tester action or system trigger | The corresponding visible, state, response, data, or side-effect result |
| 2 | The next action | The corresponding result |

For frontend flows, name the controls to click or edit and the visible state to verify. For non-frontend flows, replace UI actions with concrete API, CLI, job, event, integration, or data operations.

Finish each scenario with a short regression checklist covering only relevant adjacent flows, boundaries, permissions, errors, compatibility, or rollback-sensitive behavior.

When no meaningful end-to-end behavior can be proven, do not invent a user flow. Explain the testability boundary and provide the closest valid integration, contract, or regression checks.

## Code Review perspective

Include this perspective only when the user explicitly requests Code Review or both perspectives.

### Review map

Prefer a table that directs reviewers to the highest-value locations:

| Area | Key path or symbol | Change | Review focus | Risk |
|---|---|---|---|---|
| Module or responsibility | Concise evidence | Implementation summary | Concrete invariant, contract, caller, or edge case to inspect | Confirmed impact or plausible risk, clearly labeled |

Do not narrate every changed file. Group mechanical, generated, formatting-only, snapshot, and lockfile changes separately when they matter.

### Contracts and behavior

Use a before-and-after table for behavior, API, type, state, permission, or data-contract changes:

| Contract or scenario | Before | After | Compatibility or caller impact |
|---|---|---|---|
| Name the affected behavior | Base-revision behavior | Target behavior | Explain affected consumers and regression exposure |

Add a short call-flow or dependency explanation only when reviewers need it to understand blast radius.

### Verification guidance

List focused technical checks and the assertion each check should prove. Prefer known repository commands only when they are confirmed from project configuration or documentation. Otherwise describe the verification goal without inventing a command.

## Readability rules

- Prefer tables for structured comparisons, impact maps, review maps, and action-to-expectation steps.
- Prefer prose for causal explanations, nuanced uncertainty, and short summaries.
- Keep cells concise; move long reasoning below the table.
- Avoid repeating the same change under multiple headings.
- Order content by user impact or review risk, not alphabetically by file.
- Separate confirmed behavior, regression risk, and missing information.
- Use file paths and symbols as evidence, not as the report's organizing principle.
- Omit any page, route, API, command, job, data, or integration section that is not relevant to the analyzed change.
