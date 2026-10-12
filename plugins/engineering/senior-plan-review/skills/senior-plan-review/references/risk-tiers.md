# Risk tiers: borderline cases and escalation

Classify by the single most dangerous action in the plan. Read this when the table in
SKILL.md does not settle the question.

## Schema and data

| Change | Tier | Why |
| --- | --- | --- |
| Add nullable column, no default, no backfill | MEDIUM | Metadata-only in Postgres/MySQL 8; reversible |
| Add column with default / NOT NULL on a large table | HIGH | Rewrite or long lock on older engines; check table size and lock behaviour in the repo's runbooks |
| New table, new index (`CONCURRENTLY` where supported) | MEDIUM | Additive; index build on a large table is an operational event, mention it |
| Rename / split / change type of an existing column | HIGH | Needs expand-migrate-contract across deploys; old code must keep working during rollout |
| Drop column or table that still has data | CRITICAL if production data would be lost without a verified backup; otherwise HIGH | Irreversible |
| Backfill with batching, idempotent, resumable | HIGH | Long-running, load-sensitive |
| Backfill as one `UPDATE` on millions of rows | HIGH, recommend REVISE | Lock duration, replication lag, bloat |
| Hard delete of rows with legal/financial retention | CRITICAL | Not undoable past the PITR window |

Rollout questions that usually belong in *Decisions* or *Risks*: does the migration run before
or after the app deploy? Does the previous version keep working against the new schema? Is
there a tested down migration, and does it restore data or only structure?

## Concurrency and consistency

- An in-process lock, mutex, cache or counter is only correct for a single instance. If the repo
  deploys more than one replica (compose `replicas`, k8s `replicas`, load balancer upstreams),
  the plan needs a database or distributed primitive: row locks, conditional updates that
  encode the invariant in the `WHERE` clause, unique constraints, advisory locks, or an
  external store. Tier HIGH; a plan that uses the in-process version anyway is REVISE.
- Check-then-act without a constraint ("query first, insert if absent") is a race.
  Idempotency needs a unique constraint plus an upsert/ignore clause or an equivalent atomic
  primitive.
- Two writes that must both happen belong in one transaction or need a reconciliation path.
  Separate auto-commit statements are a failure mode to name.
- Retries from external systems (callbacks, queues, clients) make every handler a candidate for
  duplicate delivery. Ask whether the plan handles redelivery.

## Auth, security, secrets

- Any change to token issuance, verification, session lifetime, role checks, CORS, CSRF, or
  rate limiting: HIGH.
- Refresh/long-lived tokens: look for rotation, revocation on logout/password change, storage
  location (httpOnly cookie vs web storage), and whether the same secret signs both token types.
- Rate limiting and lockout: in-memory counters do not work across replicas; account lockout
  without a per-IP or CAPTCHA component is a denial-of-service vector.
- Building SQL/shell/HTML from user input by concatenation inside a "simple" feature escalates
  the whole plan to HIGH, with REVISE.
- Secret rotation, printing or moving secrets, changing where secrets are read from: CRITICAL.
  Expect a dual-key / grace window plan and a statement of what breaks when the old key dies.

## Dependencies and infrastructure

- New library in the hot path or with native/install scripts: MEDIUM, with a note on
  maintenance and supply chain; use a dependency-evaluation skill if one is installed.
- New runtime component (Redis, queue broker, search engine, another database): HIGH. The
  decision is operational ownership, not code. Always present the "use what we already run"
  alternative (e.g. a Postgres-backed queue) with its real trade-offs.
- Removing or swapping a dependency used by many modules: HIGH when behaviour differs.

## Destructive and production operations

CRITICAL, always, regardless of diff size:

- Running maintenance/purge scripts, ad-hoc SQL, or migrations directly against production
- Deleting or truncating data, dropping objects, rewriting history (`push --force`), rotating
  keys, disabling security controls "temporarily"

The brief must name the exact command/statement, the environment it targets, how many rows or
objects are affected, what backup exists and has been verified, and what the undo is. If the
plan cannot answer those, recommend REVISE and list them under *Decisions* as prerequisites
rather than approving with caveats.

## Escalation during execution

Move the tier up and set `REAPPROVAL_REQUIRED` when, mid-task, the agent discovers that:

- a "quick fix" needs a schema or auth change
- the deployment has more instances or more traffic than assumed
- a referenced helper/table does not exist and the replacement is non-trivial
- a new third-party component or dependency becomes necessary
- the change touches data with retention or compliance meaning

Report what was approved, what changed, and the new tier; do not fold the extra work into the
original approval.
