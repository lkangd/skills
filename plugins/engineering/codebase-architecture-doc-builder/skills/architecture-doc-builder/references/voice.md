# Voice & Style Guide

Architecture docs in this style are written for the engineer who is
about to open the codebase for the first time. They are not marketing,
not API reference, not changelog. Adopt the tone of a senior engineer
explaining the code to a new teammate at a whiteboard.

## Tone Rules

1. **Plain English over jargon.** If a term has a precise local meaning
   in this codebase (e.g. "dispatcher", "transformer"), introduce it
   once in italics and then use it freely. Otherwise prefer ordinary
   words.
2. **Active voice, present tense.** "The transformer parses the file"
   not "The file is parsed by the transformer" and not "will be
   parsed".
3. **State facts, not aspirations.** Describe what the code _does_,
   not what it _should_ or _will_ do. If a behaviour is aspirational,
   move it to the PRD or to a TODO comment in the code itself.
4. **No marketing.** Strike: "blazing fast", "industry-leading",
   "elegant", "beautiful", "robust", "powerful", "seamless".
5. **Quantify when free.** "~14 KB ESM module", "8000-character URL
   limit", "five built-in templates" all carry signal that "small",
   "limited", "several" do not.
6. **Concrete file references.** Every non-trivial assertion links to
   a real file path. Aim for at least one link per paragraph in the
   Code Map.

## Voice Patterns That Work

### Open the doc with a top-down funnel

The first three sentences should answer:

1. _What is this system?_ (one sentence)
2. _Who is this document for?_ ("if you are about to dive into the
   code base, this is the right place to start")
3. _What is **not** in this document?_ (point at PRD / README for
   product context)

### Open each module with a single-sentence role

> The shared types, defaults, and template engine. Every other
> package depends on it transitively.

The reader should know within one sentence whether this section is
relevant to their current task.

### Lead bullets with file links

Good:

> - [`schema.ts`](packages/config/src/schema.ts) defines the
>   `VibePigeonConfig` zod schema.

Bad:

> - There is a file called `schema.ts` which defines a zod schema for
>   configuration. It is located at `packages/config/src/schema.ts`.

### Architecture Invariant call-outs

Use bold inline labels, not custom syntax:

> **Architecture Invariant:** the prompt template engine is a single
> textual substitution pass. We deliberately do not adopt a templating
> language (Handlebars, EJS, …) — the surface area of `{varName}`
> substitution is simple, predictable, and trivially auditable for
> users who don't want arbitrary code in their config.

Notice the structure:

1. State the invariant in one sentence.
2. Name the rejected alternative(s) in parentheses.
3. Give the _reason_ the invariant is held.

The reason is the most important sentence in the entire document. It
is what stops a future contributor from "fixing" something that was
intentional.

### API Boundary call-outs

Use the same bold-label pattern, only for packages that are contracts
to external consumers:

> `@vibe-pigeon/config` is an **API Boundary**. Any future consumers
> (a UI config editor, a CLI scaffolder, a different runtime) must be
> able to use it in isolation.

Do NOT slap "API Boundary" on every package. If everything is an API
boundary, nothing is.

## Anti-Patterns to Avoid

| Anti-pattern | Why it's bad | Replace with |
| --- | --- | --- |
| "This module handles..." | Vague verb; doesn't say what's actually done. | "This module parses... / serialises... / dispatches..." |
| Listing every export | Reads like JSDoc; not architecture. | Describe the role, link the file, let the reader read code. |
| Tutorials and "how to use" | That's the README. | Hard-link to README, move on. |
| Future plans, roadmaps | Doc rots immediately. | Put plans in issues / RFCs. |
| Diagrams of class hierarchies | Captures structure but not _intent_. | Dataflow diagrams ("user holds Opt → Hotkey → Locator → Overlay"). |
| One giant ASCII diagram covering everything | Unreadable. | Two diagrams (build-time / runtime), or a short diagram + prose. |

## Length Targets

- Whole document: 300-600 lines for a 5-15 module monorepo. Larger
  monorepos: split into `ARCHITECTURE.md` + per-area docs in `docs/`,
  cross-link.
- Bird's Eye View: 30-80 lines including the diagram.
- Each module entry: 15-40 lines.
- Cross-Cutting Concerns: 60-150 lines total.

If a section grows past these, ask whether you are restating the code
rather than describing the design.
