# Shared Architecture Contracts

## Purpose

This file defines the conceptual interfaces all agents share and records the
implemented trust boundary without pretending it covers arbitrary Agent tools.
The Orchestrator owns changes to these contracts; specialists propose
amendments before introducing incompatible types, tables, routes, or decision
semantics.

## Current architecture snapshot

```text
React/Vite UI
  -> Fastify API (`apps/server/src/app.ts`)
  -> AgentService (`launchpad.json`: Agents, Messages, Runs)
     -> pre-run RunPolicyGate -> PolicyService
     -> AgentRunner -> Codex process or disposable runtime container
     -> for named managed Resources: read-only ModelActionMediator
        -> validated bounded proposal -> ResourceGateway
  -> ControlledActionRuntime -> ResourceGateway
     -> ExecutionIdentityService / DelegationService
     -> PolicyService
        -> exact capability + owner/RBAC authorization
        -> downstream graph query + trusted-history risk
        -> persistent circuit breaker + one-time execution claim
     -> SqliteManagedResourceAdapter -> durable managed resource state

Policy / graph / security / timeline services
  -> SQLite stores (`middleware.db`: graph, observations, decisions,
     approvals, claims, Run events, principals, delegations, baselines,
     breakers, and managed resource state)
```

The coarse gate runs before the whole Codex Run. When a prompt names a managed
Resource, `ModelActionMediator` narrows that Codex turn to read-only planning,
requires one bounded capability/Resource proposal, validates it against the
current managed catalog, and sends it through the stronger action-level path.
Protected managed-action APIs use the same gateway directly. A real SQLite
read/write occurs only after the exact decision has been audited and atomically
claimed. At effect time the SQLite boundary rechecks that claim, the current
principal, exact capability and ownership, full delegation chain, correlated
risk, payload, and breaker in the same transaction as the managed read/write,
then stores an idempotent receipt. It is deliberately narrow: normal Codex
tool/file/shell/connector/network behavior outside that planning mode still
bypasses it. New runtime claims must identify the exact adapter and prove that
its effect can be reached only through this boundary.

## Contract ownership

| Contract/surface | Primary owner | Producers | Consumers |
| --- | --- | --- | --- |
| Identity and effective principal context | Graph Security Runtime | API authentication, delegation resolver, system services | authorization, risk, gateway, events, UX |
| Agent and Run lifecycle | Existing `AgentService`; contract changes coordinated by Orchestrator | Fastify/API and AgentService | runner, policy, timeline, UI |
| RunEvent schema/store/query | Run Timeline | lifecycle, gateway, policy, delegation, breaker, runner observations | audit API/UI, baseline, integration |
| GraphNode/GraphEdge and graph services | Graph Security Runtime, preserving existing graph store | provisioning, configuration, trusted observations, runtime audit | policy, reverse queries, explanations, UI |
| AuthorizationDecision | Graph Security Runtime | RBAC/explicit capability evaluator | risk pipeline, gateway, events, UI |
| Risk/CircuitBreakerDecision | Graph Security Runtime | graph, baseline, breaker evaluator | gateway, events, approvals, UX |
| BehavioralBaseline | Graph Security Runtime | trusted RunEvent aggregates | future risk evaluations, explanations |
| Dependency manifests/lockfile | Dependency Security | npm/build tooling | all builds and deployments |
| End-to-end evidence | Integration | black-box/system tests | Orchestrator and Critic |

The UI consumes projections. It does not own authorization, graph traversal,
behavioral aggregation, breaker state, or event ordering.

## Identity

Identity is attributable execution context, not a display label.

Required information:

- stable `principalId` and kind: `human`, `agent`, `delegated_agent`, or
  `system`;
- authenticated human/origin principal when one exists;
- current Agent ID and graph node ID;
- Run ID;
- delegation ID, parent Agent, and delegation chain when delegated;
- requested and effective capability context;
- authentication/attestation source sufficient for server-side trust.

The API/authentication layer produces the origin principal; the delegation
resolver derives the effective Agent context. Callers must not choose their own
trusted human identity in request bodies. Missing or inconsistent identity
fails closed for protected actions.

Current implementation boundary: one principal is configured at process start
and is bound to protected Runs. A shared bearer token authenticates access to
the demo application; it does not establish distinct Alice/Bob sessions. The
two named humans in the demo graph are deterministic ownership fixtures, and
caller-supplied user headers/body fields cannot replace the configured
principal. Do not describe this as production identity, tenancy, or reviewer
separation of duty.

## Agent

The existing `Agent` in `apps/server/src/types.ts` remains the lifecycle entity
with stable UUID, instructions, status, workspace, and Codex thread. Its graph
identity is `agent:{Agent UUID}`. An Agent node does not imply permission.

The Agent service produces lifecycle state; graph provisioning maintains the
corresponding node. Delegation does not clone or mutate the Agent's declared
capabilities; it creates a separate effective execution context.

## Run

The existing `AgentRun` remains the user-visible execution aggregate and owns:

- stable Run ID and Agent ID;
- status and lifecycle timestamps;
- prompt/final output/error/usage;
- policy summary/projection;
- originating identity and parent/delegation context when introduced.

`AgentService` produces Runs. Policy, runner, timeline, API, and UI consume
them. Runs currently live in `launchpad.json`; agents must not assume a SQLite
foreign key until Runs are migrated. New SQLite security records must validate
the weak Run reference at the service boundary in the interim.

## RunEvent

`RunEvent` is an immutable, structured fact. Minimum conceptual fields:

- stable event ID, schema version, Run ID, and strictly increasing Run-local
  sequence;
- typed event name and wall-clock occurrence time;
- actor identity/effective principal context and Agent ID;
- optional delegation/parent/causation/correlation references;
- optional normalized action (`capability`, operation/tool name) and Resource;
- optional authorization/risk/breaker decision references and stable reason;
- outcome plus bounded, sanitized metadata safe for persistence and display.

Run Timeline owns persistence and sequence allocation. Lifecycle, policy,
gateway, delegation, breaker, and runner components produce events at the point
of truth. Consumers always order by sequence; timestamps never resolve ties.
Events are append-only. Corrections are new events, not mutation of history.

## Resource

A Resource is the normalized target of an action, represented by a stable graph
`asset` node and an adapter-resolvable identifier. Required information:

- stable node/resource ID and kind (for example file, configuration, service,
  dataset, API, credential handle);
- classification, sensitivity/risk facts, and environment/namespace needed to
  avoid accidental label merging;
- supported capability/action types;
- the authoritative adapter/broker that owns the actual effect.

No secret value belongs in graph metadata, decision evidence, events, or API
responses. A label match alone is not stable resource identity.

## GraphNode and GraphEdge

`apps/server/src/graph-types.ts` is the current canonical code contract.
Existing node types are `human`, `agent`, `asset`, `data_category`, and `run`.
Existing relations separate explicit authority (`CAN_*`), topology
(`DEPLOYS_TO`, `PROCESSES`, `CONTAINS`), accountability (`OWNS`), and audit
evidence (`ATTEMPTED`, `TOUCHED`, `DENIED`).

Any new delegation/runtime relation requires coordinated updates to TypeScript
unions, validation, immutable migration, all store adapters, traversal rules,
tests, API DTOs, and UI projections. Authority rules:

- only explicit, authorized direct capability plus effective delegation/RBAC
  context can authorize an action;
- topology, reverse reachability, audit edges, observations, past success, and
  ownership provide context but never authority;
- traversals are deterministic, bounded, cycle-safe, and return paths/factors;
- reverse queries are service-layer methods callable by policy, not client-only
  graph transforms.

## Delegation

Delegation is a durable, revocable relationship for one origin/Run and bounded
scope. Required information:

- delegation ID, origin human, origin Run;
- parent Agent/effective principal and child Agent;
- requested scope and computed effective capabilities/resources;
- parent delegation ID/depth where nested;
- status, creation, expiry/revocation, and reason/evidence.

The delegation service produces it; identity resolution, authorization, graph,
events, baseline, and UX consume it. Effective child authority is the
intersection of origin authority, parent effective scope, explicit delegated
scope, and child capability. Delegation never creates authority outside that
intersection.

## AuthorizationDecision

Authorization is the baseline permission result for one resolved identity,
exact capability/action, Resource, and Run. Required information:

- decision ID, Run, actor/effective principal, action/capability, target;
- `ALLOW` or `DENY`, stable reason code, matched authority/delegation evidence,
  policy version, and creation time.

RBAC/capability policy produces this decision. The risk evaluator, gateway,
events, and UX consume it. A DENY ends the pipeline before graph/baseline risk
can grant anything. An ALLOW permits risk evaluation; it is not an instruction
to execute.

`PolicyDecisionRecord` remains the outward compatibility summary. The
integrated path persists linked `AuthorizationDecision` and `RiskDecision`
records, emits separate timeline facts, and exposes their evidence without
creating a second uncorrelated policy engine.

## RiskDecision and CircuitBreakerDecision

Risk evaluates an already-authorized action using graph context, trusted
behavioral history, sensitive-resource rules, and current breaker state.
Required information:

- decision ID and linked AuthorizationDecision;
- `ALLOW`, `WARN`, or `BLOCK`;
- graph revision, baseline revision/history window, breaker state/version;
- deterministic factors with expected/observed values, contribution/threshold,
  relevant paths/resources/Runs, reason code, and plain-English explanation;
- whether execution may proceed, requires approval/pause, or is prohibited.

Compatibility mapping for the existing outward policy vocabulary is:
`ALLOW -> ALLOW`, `REVIEW_REQUIRED -> WARN` (paused until explicitly approved),
and `DENY -> BLOCK`. Do not collapse the distinct underlying decisions merely
to preserve these labels.

The circuit breaker is persisted state scoped explicitly to an Agent,
delegation, Resource, or other documented boundary. Its `NORMAL`, `WARN`, and
`TRIPPED` transitions are atomic and produce Run events. `TRIPPED` prohibits
the covered effect until a defined recovery/reset condition succeeds.

## BehavioralBaseline

A baseline is a versioned aggregate of trusted prior mediated behavior, never a
static permission/configuration record. Required information:

- baseline ID/revision, Agent/effective scope, calculation time/window;
- eligible source Run IDs and inclusion/exclusion policy;
- minimum-history/cold-start state;
- small deterministic statistics such as normal resources/actions, typical
  resource count/blast radius, typical delegation depth, and denial history;
- poisoning controls, bounds, and update reason.

The baseline builder consumes ordered RunEvents from eligible completed,
safe/accepted Runs. The risk evaluator consumes the frozen revision used for a
decision. Denied/blocked/failed/quarantined attempts can remain negative risk
evidence but cannot add their resources/actions to the trusted-normal set.
The current implementation aggregates only the latest 20 completed Runs,
selected by completion time and Run ID, and persists that window's limit,
count, start/end timestamps, and eligible source IDs. Changing this hard bound
requires an explicit architecture/test update; an unbounded scan is forbidden.

## Required runtime ordering

```text
Run / Agent action request
  -> resolve identity and delegation context
  -> baseline authorization (RBAC + exact capability)
  -> query graph/reverse impact and blast radius
  -> load frozen historical baseline and compare behavior
  -> evaluate risk and persisted circuit-breaker state
  -> persist decision and ordered event
  -> if ALLOW (or approved WARN), atomically claim execution
  -> execute exactly once through the authoritative ResourceAdapter
  -> persist completion/failure event and eligible baseline evidence

Any DENY, BLOCK, unapproved WARN, TRIPPED breaker, or required-context failure
returns before ResourceAdapter execution.
```

The adapter must not be callable through an unmediated alternate route. Post-
effect event parsing may enrich observation but cannot satisfy this ordering.

For the current POC, this invariant has been proven only for resources marked
for `SqliteManagedResourceAdapter`. The adapter is constructed server-side and
is reachable by `ControlledActionRuntime` only through `ResourceGateway`.
`DemoResourceAdapter` remains test/legacy scaffolding and is not evidence of a
real effect. Ordinary Codex actions are outside this protected action boundary.

The ordered event stream supports audit reconstruction: execution order,
origin and acting Agent, authorization and risk decisions, resources,
delegation, breaker transitions, failures, and final outcome. It does not
capture enough external state to promise deterministic replay or re-execution.
An external effect adapter requires a transactional outbox/idempotent
reconciliation design before equivalent post-effect recovery can be claimed.

## Consistency and API rules

- Security state belongs in `middleware.db` with immutable migrations and
  atomic operations. Do not create a new JSON security store.
- Define transaction boundaries for sequence allocation, decision persistence,
  breaker transition, execution claims, and recovery from adapter/persistence
  failures. Idempotency keys must not authorize a different request.
- Keep stable reason codes machine-readable and explanations user-readable.
- API routes return server-computed identity, graph, baseline, and decision
  evidence; callers do not submit trusted scores, roles, paths, or identity.
- Avoid duplicating domain interfaces independently in server and web. Prefer a
  shared/exported DTO boundary or add contract tests that prevent drift.
- Preserve current graph caps, secret validation, one-time claims, approval
  binding to request/graph revision, and fail-closed policy behavior unless the
  Orchestrator approves a tested replacement.
