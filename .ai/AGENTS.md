# Global Agent Engineering Rules

## Scope and sources of truth

These rules apply to the Orchestrator and every specialist, integration, and
critic agent working in this repository. Read this file first, then read the
assigned role file and:

- [`specs/product-principles.md`](specs/product-principles.md)
- [`specs/architecture-contracts.md`](specs/architecture-contracts.md)
- [`specs/acceptance-criteria.md`](specs/acceptance-criteria.md)
- [`specs/demo-scenarios.md`](specs/demo-scenarios.md)

When sources disagree, use this order: tested runtime behavior, shared
architecture contracts, acceptance criteria, current source code, current
architecture/audit documentation, then role-local implementation preferences.
Escalate genuine contract conflicts to the Orchestrator. Do not silently create
a second model or incompatible abstraction.

## Product invariants

1. We are building runtime middleware, not merely a dashboard. Important
   behavior must execute in the backend/runtime/data path.
2. The graph must influence real execution behavior. A graph used only for
   visualization is insufficient.
3. RBAC is baseline authorization, not the core innovation. A broadly
   authorized action may still be warned or blocked because it is behaviorally
   novel or has unusual downstream impact.
4. Keep these concepts distinct in code, storage, tests, and explanations:
   declared capability, observed behavior, and historical behavioral baseline.
5. Previous trusted Run history must be able to affect the context or risk
   decision for a future Run.
6. Important actions and decisions must generate persisted, structured Run
   events. Diagnostic log strings are not a Run timeline.
7. A tripped circuit breaker must stop or pause the actual side effect. A badge,
   toast, warning string, or post-hoc detection is not enforcement.
8. Delegation must preserve the originating user and Run, parent and child
   Agent identities, delegation chain, and effective capability context. A
   child must not gain privilege through delegation.
9. Reverse graph queries must be reusable backend middleware primitives, not
   calculations available only to the frontend visualization.
10. User-facing explanations must use plain language and identify who tried to
    do what, which resource was involved, why risk changed, and what the system
    did. Raw JSON may be inspectable evidence but is not the primary UX.
11. Do not call static configuration, prompt claims, or fixed thresholds
    "learning." Learning requires history-derived behavioral context that can
    change a later decision.
12. Do not claim a capability works unless a relevant test exercised the real
    path and the evidence is recorded.
13. Do not weaken, skip, delete, or rewrite tests merely to make implementation
    appear successful.
14. Prefer a few deeply integrated, demonstrable capabilities over many
    half-implemented signals or screens.
15. Changes from different agents must conform to the shared architecture
    contracts. The Orchestrator owns contract changes and integration order.

## Repository reality agents must preserve

- The React/Vite frontend is under `apps/web`; the Fastify control plane and
  runtime orchestration are under `apps/server`.
- `AgentService.sendMessage()` creates the Run. `AgentService.executeRun()`
  invokes `applyRunPolicy()` before `runner.run()`. This is a genuine but coarse
  whole-Run interception point.
- `ControlledActionRuntime` creates an attributable managed-action Run and
  calls `ResourceGateway.request()`. The gateway resolves server-attested Run
  identity, evaluates ownership/RBAC, exact capability, downstream graph
  impact, trusted history, and breaker state, then atomically claims the exact
  action before `SqliteManagedResourceAdapter.execute()` performs a durable
  managed-state read or write. This narrow action-level path is real backend
  middleware, not a frontend simulation.
- Once `CodexRunner` or `ContainerCodexRunner` starts, ordinary shell,
  filesystem, connector, and network actions bypass `ResourceGateway`. The
  managed SQLite adapter is the only production action adapter currently
  proven through this boundary; never generalize that evidence to arbitrary
  Codex tools. Parsing Codex JSON output is post-hoc observation and must not
  be presented as a pre-effect gate.
- Agents, messages, and Runs are persisted in `launchpad.json`; graph,
  observation, policy, approval, claim, timeline, identity, delegation,
  behavioral-baseline, breaker, and managed-resource data are persisted in
  `middleware.db`. SQLite is the authoritative store for security state. The
  split still means SQLite records have service-validated weak Run references
  rather than database foreign keys to `launchpad.json` Runs.
- The application resolves one configured authenticated principal for the
  entire demo session. The shared bearer token authenticates the application,
  not a distinct Alice or Bob login. Alice and Bob are deterministic graph
  owners used to prove backend ownership enforcement; caller-supplied identity
  fields or headers do not select the trusted principal. This is not a
  multi-user, multi-tenant identity system or reviewer separation of duty.
- The backend graph now provides bounded deterministic forward and reverse
  queries: exact capabilities, reachable resources, downstream impact,
  inbound dependencies, affecting Agents, related Runs, ownership, and an
  explainable Agent-to-Resource path. Runtime policy consumes downstream
  impact. Durable delegation, ordered Run events, trusted-history baselines,
  and a persistent `NORMAL`/`WARN`/`TRIPPED` breaker are implemented around
  managed actions.
- The Run timeline supports persisted, sequence-ordered reconstruction of what
  happened and why. It is not deterministic replay or re-execution of arbitrary
  external side effects. External adapters still need an outbox and recovery
  protocol for post-effect audit failure.
- Prompt and final-response observations are bounded text-derived claims, not
  audited tool behavior. They may add Agent-scoped impact/risk context but
  cannot grant a `CAN_*` capability or enter the trusted managed-action
  baseline merely because the prompt asserted them.
- Existing generated `workspaces/*/AGENTS.md` files are runtime Agent data.
  Never edit or treat them as repository engineering instructions.

Do not erase these limitations from documentation until implementation and
tests prove they are resolved.

## Engineering workflow

The Orchestrator owns the build -> evaluate -> fix -> re-evaluate loop:

1. Establish the clean baseline and freeze shared contracts.
2. Assign bounded, non-overlapping work to the appropriate specialist.
3. Specialists implement and return evidence; they do not self-certify.
4. The Orchestrator inspects code and runs focused checks.
5. The Integration agent exercises complete backend/runtime/data paths,
   including actual side-effect prevention.
6. The Critic independently attempts to disprove the claims.
7. Every failure is routed to the specialist that owns the failing component.
8. Integration and Critic retest the fix. Repeat until every required criterion
   passes or the Orchestrator reports a concrete blocker.

Parallelize read-only exploration and truly disjoint edits. Shared agents use
one filesystem in the current environment, so the Orchestrator must assign file
ownership and sequence overlapping schema, domain-type, API-contract, and
lockfile changes. No agent may overwrite or discard another agent's work.

## Repository conventions and evidence

- Preserve ignored live state in `data/`, `apps/server/.data/`, `workspaces/`,
  and `codex-home/`. Never expose `.env` or credential material.
- Add immutable numbered SQLite migrations; never edit an applied migration.
  Preserve checksum verification, foreign keys, WAL behavior, validation, and
  deterministic query ordering.
- Keep direct `CAN_*` edges explicit. Inferred graph proximity, observations,
  ownership, past success, or delegation never grants authority.
- Security decisions fail closed when identity, policy, graph, baseline, event
  persistence required for a decision, or breaker state cannot be resolved.
- Redact and bound event metadata before persistence. Never store secrets,
  credential values, full environment data, or unconstrained tool output.
- Keep server and web DTOs synchronized; current duplicated Run types already
  differ, so new contracts must not deepen that drift.
- The canonical repository check is `npm run check`. Also use focused Vitest
  suites while iterating. Deployment-affecting work must validate
  `docker compose config --quiet` and the relevant Docker/runtime path.
- Dependency work must audit production and development scopes, update the root
  `package-lock.json`, and verify the built production tree. Never use a force
  upgrade as a substitute for exploitability analysis.
- A passing unit test is not enough for an end-to-end claim. Tests must prove
  the decision occurred before the real adapter effect and that blocked effects
  did not happen.
- Report commands, outcomes, and unresolved risks accurately. If a required
  tool such as Terraform is unavailable, state that limitation rather than
  claiming validation.

## Current execution gate

The repository owner's final audit request explicitly opened the execution
phase for Tasks 2, 4, and 6. The Orchestrator may assign scoped implementation,
integration, and criticism work through the role loop above and may declare the
phase complete only through the release gate in
[`specs/acceptance-criteria.md`](specs/acceptance-criteria.md).

Opening this execution phase is not standing authorization for unrelated work.
Future agents still require a current user request plus an Orchestrator-assigned
scope, must respect file ownership and destructive-action rules, and must not
weaken acceptance criteria or product invariants. A later project phase is not
implicitly open merely because this audit phase was opened.
