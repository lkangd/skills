# Architecture Invariant Patterns

The single highest-value sentence in an architecture document is the
**Architecture Invariant** call-out: a one-line property the codebase
maintains, paired with the reason it is maintained. This file is a
checklist of common invariant categories and how to spot them.

When drafting a module's section, ask each of these questions about
the module's source. If the answer is "yes", you have an invariant.

## 1. Deliberate non-dependencies

> Does this package depend on something obvious that you might expect
> it to depend on, but it doesn't?

Examples:

- A Vue source-map injector that does **not** depend on
  `@vue/compiler-sfc` (so it survives major version bumps of Vue).
- A config package with **zero** Node-only imports, so it can run in
  the browser if a UI ever wants it.
- A CLI that does **not** depend on the daemon package, talking to it
  only over HTTP, so a dead daemon never breaks the CLI.

How to phrase:

> **Architecture Invariant:** the Vue transformer does not import
> `@vue/compiler-sfc`. We use a hand-rolled tokenizer because that
> package's API has churned across 3.0 → 3.4 and we want this
> transformer to keep working without a coordinated upgrade.

## 2. Single source of truth

> Is there exactly one place where a particular fact (a default, a
> schema, a constant) is defined, with everything else importing it?

Spot it by grep-ing for a constant or default and confirming there is
only one definition. Mention it as an invariant whenever the
single-definition rule is structurally enforced (one zod schema, one
defaults file, one shared types module).

## 3. Layering / direction of dependencies

> Does the package graph have an enforced direction (low-level types
> at the bottom, glue code at the top), and would a back-edge be a
> bug?

Run the scan script's `- deps:` lines and sketch the graph mentally.
If you can draw it without cycles, that's an invariant worth stating.

> **Architecture Invariant:** packages depend leaves-first. `config`
> has no intra-workspace deps; `core` depends only on `config`;
> bundler plugins depend on `core` + `transformer` + `config`;
> framework adapters depend only on bundler plugins. A cycle would
> break the published-to-npm topology.

## 4. Production safety / dev-only by design

> Is some piece of code intentionally inert outside `NODE_ENV=development`
> (or some equivalent gate)?

This is high-signal because users will inevitably ask "what's the
runtime cost in production?" and you can answer by pointing at this
invariant.

> **Architecture Invariant:** every adapter defaults to skipping the
> transform and runtime injection in production builds. Shipped
> artefacts pay zero bytes for vibe-pigeon.

## 5. Graceful degradation

> When an external system the code depends on (network, IDE, system
> clipboard, daemon) is missing or fails, does the code keep working
> in a reduced mode rather than throwing?

Look for `try/catch` blocks at boundaries and write the policy down.

> **Architecture Invariant:** the dispatcher always writes to the
> clipboard, even when another channel is selected, so the user can
> paste into any surface as a last resort if Cursor / the daemon are
> unavailable.

## 6. Stability of an external contract

> Does this package emit something — data attributes, a URL scheme,
> an HTTP wire format — that other packages or third-party tools
> depend on?

If yes, it's an API Boundary. State the contract precisely.

> **Architecture Invariant:** the four `data-vp-*` attribute names
> (`file`, `start-line`, `end-line`, `name`) are part of the public
> contract between `transformer` and `core`. Renaming requires a
> major version bump of both packages.

## 7. Avoidance of a tempting general solution

> Did the code reject a more general / more powerful approach in
> favour of something narrower? Why?

This is the most underweighted category — and the most useful for
future maintainers, who will otherwise re-propose the rejected
approach.

> **Architecture Invariant:** the prompt template engine is a single
> textual `{varName}` substitution pass. We deliberately do not adopt
> Handlebars / EJS / Mustache — users put templates in their config,
> and we don't want arbitrary code execution there.

## 8. Hard performance / size budgets

> Is there a number that the code is structured around — bundle size,
> latency, max URL length, max concurrent connections — that would
> require redesign if exceeded?

> **Architecture Invariant:** the runtime client must stay under
> 20 KB minified. The overlay UI uses Shadow DOM and inline styles
> rather than a CSS framework specifically to hold this budget.

> **Architecture Invariant:** Cursor deeplinks have an 8000-character
> URL limit. The dispatcher truncates prompts before this limit and
> warns the user via the overlay's toast.

## 9. Isolation / sandboxing of the runtime from the host page

> Does the runtime take pains to not pollute or leak into the host
> application?

> **Architecture Invariant:** all overlay UI lives inside a Shadow
> DOM root. We do not register a single global stylesheet, attach a
> single property to `window`, or modify a single host DOM node
> outside our overlay container.

## 10. Determinism / reproducibility of the build

> Is some part of the build deliberately deterministic given the same
> input?

> **Architecture Invariant:** the JSX transformer's output is a pure
> function of (source text, file path). It does not read the
> environment, the filesystem, or the network, so build caches are
> safe to share between machines.

---

## Authoring Checklist

For every module section in the Code Map, write down at least one
invariant from the list above. If you cannot, that is a signal that
either:

- the module has no design constraints worth documenting (rare — see
  if you really need a section for it), or
- you do not yet understand the design (more reading required).

Three or more invariants in a single section is fine and often
correct for the architecturally critical packages (transformer,
dispatcher, daemon, etc.).
