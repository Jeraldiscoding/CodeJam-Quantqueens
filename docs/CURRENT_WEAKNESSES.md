# Current weaknesses and prioritized next work

Updated: 2026-08-31

This document describes the current integrated implementation. Older audit and
session reports remain useful before-state evidence, but should not be used as
the release backlog.

## What is proven now

- Managed resource actions are intercepted before their adapter side effect.
- Server-attested identity, configured Agent/resource ownership, RBAC, exact
  graph capability, reverse impact, trusted historical behavior, and breaker
  state all influence that path.
- A direct permission can return `ALLOW` while behavior and graph context return
  `WARN` or `BLOCK`.
- `BLOCK` leaves the one-time policy claim absent and the durable managed
  resource unchanged.
- Ordered structured Run evidence, baselines, delegation, decisions, and breaker
  state persist in SQLite.
- `GET /api/agents/:id/safety-evidence/latest` reconstructs the latest protected
  proof from persisted source records, including the decision-time baseline,
  graph impact, identity chain, claim status, effect status, and event range.

## Priority 1: expand the protected effect boundary

**Weakness:** ordinary Codex shell, filesystem, connector, and network actions
do not transparently pass through `ResourceGateway`.

**Why it matters:** the current guarantee is deep but deliberately narrow. A
judge must not infer that every arbitrary tool call is intercepted.

**Next implementation:** add a small protected-tool adapter registry for the
highest-value real effects, such as shared configuration writes, deployment
calls, and credential handles. Longer term, enforce the same decision protocol
inside the Codex tool sandbox. Every adapter must remain idempotent, emit the
same Run events, and prove that `BLOCK` means zero invocations.

## Priority 2: real multi-user identity and separation of duty

**Weakness:** one configured demo principal is selected by the application
bearer token. Roles are static and there is no tenant/session model.

**Why it matters:** request identity cannot be forged today, but requester and
reviewer are not independently authenticated people.

**Next implementation:** add OIDC-backed sessions, tenant IDs, reviewer
assignment, requester/approver separation for sensitive actions, CSRF
protection, and endpoint-specific rate limits. Keep RBAC as the broad first
check; do not replace behavioral and graph decisions with more role screens.

## Priority 3: external-effect recovery

**Weakness:** SQLite can atomically protect claims and local state, but it
cannot roll back a remote deployment or SaaS write if a later completion-event
write fails.

**Why it matters:** production adapters cross transaction boundaries.

**Next implementation:** use a transactional outbox, stable operation IDs,
adapter idempotency keys, delivery status, and reconciliation. Timeline
completion should be derived from acknowledged effect delivery, with an
explicit uncertain/recovery state when acknowledgement is unavailable.

## Priority 4: broaden browser regression coverage

**What is proven:** the checked-in Playwright judge flow starts a fresh
production server, proves Alice's read and Bob's backend denial (including a
caller-supplied identity spoof), establishes trusted staging history, blocks
the wider production change, verifies the named impact path and absent effect
claim, reloads the same ordered evidence, and exercises graph focus plus a
keyboard focus indicator.

**Remaining weakness:** approval interaction, full keyboard traversal, and
multiple narrow/mobile layouts are not yet browser-regression scenarios.

**Next implementation:** extend the existing suite with those focused cases;
do not duplicate the already covered judge path.

## Priority 5: consolidate persistence

**Weakness:** Agents, messages, and core Run lifecycle remain in
`launchpad.json`, while middleware evidence is in SQLite. Application-level IDs
correlate them, but SQLite cannot enforce every cross-store reference.

**Next implementation:** migrate Runs and messages into versioned SQLite tables,
then add foreign keys from timeline, delegation, authorization, and risk rows.
Use an incremental import migration and preserve existing local data.

## Lower-priority hardening

- Add freshness, expiry, contradiction handling, and provenance aggregation to
  relationship observations. Pending prompt/reply observations are now
  quarantined from enforcement until a human confirms them.
- Add an approved local container/OS scanner and Terraform/provider scanning.
- Add retention and compaction policies for the long-lived event timeline.
  Adaptive baseline aggregation is bounded to the latest 20 completed Runs,
  but the underlying audit log is intentionally retained in full today.
- Add recency-weighted behavioral distributions only after enough trusted Run
  data exists; keep every signal deterministic and explainable.
- Add concurrent reset-versus-trip stress coverage for multi-process server
  deployment.
- Add localization and explicit timezone presentation to the timeline UI.

## Intentionally out of scope for the hackathon

- Heavyweight ML or opaque anomaly scores.
- General-purpose graph query languages.
- Deterministic replay of arbitrary external side effects.
- Large connector catalogs without one complete protected vertical path.
- More risk signals merely to increase feature count.

For the demo, one deeply proven managed effect remains more credible than broad
claims about unmediated tools.
