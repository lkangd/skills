# Review examples

Two briefs at the expected density. Domains are deliberately unlike any particular repo; copy
the shape, not the content.

## Example 1: LOW

Task: "Show the account's plan name next to the avatar in the mobile app header."

```
Recommendation: APPROVE — proceed. Risk: LOW (presentation-only, data already loaded).
Intent: show the plan name in the header so support can read it from screenshots.
Issue: the plan reads `account.plan.displayName` from the header view model (verified in
`HeaderViewModel.swift`); the nil case for accounts without a plan is not mentioned — render
nothing rather than "undefined".
Validation: snapshot test with a long plan name and with nil; existing header tests pass.
Plan status: REVIEWED
```

Six lines, under 90 words. Absent on purpose: alternatives, impact, decisions, rollback,
approval ceremony. The one real issue (nil case) is stated with its fix; the agent decides it,
it does not ask.

## Example 2: HIGH

Task: "Move session storage from the database to Redis so logins stop timing out under load."

```
## Recommendation
APPROVE WITH CHANGES. Risk tier: HIGH (new stateful infrastructure in the auth path).
Required changes before execution: (1) decide session TTL semantics, (2) add a Postgres
fallback or a documented outage behaviour, (3) dual-write period instead of cutover.
Plan status: REVISION_REQUIRED

## Intent
p95 login latency is 2.4s because `sessions` lookups contend with reporting queries on the
same primary (verified: `pg_stat_statements` export in `docs/perf/2026-08.txt`). Goal: login
p95 < 300ms without changing login semantics.

## Approach
Introduce a Redis cluster, write sessions to Redis on login, read from Redis in the auth
middleware, fall back to Postgres on miss during a two-week dual-write window, then remove the
Postgres path. Session IDs and cookie format stay the same.

## Alternatives
- Read replica for reporting + index on `sessions(id, expires_at)`: removes the contention
  without new infrastructure. Not chosen by the plan; the plan assumes (unverified) that the
  replica lag is unacceptable for reports. Worth a day of measurement before committing to
  Redis.
- Keep Postgres, add an in-process LRU cache: wrong across 6 replicas; stale sessions survive
  logout. Rejected.

## Risks
1. Redis unavailable → every request 500s. Plan has no fallback after the dual-write window.
   Mitigation needed: define degraded behaviour (fail closed to login, or Postgres fallback).
2. Logout/revocation semantics: plan deletes from Redis only; during dual-write the Postgres
   row remains valid → revoked session still works on fallback. Mitigation: delete both.
3. TTL drift: Postgres uses absolute `expires_at`; Redis plan uses sliding `EXPIRE`. Behaviour
   change for users; needs a decision.
4. Operational ownership: nobody on the team runs Redis today (inferred from the absence of
   any Redis config or runbook).

## Impact
`auth/middleware.go`, `auth/session_store.go`, deploy manifests, secrets (Redis URL), the
on-call runbook. No API or cookie change for clients.

## Validation
Integration test with Redis container covering login, refresh, logout, expiry; load test
reproducing the 2.4s scenario; dashboards for Redis hit rate and fallback rate before cutover;
rollback = flip `SESSION_STORE=postgres` env var (plan includes the flag, verified in the plan,
not yet in code).

## Decisions
1. Sliding vs absolute session expiry (risk 3). My pick: keep absolute.
2. Accept Redis as a new on-call responsibility vs try the replica/index approach first.
   My pick: measure the alternative for one day first; if it misses the target, approve Redis.

## Next
Redraft with changes 1–3 and the replica/index measurement, or approve Redis now? (reply
"redraft" or "approve redis")
```

About 480 words. Recommendation first, because that is what the reader acts on. Each risk
states the concrete failure and what the plan does about it, once. Decisions are only the two
the engineer must own and point back at the risk numbers; everything else (client library,
key naming, test layout) the agent resolves itself. The brief ends with the one question the
reader has to answer.
