# Acceptance Criteria for Tasks 2, 4, and 6

All required criteria are release gates. A specialist handoff is not acceptance;
Integration must reproduce the evidence and Critic must fail to disprove it.

## Task 2: Dependency security

### T2.1 Complete inventory and baseline

- Audit the root npm workspace manifests and root lockfile in both production
  and full scopes.
- Inspect dependency paths for every material advisory and the production tree
  produced by the Docker build/prune path.
- Inspect relevant pinned container/tool/provider versions rather than limiting
  the review to direct npm dependencies.
- Evidence: recorded tool versions, commands, advisory IDs/severity, dependency
  paths, reachability/exploitability assessment, and before-state output.

### T2.2 Safe material remediation

- Fix all safely remediable production high/critical findings and materially
  improve the relevant audit exposure without arbitrary forced or breaking
  upgrades.
- Manifest changes and root `package-lock.json` are consistent; a clean
  `npm ci` resolves the intended versions.
- Remaining findings include specific exploitability, compensating controls,
  reason no safe fix was applied, and owned follow-up—not a generic waiver.
- Evidence: before/after table and `npm explain`/equivalent paths.

### T2.3 No application/security regression

- `npm run check` passes without weakened tests.
- Authentication/encoded-path, graph isolation, policy, gateway, SQLite, and
  runner suites remain green.
- Relevant production Docker build and health/smoke checks pass when available;
  unavailable tooling is explicitly reported.
- Application startup and existing API contracts are not broken by upgrades.

## Task 4: Ordered persistent Run timeline

### T4.1 Durable structured model

- A canonical structured `RunEvent` contract is persisted in
  `middleware.db` through an immutable migration.
- Events include Run ID, stable event ID/schema version, actor/Agent identity,
  type, wall-clock time, bounded metadata, and action/resource/decision/
  delegation context when applicable.
- Secrets and unsafe payloads are rejected or redacted before persistence.
- Evidence: schema/adapter tests and persisted rows, not Fastify logs or strings
  embedded in `AgentRun.output`.

### T4.2 Deterministic ordering

- Every committed event in a Run has a unique, strictly increasing Run-local
  sequence allocated atomically.
- Concurrent append tests prove there are no duplicate sequences and API/store
  results are ordered by sequence even when timestamps are identical or out of
  order.
- UI/API consumers do not use timestamps as the primary ordering key.

### T4.3 Meaningful lifecycle coverage

- The timeline distinguishes at least Run creation/start/terminal outcome,
  action request/attempt, authorization and risk decision, allowed/warned/
  blocked outcome, adapter completion/failure, approval where used, delegation
  where used, and breaker transitions where used.
- Events are emitted by the component that owns the transition. An action
  attempt, decision, and effect completion are separate facts.
- Existing policy/approval/graph evidence is correlated rather than copied
  into an incompatible second history.

### T4.4 Restart persistence and query

- Create a Run timeline, close all service/database instances, construct new
  instances against the same files, and retrieve the identical events in
  sequence order.
- A backend Run-events query/API returns the ordered stream with authorization
  appropriate to the Run.
- Process-memory survival or page state is not accepted as persistence.

### T4.5 Understandable UX

- A user-facing timeline survives page refresh and expresses the actor, action,
  resource, decision, reason, and whether the effect happened in plain English.
- Raw JSON is optional detail, not the primary explanation.
- A real browser/system test covers at least one allow and one block/failure
  explanation, or an explicit environment limitation is reported while API and
  projection tests remain required.

## Task 6: Integrated graph security runtime

### T6.1 Attributable identity

- Protected requests resolve a verified human/origin principal and Agent or
  delegated-Agent identity on the server; callers cannot assert trusted actor
  identity in the body.
- Decisions/events answer: who attempted what against which Resource in which
  Run, through what delegation chain?
- Missing, mismatched, or forged identity fails closed before the effect.

### T6.2 RBAC baseline separated from risk

- Exact capability/RBAC produces an explicit ALLOW or DENY before risk logic.
- Tests prove unauthorized action is denied and cannot be made allowed by graph
  reachability, history, ownership, observation, or delegation.
- Decision evidence and UX distinguish authorization from graph/behavior risk.

### T6.3 RBAC ALLOW but middleware WARN/BLOCK

- Establish broad legitimate permission for an exact action.
- Establish trusted prior Runs showing a narrower normal pattern.
- Attempt a technically permitted but novel action whose backend graph query
  reveals larger/sensitive downstream impact.
- Assert authorization is `ALLOW` while risk is `WARN` or `BLOCK`, with
  deterministic novelty and graph-path factors. This must not rely on a changed
  RBAC rule.

### T6.4 Previous Runs materially affect a future decision

- Compare decisions for equivalent declared permission and graph context with
  different eligible history, or before/after trusted history is established.
- The later decision records a baseline revision and source Runs and has a
  demonstrably different context, factor, or result because of that history.
- Static seed/config and prompt-derived relationship text alone do not pass.

### T6.5 Baseline poisoning resistance

- Denied, blocked, failed, quarantined, or unconfirmed prompt-only behavior
  cannot add its action/resource to the trusted-normal baseline.
- Repeating a blocked dangerous attempt does not lower its novelty/risk.
- Baseline updates are bounded, scoped, persisted, deterministic, and based on
  documented eligible Run outcomes.

### T6.6 Backend reverse graph queries

- Backend service/API methods answer affected Agents for a Resource, Runs that
  touched/attempted a Resource, downstream dependents/blast radius, reachable
  Resources for an Agent, and an explainable Agent-to-Resource path.
- Results are deterministic, bounded, cycle-safe, and tested for authorization,
  topology, audit, and delegation semantics.
- At least one runtime risk decision records evidence returned by a backend
  reverse/impact query. A frontend-only traversal does not pass.

### T6.7 Secure delegation

- A durable timeline/graph reconstruction shows
  `origin user -> Agent A -> Agent B -> Resource` for one Run.
- Agent B's effective capabilities equal the safe intersection defined in the
  architecture contract and include parent/origin/delegation evidence.
- Tests attempt broader scope, an unauthorized Resource/action, forged parent,
  revoked/expired delegation, and excessive nesting; all are denied before
  adapter effect.

### T6.8 Persistent circuit breaker

- Deterministic signals transition the scoped breaker through documented
  `NORMAL`, `WARN`, and `TRIPPED` states using atomic persistent updates.
- Every decision and transition records state/version, thresholds, evidence
  window, reason code, and plain-English explanation in the Run timeline.
- Restart preserves the tripped state. Concurrent threshold crossings do not
  produce contradictory active states or multiple execution permits.
- Timeouts, output limits, manual stop, or a UI flag alone do not pass.

### T6.9 Real pre-side-effect intervention

- At least one narrow Agent-accessible action reaches a real controlled test
  effect only through the identity -> authorization -> graph -> baseline ->
  breaker -> gateway -> adapter pipeline.
- ALLOW executes exactly once. BLOCK/unapproved WARN/TRIPPED returns before
  adapter execution.
- Test evidence uses an adapter invocation counter and/or durable sentinel and
  proves the blocked effect count/state remains zero/unchanged.
- Direct runner/API alternate routes cannot bypass the boundary for that
  protected action. `DemoResourceAdapter` alone or a response saying “blocked”
  is insufficient.

### T6.10 Explainability and integration

- The decision records identity, exact action/resource, authorization result,
  baseline difference, graph path/blast radius, breaker action, and whether the
  side effect occurred.
- The UI renders a concise plain-English explanation and what-would-have-been-
  affected path without requiring raw JSON.
- The strongest scenario in `demo-scenarios.md` passes through API, backend
  middleware, persistence, real controlled adapter, timeline, reload, and UI.
- `npm run check` and all relevant integration/browser/deployment checks pass
  without test weakening.

## Final release gate

The Orchestrator may mark the execution phase complete only when Task 2, 4, and
6 required criteria have Integration evidence and the Critic returns PASS. Any
unmet required criterion remains FAIL even if the demo happy path looks correct.
