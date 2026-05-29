# Architecture

This document describes the high-level architecture of <PROJECT>. If you
are about to dive into the code base, this is the right place to start.

For the project's product requirements, motivation and competitive
positioning, see <REFERENCE-TO-PRD-OR-README>. This document focuses
purely on _how_ the system is built.

## Bird's Eye View

<!--
  Required ingredients:
    1. ONE ASCII diagram (no images, no mermaid). Boxes for major
       subsystems, arrows for dataflow. If the system has a clear
       build-time / runtime split, draw two stacked boxes.
    2. 3-6 paragraphs of prose. Open with a one-sentence elevator
       pitch ("X is a thin pipe between A, B and C"). Then walk
       the diagram top-to-bottom, naming each box and stating its
       single responsibility. Close with the most important
       deliberate non-goal of the system.

  Hard rules:
    - Mention every top-level package or subsystem from the Code Map
      below at least once.
    - Use plain English. No marketing voice ("blazing fast",
      "industry-leading"). State facts.
    - The reader should be able to predict the next section's table
      of contents from this diagram alone.
-->

```
<ASCII DIAGRAM HERE>
```

<ELEVATOR PITCH PARAGRAPH>

<WALK THROUGH OF EACH BOX, ONE PARAGRAPH PER LAYER>

<NON-GOAL PARAGRAPH — what the system deliberately is NOT>

## Code Map

This section walks through the workspace top-down. Pay particular
attention to the **Architecture Invariant** call-outs; they often
describe what the code _deliberately_ does not do.

<!--
  For EACH module / package / subsystem, repeat the block below.
  Order matters: depend-ees before depend-ers (leaves first, then
  composers, then entry points).

  In each block:
    1. One-paragraph role statement.
    2. Bulleted file-by-file walkthrough. EVERY bullet must link
       to the file with a relative markdown link. Aim for ONE bullet
       per non-trivial file.
    3. ZERO or MORE Architecture Invariant call-outs. State a property
       of the design and why it is held. Prefer the phrasing
       "deliberately does NOT do X" where it fits.
    4. ZERO or ONE API Boundary call-out, only for packages that are
       contracts to external consumers.

  Skip the block if a folder is purely scaffolding (e.g. examples).
-->

### `<package-or-folder-name>`

<ONE PARAGRAPH ROLE STATEMENT>

- [`<file>`](path/to/file) — <what it does, in one sentence>.
- [`<file>`](path/to/file) — <what it does>.

**Architecture Invariant:** <a property the code maintains, ideally
phrased as something it deliberately does NOT do.>

**Architecture Invariant:** <another invariant if applicable.>

`<package-name>` is an **API Boundary**. <one sentence on who consumes
it and why the contract must stay stable.>

<!-- Repeat the ### block for every module. -->

## Cross-Cutting Concerns

<!--
  Concerns that are not owned by any single module but are policed
  across the codebase. Common candidates:
    - build-time vs runtime separation
    - error handling / graceful degradation
    - performance budgets
    - security / sandboxing
    - testing strategy
    - dev-only vs production safety
    - module resolution under monorepo / strict package managers
    - data contracts shared between layers
    - observability / logging conventions

  Aim for 4-8 short subsections. Each one has:
    1. A name in title case as ###.
    2. 1-3 paragraphs explaining the principle.
    3. Where useful, an Architecture Invariant call-out.
-->

### <Concern Name>

<EXPLANATION>

**Architecture Invariant:** <if applicable>

<!-- Repeat. -->

## Out of Scope

<!--
  Optional but highly recommended. List what this document
  intentionally does not cover (e.g. UI design language, deployment
  topology, internal APIs of vendored libraries) and where to find
  that information instead.
-->

- <topic> — see <link>
