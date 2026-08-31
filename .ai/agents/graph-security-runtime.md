# Graph Security Runtime Specialist

## Ownership

Own Task 6 as one integrated runtime security system:

- attributable identity;
- baseline RBAC authorization;
- reusable reverse graph queries;
- secure Agent delegation;
- explainable historical behavioral baseline;
- persistent circuit breaker and pre-side-effect enforcement.

These concerns share actor, Run, action, resource, decision, graph, and event
contracts. Do not implement them as disconnected demos or duplicate services.

## Existing foundation and boundary

Preserve the tested foundations in `graph-types.ts`, `KnowledgeGraphService`,
`PolicyService`, SQLite graph/governance stores, `RunPolicyGate`, and
`ResourceGateway`. Direct authorized `CAN_*` edges are authority; topology,
observations, ownership, and history never grant capability.

The pre-run gate can prevent the entire Codex runtime from starting. The exact
action gateway can prevent its adapter from running, but Codex does not call it
and the current adapter is simulated. Therefore this task is not complete until
at least one narrow, real, controlled Agent action can only reach its effect
through the gateway/policy pipeline. Do not present stdout parsing or a UI
warning as interception.

## Canonical action pipeline

```text
Agent action request
  -> resolve authenticated/origin/delegated identity
  -> baseline RBAC authorization
  -> backend graph and reverse/blast-radius context
  -> trusted historical-behavior comparison
  -> persistent risk/circuit-breaker decision
  -> persist ordered decision/action event
  -> ALLOW or approved WARN: execute through the sole adapter boundary
     BLOCK or tripped breaker: return before the side effect
  -> persist completion/failure and update eligible baseline evidence
```

Anything that can block must run before the effect. Required decision or event
persistence failure must fail closed.

## Identity and RBAC

- Support human, Agent, delegated/sub-Agent, and system/service identities.
- Be able to answer: who attempted what against which resource during which
  Run, on whose authority, through which delegation chain?
- Treat the shared bearer token as application authentication only; replace or
  layer it with verified principal context. Never trust body-supplied identity.
- Make requester/approver attribution explicit and enforce any required
  separation of duty server-side.
- Produce a distinct authorization decision for the exact subject, action,
  resource, and effective capability. Deny missing/ambiguous identity or
  capability.
- RBAC answers “may this subject perform this class of action?” It does not
  answer whether this permitted action is normal or safe in current graph
  context.

## Reverse graph queries

Build bounded, deterministic service-layer primitives and API access for:

- resources reachable by an Agent;
- Agents that can affect a resource;
- Runs that touched/attempted a resource;
- downstream dependents and action blast radius;
- an explainable path between an Agent and resource;
- delegation-aware impact without treating delegation as authority by itself.

Use persistence-layer incoming/outgoing primitives, cycle/cap protections, and
stable ordering. Policy and breaker code must call these backend services; a
client-side SVG traversal is not acceptance.

## Delegation

Model `User -> Agent A -> Agent B -> Resource` with a durable delegation record
and graph/timeline representation. Preserve origin user/Run, parent and child
identities, requested scope, effective capability, depth, creation/revocation,
and parent linkage.

Effective child capability must be no broader than the intersection of the
originating authority, parent Agent's effective capability, explicit delegated
scope, and child Agent's own allowed capability. Deny by default on ambiguity,
revocation, excessive depth, or attempted expansion. Delegation changes who is
acting; it does not mint a new `CAN_*` permission.

## Behavioral baseline

Keep three layers explicit:

1. Declared capability: explicit authority such as `CAN_WRITE`.
2. Observed behavior: structured facts from actual mediated actions and Run
   events.
3. Historical baseline: versioned aggregate of eligible prior Runs used to
   compare a future action.

Choose a small number of deterministic signals that the end-to-end demo can
prove, preferably resource novelty, typical resource/blast-radius range, and
delegation depth or repeated denials. Record the expected value, observed
value, contribution, threshold, baseline revision, and evidence Runs.

Update trusted normal patterns only from explicitly eligible safe/successful or
accepted Runs. Denied, blocked, failed, quarantined, or unconfirmed prompt-only
behavior may increase risk evidence but must not normalize a dangerous resource
or action. Add minimum-history/cold-start behavior and protect updates with
bounded inputs, atomic persistence, and Agent/resource scoping.

## Circuit breaker

Use persisted, atomic states `NORMAL`, `WARN`, and `TRIPPED` unless the shared
contract is explicitly amended. Define deterministic transitions, scope,
reason, threshold, evidence window, cooldown/reset/approval behavior, and
concurrency semantics.

- `NORMAL`: action may proceed after authorization and risk checks.
- `WARN`: action is technically authorized but unusual or far-reaching; it
  must create evidence and follow the explicit approval/pause policy.
- `TRIPPED`: reject new protected actions and prevent their adapter effects;
  cancel a running scope only when that behavior is explicitly safe/tested.

Every transition and decision must be explainable, persisted, and present in
the Run timeline. Do not rename timeouts, output caps, manual stop, or a status
badge as a circuit breaker.

## Required proof

At minimum prove one case where exact RBAC allows the action, but historical
novelty and reverse graph blast radius raise `WARN` or `BLOCK`; a threshold
crossing trips the breaker; the real adapter/sentinel shows no side effect; the
timeline records ordered evidence; a prior trusted Run changes the later
decision context; and the UI explains the result in plain English.

Also prove child privilege intersection, baseline-poisoning resistance,
reverse-query backend use, restart persistence, idempotency/concurrency, and
fail-closed error paths. Coordinate shared events with Run Timeline and route
full-system proof through Integration and Critic.
