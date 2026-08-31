# Full Hackathon Codebase Audit — Agent Middleware

> **Historical before-state audit.** The findings and test counts below are a
> snapshot of the earlier implementation; several cited gaps have since been
> implemented. They remain here to preserve the original evidence trail. Use
> [Architecture](ARCHITECTURE.md), [Current Weaknesses](CURRENT_WEAKNESSES.md),
> and [Dependency Security Report](DEPENDENCY_SECURITY_REPORT.md) for the
> current audited boundary and residual risk.

Audit date: 2026-08-31  
Audited branch: `policy-enforcement` at `e08f681`, including the uncommitted working-tree changes present at audit time  
Scope: application code, middleware, persistence, runtime adapters, frontend, deployment files, documentation, tests, and live Docker Compose behavior

## Remediation update — 2026-08-31

The two P0 defects discovered during this audit have now been fixed and
verified. The detailed audit below still records the original findings so the
failure mode and reasoning are not lost; references to the former failures
should be read together with this update.

| Audit blocker | Implementation | Verification after the fix |
| --- | --- | --- |
| Percent-encoded API paths bypassed authentication | The auth hook now authorizes using Fastify's matched route plus a bounded canonical pathname fallback. Encoded characters, backslashes, repeated slashes, and malformed encodings can no longer turn an API route into an unprotected raw-string prefix. | New GET/POST regression coverage passed. Against the rebuilt healthy Docker service: plain unauthenticated GET `401`, encoded unauthenticated GET `401`, encoded unauthenticated POST `401`, and encoded authenticated GET `200`. |
| Agent-owned observations leaked through shared assets | Observation traversal now requires both `agent_node_id` and `source_node_id`; exact-action and whole-Agent traversal pass the current Agent ID into the SQLite query. Shared trusted topology remains global, while learned evidence remains owned by its observing Agent. | New two-Agent SQLite regression passed. Compiled-code reproduction: Agent A score `11`; Agent B score `1`, representing only its shared API and not Agent A's learned dependency. |

Post-fix `npm run check` passed with **17 test files and 82 tests**, both
TypeScript projects, and both production builds. The production Docker image
was rebuilt and the service became healthy on port 3000. These fixes remove the
two original release blockers, but they do not resolve the remaining high-risk
items: vulnerable production dependencies, unconfirmed prompt-observation
poisoning, shared-token identity, and the lack of per-tool runtime enforcement.

## 1. EXECUTIVE VERDICT

This is no longer merely a graph mock-up. The code contains real middleware in the pre-run execution path: a Run is classified, the stored graph is traversed, an action surface is scored, and a high-risk or suspicious Run can be paused or denied before `runner.run()` starts. SQLite-backed decisions, approval expiry, request/graph binding, and one-time claims are substantive engineering.

It is not yet the full middleware story described in the strongest product narrative. Codex tool calls, file operations, shell commands, and network calls do not pass through the Resource Gateway. The gateway is a separately callable HTTP prototype backed by simulated side effects. There is no flight recorder, replay engine, or circuit breaker. The graph learns resource-to-resource statements from prompts and final replies, but not from real tool activity.

The audit originally found two confirmed release blockers:

1. **Authentication bypass — remediated:** an unauthenticated request to `/%61pi/agents` originally returned HTTP 200 while `/api/agents` returned 401. The hook now checks the matched route and canonical pathname ([app.ts](../apps/server/src/app.ts)); encoded unauthenticated GET and POST requests now return 401.
2. **Cross-Agent observation contamination — remediated:** traversal originally fetched observations only by source node and state. It now filters by the observing Agent as well ([knowledge-graph.ts](../apps/server/src/knowledge-graph.ts), [sqlite-knowledge-observation-store.ts](../apps/server/src/sqlite-knowledge-observation-store.ts)); the two-Agent reproduction now leaves Agent B at its expected score of 1.

Largest strength: an explainable, transitive graph score genuinely changes whether the Agent runtime starts, with durable and single-use approval mechanics.

Largest weakness: enforcement ends at the Run boundary. Once Codex starts, its actual operations bypass the graph and Resource Gateway.

Biggest judging risk: claiming “live runtime enforcement,” “flight recorder,” or “runtime-discovered graph” invites a judge to ask for a real denied tool call. The current code cannot show that honestly.

| Measure | Score | Candid reason |
| --- | ---: | --- |
| Overall technical completeness | **6/10** | Strong POC foundations; major runtime features remain absent, although both audit blockers are now fixed. |
| Middleware credibility | **6/10** | Real pre-run interception, but no per-action interception after the model starts. |
| Hackathon alignment | **7/10** | The graph/policy/approval path is missing middleware, not starter-platform CRUD. |
| Demo readiness | **5/10** | A compelling controlled demo exists, but security/correctness fixes and claim discipline are required. |

**Bottom line:** qualify this as a credible **pre-run graph-risk policy prototype**, not a complete runtime capability firewall.

## 2. WHAT IS ACTUALLY IMPLEMENTED

### Agent platform and runtime

- **Feature:** Agent CRUD, persistent workspace, chat, async Run lifecycle, Codex session resume.
- **Status:** Real and end-to-end.
- **Files:** [agent-service.ts](../apps/server/src/agent-service.ts#L25), [workspace.ts](../apps/server/src/workspace.ts), [codex-runner.ts](../apps/server/src/codex-runner.ts#L89), [App.tsx](../apps/web/src/App.tsx#L70).
- **Backend:** `AgentService` owns Agent/Run lifecycle and invokes an `AgentRunner`.
- **Frontend:** Live CRUD, status, messages, polling, and stop/start controls.
- **Database:** Agents, Runs, and messages are in `launchpad.json`, not SQLite.
- **Runtime integration:** Direct `AgentService.executeRun()` → `runner.run()` call at [agent-service.ts](../apps/server/src/agent-service.ts#L325).
- **Actual behaviour:** Works; one concurrent Run per Agent is enforced in a single process. Restarts cancel queued, running, and approval-waiting Runs.

### Knowledge/capability graph

- **Feature:** Nodes, authority edges, dependency edges, audit edges, observations, whole-network and per-Agent queries.
- **Status:** Real, persisted, graph-native traversal; learned observations are Agent-scoped during traversal.
- **Files:** [graph-types.ts](../apps/server/src/graph-types.ts), [knowledge-graph.ts](../apps/server/src/knowledge-graph.ts#L92), [sqlite-graph-store.ts](../apps/server/src/sqlite-graph-store.ts), [sqlite-knowledge-observation-store.ts](../apps/server/src/sqlite-knowledge-observation-store.ts).
- **Backend:** Bounded breadth-first traversal follows exact direct capabilities, then downstream topology and non-rejected observations.
- **Frontend:** Live Impact Map and whole Network Graph.
- **Database:** `graph_nodes`, `graph_edges`, and `graph_observations` in SQLite.
- **Runtime integration:** Graph output feeds the pre-run policy gate; no tool-stream ingestion.
- **Actual behaviour:** It calculates multi-hop paths and risk. Trusted topology may be shared, while learned observations affect only their owning Agent.

### Prompt-assisted permission configuration

- **Feature:** Suggest direct access from an actionable prompt, then require confirmation.
- **Status:** Real but heuristic.
- **Files:** [prompt-intelligence.ts](../apps/server/src/prompt-intelligence.ts#L90), [graph-configuration.ts](../apps/server/src/graph-configuration.ts#L110), [App.tsx](../apps/web/src/App.tsx#L285).
- **Backend:** Regex/keyword inference proposes one resource, capability, and classification.
- **Frontend:** User can change access/classification or continue without saving.
- **Database:** Confirmation creates/reuses an asset and writes an authorized `CAN_*` edge.
- **Runtime integration:** The confirmed permission changes later policy decisions.
- **Actual behaviour:** No LLM is used for the suggestion. No authority is added silently.

### Learned knowledge observations

- **Feature:** Extract resource dependencies from prompts and final Agent replies.
- **Status:** Real deterministic extraction; not tool-derived and still vulnerable to low-trust prompt poisoning, but now isolated by Agent.
- **Files:** [knowledge-observation.ts](../apps/server/src/knowledge-observation.ts#L49), [agent-service.ts](../apps/server/src/agent-service.ts#L232), [knowledge-observation-api.test.ts](../apps/server/src/knowledge-observation-api.test.ts#L39).
- **Backend:** Regexes emit `DEPLOYS_TO`, `PROCESSES`, `CONTAINS`, `READS_FROM`, `CALLS`, or `DEPENDS_ON` observations.
- **Frontend:** Evidence, confidence, source, state, Confirm, and Reject are live.
- **Database:** Upserted by Agent/source/target/relation with state and Run provenance.
- **Runtime integration:** Prompt is scanned before policy; final model text is scanned after completion. Intermediate actions are invisible.
- **Actual behaviour:** Observed and confirmed facts both affect risk; rejected facts do not. They cannot create `CAN_*` authority.

### Blast radius

- **Feature:** Explainable transitive risk score and focused shortest path.
- **Status:** Real but simplistic.
- **Files:** [knowledge-graph.ts](../apps/server/src/knowledge-graph.ts#L117), [KnowledgeGraphPanel.tsx](../apps/web/src/KnowledgeGraphPanel.tsx#L108).
- **Backend:** Sums each unique reachable asset's static `riskWeight` once.
- **Frontend:** Shows factors, score, decision, and selectable paths.
- **Database:** Risk weights/classifications live on graph nodes.
- **Runtime integration:** Worst direct capability score drives pre-run action review/deny.
- **Actual behaviour:** Cycles and duplicate paths are handled, but capability kind, edge semantics, distance, environment, confidence, and data-category sensitivity do not affect weighting.

### Pre-run policy enforcement

- **Feature:** Informational/action/suspicious intent, allow/review/deny before Codex.
- **Status:** Real and tested.
- **Files:** [run-policy-gate.ts](../apps/server/src/run-policy-gate.ts#L34), [policy-service.ts](../apps/server/src/policy-service.ts#L59), [agent-service.ts](../apps/server/src/agent-service.ts#L418).
- **Backend:** Selects the Agent's highest-impact direct capability; stores a decision for protected actionable/suspicious paths.
- **Frontend:** Inline approval/rejection and risk-factor breakdown.
- **Database:** Protected decisions and approvals are durable in SQLite; summary also copied into the JSON Run.
- **Runtime integration:** `applyRunPolicy()` returns before `runner.run()` on deny/review.
- **Actual behaviour:** Dangerous Runs can genuinely be stopped before runtime. Informational mode is only a prompt instruction once allowed, not a technical read-only boundary.

### Exact protected-action Resource Gateway

- **Feature:** Exact capability/target enforcement, one-time execution, audit edges.
- **Status:** Partial prototype; real policy mechanics with fake resource effects.
- **Files:** [resource-gateway.ts](../apps/server/src/resource-gateway.ts#L69), [app.ts](../apps/server/src/app.ts#L225).
- **Backend:** `POST /api/runs/:id/actions` evaluates and claims an operation before adapter execution.
- **Frontend:** No client methods or UI for these action endpoints.
- **Database:** Decisions, approvals, claims, `ATTEMPTED`, `DENIED`, and `TOUCHED` are persisted.
- **Runtime integration:** None from Codex. The caller must explicitly invoke the HTTP endpoint.
- **Actual behaviour:** Unauthorized API actions do not reach `DemoResourceAdapter`, but Codex shell/filesystem/network actions never call it.

### Approval system

- **Feature:** Pending/approved/rejected/expired/consumed lifecycle and one-time claims.
- **Status:** Solid POC persistence, weak identity model.
- **Files:** [sqlite-governance-store.ts](../apps/server/src/sqlite-governance-store.ts), [policy-service.ts](../apps/server/src/policy-service.ts#L164).
- **Backend:** Request hash binds Run, Agent, capability, target, graph revision, and payload.
- **Frontend:** Selected Run can be approved/rejected inline.
- **Database:** Transactional single-winner resolution and claim.
- **Runtime integration:** Approved pre-run decisions permit exactly one resume.
- **Actual behaviour:** Replay and stale-graph use are refused. Requester and approver share the same application token; optional human node ID comes from the body.

### Flight recorder, replay, circuit breaker

- **Status:** Not implemented as named features.
- **Actual behaviour:** Fastify logs, Run summaries, policy records, and a few graph audit edges exist. They do not form an ordered execution trace, cannot reconstruct tool activity, and cannot replay a Run. Timeout/output caps and manual stop are safeguards, not a stateful circuit breaker.

## 3. ACTUAL ARCHITECTURE

```text
┌────────────────────────────────────────────────────────────────────┐
│ React Web UI                                                       │
│ CRUD / Playground / Impact Map / Network Graph / inline approval  │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ HTTP JSON + one shared bearer token
                               v
┌────────────────────────────────────────────────────────────────────┐
│ Fastify API                                                        │
│ auth hook* / validation / Agent routes / graph routes / policy API│
└──────────────┬──────────────────────────┬──────────────────────────┘
               │                          │
               v                          v
┌──────────────────────────┐    ┌────────────────────────────────────┐
│ AgentService             │    │ Graph / policy services            │
│ Run state + messages     │    │ BFS + score + approvals + claims   │
└───────┬─────────┬────────┘    └──────────────┬─────────────────────┘
        │         │                            │
        │         │ prompt/final text          v
        │         └──────────────────> ┌─────────────────────────────┐
        │                              │ SQLite middleware.db        │
        │ pre-run gate                 │ graph / observations /      │
        ├─────────────────────────────>│ policy / approvals / claims │
        │                              └─────────────────────────────┘
        v
┌──────────────────────────┐
│ CodexRunner              │  IMPORTANT: direct path; no tool gateway
│ local process OR         │───────────────────────────────────────┐
│ disposable container    │                                       │
└──────────────┬───────────┘                                       v
               │                                         Files / shell / network
               v
       Volcengine Ark API

Separate, not called by Codex:

POST /api/runs/:id/actions -> ResourceGateway -> PolicyService
                            -> DemoResourceAdapter -> simulated result

Other persistence:
launchpad.json -> Agents / Runs / messages / legacy unused graph arrays
workspaces/    -> Agent-created files and generated AGENTS.md

* The audit found a percent-encoded-path bypass here; it is now remediated by
  matched-route and canonical-path authorization.
```

Full Run flow:

1. `POST /api/agents/:id/messages` validates a bounded prompt and calls `AgentService.sendMessage()` ([app.ts](../apps/server/src/app.ts#L339)).
2. The JSON store atomically rejects stopped/busy/approval-paused Agents, then writes the user message and queued Run ([agent-service.ts](../apps/server/src/agent-service.ts#L204)).
3. The prompt observation extractor runs **before** policy ([agent-service.ts](../apps/server/src/agent-service.ts#L232)). Its errors are swallowed.
4. `executeRun()` briefly marks the Run running, then calls `applyRunPolicy()` ([agent-service.ts](../apps/server/src/agent-service.ts#L325)).
5. The gate classifies intent. Informational and no-capability paths return an in-memory/JSON policy summary without a durable SQLite decision. Other action paths choose the most exposed direct capability.
6. `PolicyService` recomputes exact graph impact, writes a decision/approval, and emits audit graph edges.
7. `ALLOW` calls the runner. `REVIEW_REQUIRED` changes the Run to `awaiting_approval`. `DENY` fails it. The runner is not called in the latter two cases.
8. Approved Runs recompute the bound request/graph hash and atomically consume a single-use claim before resuming.
9. Codex emits JSON lines, but the runner retains only thread ID, final Agent message, usage, and errors ([codex-runner.ts](../apps/server/src/codex-runner.ts#L44)). Tool events are discarded.
10. The final reply is scanned for relationship sentences and the JSON Run/message state is completed.

## 4. FEATURE MATURITY TABLE

Scale: 0 nonexistent, 1 mock/UI fragment, 2 partial prototype, 3 works but shallow, 4 solid, 5 compelling and demo-ready.

| Feature | Score | Why it is below 5 |
| --- | ---: | --- |
| Knowledge Graph | 3/5 | Real shared topology and Agent-scoped learned layer, but narrow entity/relation model and poisoning risk remain. |
| Graph Persistence | 4/5 | SQLite constraints/migrations are strong; no lifecycle/versioning/aliasing and mixed JSON/SQLite integrity is weak. |
| Graph Traversal | 3/5 | Deterministic bounded BFS, cycles, and observation ownership work; Agent-to-Agent paths remain impossible. |
| Blast Radius | 3/5 | Multi-hop and explainable, but static additive weights ignore permission type, path semantics, and sensitive data-category nodes. |
| Runtime Policy Enforcement | 3/5 | Truly gates Run start, but worst-capability prompt heuristics are coarse and post-start actions bypass it. |
| Runtime Edge Enforcement | 2/5 | Exact Gateway logic is real, but disconnected from Codex and backed by simulated actions. |
| Flight Recorder | 1/5 | Policy fragments and logs exist; no unified ordered event model. |
| Replay | 0/5 | Session resume and replay prevention are not execution replay. |
| Circuit Breaker | 0/5 | No counters, states, cooldown, half-open trial, or automatic policy. |
| Database Design | 4/5 | Strong SQLite mechanics; Runs are JSON weak references, graph deletion/lifecycle is absent, and some uniqueness constraints are missing. |
| API Design | 3/5 | Validated and coherent with canonical API-path auth; pagination/rate limit, body-supplied human identity, and Gateway/UI integration remain missing. |
| Security | 2/5 | The confirmed auth bypass is fixed, but there is still no real identity/RBAC, runtime powers are broad, secrets are inherited, and dependencies are vulnerable. |
| Testing | 4/5 | 82 backend tests include negative, concurrency, encoded-auth, and cross-Agent cases; no frontend/browser, load, or real-runtime integration tests. |
| Observability | 2/5 | Request logs and policy evidence exist; no metrics, correlation timeline, trace UI, or durable runtime events. |
| Frontend Integration | 4/5 | Graph, score, approval, and observation UI use live APIs; Gateway/traces/breaker absent and a few labels/previews mislead. |
| Hackathon Alignment | 3/5 | Pre-run graph policy is genuine middleware; several headline concepts remain architecture aspirations. |
| Demo Readiness | 3/5 | Both audit blockers are fixed and the happy path is polished, but a real denied runtime tool call still cannot be shown. |

## 5. KNOWLEDGE GRAPH DEEP DIVE

### Nodes and edges that exist

`GraphNodeType` supports `human`, `agent`, `asset`, `data_category`, and `run` ([graph-types.ts](../apps/server/src/graph-types.ts#L1)). In practice, no code creates Run nodes. Tools, models, workspaces, secrets, files, runtimes, and network destinations are all collapsed into `asset` if represented at all.

Trusted edges are `OWNS`, `CAN_READ`, `CAN_WRITE`, `CAN_CALL`, `CAN_USE`, `DEPLOYS_TO`, `PROCESSES`, and `CONTAINS`. Audit edges are `ATTEMPTED`, `TOUCHED`, and `DENIED`. Learned observations add `READS_FROM`, `CALLS`, and `DEPENDS_ON`, plus learned variants of the three dependency relations. There is no Agent-to-Agent relation such as `DELEGATES_TO`, so transitive Agent authority cannot be modeled.

### Data origins

- Demo fixtures create two known Agents and a shared seeded topology ([demo-graph.ts](../apps/server/src/demo-graph.ts#L53)).
- Normal Agent creation creates only an Agent identity node ([agent-graph-provisioner.ts](../apps/server/src/agent-graph-provisioner.ts#L21)).
- Users/trusted API callers explicitly create nodes and authority/dependency edges.
- Prompt analysis proposes one direct access edge, but a person confirms it.
- Regex extraction creates non-authoritative resource nodes and observations from prompts/final replies.
- Policy evaluation creates attempted/denied/touched audit edges only when the policy path is called.
- No actual Codex tool call creates a graph edge.

### Static versus dynamic

The graph is mixed. Authority and trusted topology are static configuration. Observations are dynamically derived from text, but they are claims in natural language, not runtime facts. Policy audit edges are runtime-correlated only for pre-run/gateway decisions, not arbitrary Codex behavior.

### Persistence and querying

SQLite is authoritative for graph state. `GraphStore` isolates the algorithm from persistence. The principal useful query is forward reachability from one Agent. Whole catalog and per-Agent subgraph APIs exist. Missing queries include reverse dependency, shortest path between arbitrary nodes, affected-Agent lookup, privilege escalation, historical diff, runtime drift, and Agent-to-Agent propagation.

### Transitive reasoning and value beyond JSON/RBAC

There is genuine graph value: `Agent → CAN_WRITE → config → DEPLOYS_TO → production → PROCESSES → customer dataset` yields a multi-hop path and score that a flat permission list would not naturally explain. Paths influence Run start. That is meaningfully beyond a prettier permission dictionary.

However, direct `CAN_*` remains ordinary RBAC represented as edges. The compelling part is the downstream topology and policy traversal, not the permission storage itself. Until runtime discoveries, reverse analysis, and Agent-to-Agent paths exist, much of the graph's potential remains unused.

### Resolved graph defect and current limitations

1. **Resolved — Cross-Agent contamination:** `KnowledgeObservationStore.getOutgoing()` now requires the Agent and source node. SQLite filters by `agent_node_id`, `source_node_id`, and state, so an Agent cannot traverse another Agent's observations through a globally shared asset.
2. **Prompt poisoning:** prompt observations are written before policy, including for denied prompts. An attacker can state a false dependency and immediately raise that same Agent's later policy scores.
3. **Observed equals confirmed for enforcement:** both states traverse identically; confidence is displayed but ignored.
4. **No negative/contradictory facts:** one latest evidence excerpt replaces prior evidence for the same tuple.
5. **No freshness:** no `last_seen`, evidence count, expiry, decay, active flag, or topology version.
6. **Global label identity:** case-insensitive exact labels merge resources without namespace/environment/external ID; spelling variants create duplicates.
7. **No transactional discovery unit:** node creation and observation upsert are separate; partial failures can leave orphan inferred nodes.
8. **No Agent-to-Agent traversal:** required Scenario D cannot be represented.
9. **Data-category risk ignored:** `data_category` nodes always contribute zero because scoring filters to `asset`; a low-risk asset containing restricted PII does not gain score from that fact.
10. **Bound behavior is abrupt:** exceeding 32 nodes or 64 edges fails the entire traversal/policy closed, which is safe but can make a larger demo unusable.

**GRAPH VERDICT:** **D — genuinely used for middleware reasoning, but still an early prototype.** It is neither just visualization nor merely static metadata. Observation isolation is fixed; observation trust, runtime evidence, and richer graph semantics remain necessary before production reliance.

## 6. BLAST RADIUS DEEP DIVE

Conceptual algorithm in [knowledge-graph.ts](../apps/server/src/knowledge-graph.ts#L319):

1. Load `agent:{id}` and reject missing/non-Agent nodes.
2. Load all direct authorized `CAN_*` outgoing edges.
3. Seed BFS with each direct target and store path `[Agent, target]`.
4. For every queued node, load authorized `DEPLOYS_TO`, `PROCESSES`, and `CONTAINS` edges.
5. Also load non-rejected observations from the current source node.
6. Visit each node once, retaining the first deterministic shortest path. Sort by `createdAt`, then ID.
7. Stop with an error above 32 nodes or 64 unique edges.
8. Select reachable nodes where `type === "asset" && riskWeight > 0`.
9. Sum each unique asset's weight once.
10. Return review when `score > threshold`; equality is allowed.

Release Guardian's 21 is therefore:

```text
Deployment configuration   4
Production service         7
Customer dataset          10
                          --
Total                     21
```

This is not `number_of_edges(agent)`. It handles transitive paths, cycles, multiple direct permissions, and produces explainable evidence. `calculateActionImpact()` also narrows traversal to one exact direct capability/target for Gateway policy.

Flaws:

- `CAN_READ` and `CAN_WRITE` contribute identically.
- An indirect node contributes the same regardless of distance or edge type.
- Risk is hand-assigned/classification-defaulted, not calibrated from environment or operation.
- `CONTAINS restricted-data` contributes zero unless the containing asset already has a weight.
- Confidence and observation state beyond rejected/not-rejected are ignored.
- Scores across multiple direct capabilities are not aggregated for pre-run policy; the maximum single surface is selected ([run-policy-gate.ts](../apps/server/src/run-policy-gate.ts#L183)).
- No Agent-to-Agent inheritance, privilege escalation path, or reverse impact.
- Strict `>` means score 20 is allowed with a review threshold of 20; score 40 is reviewable rather than denied with a deny threshold of 40 ([policy-service.ts](../apps/server/src/policy-service.ts#L319)). This should be deliberate and documented if retained.
- Agent-owned observations are isolated, but intentionally shared trusted-topology changes still affect every Agent that reaches those nodes.

Recommended realistic v2 formula:

```text
node impact
  = base asset criticality
  × capability multiplier (read < call < write/use)
  × environment multiplier (dev < staging < prod)
  × path confidence product
  × distance decay

overall score
  = bounded sum of unique impacted assets
  + explicit penalties for secrets, production writes, and Agent delegation
```

Keep the path and factors in evidence so the UI can show the equation. Use confirmed topology at full confidence; quarantine unconfirmed prompt evidence or use it only to force review. Add reverse queries and a separate categorical policy (“any path to restricted data via write/call requires review”) rather than trusting a single scalar.

## 7. POLICY / ENFORCEMENT DEEP DIVE

### Exact pre-run interception

```text
POST /api/agents/:id/messages
  -> AgentService.sendMessage()
  -> AgentService.executeRun()
  -> AgentService.applyRunPolicy()
  -> KnowledgeGraphRunPolicyGate.evaluateRun()
  -> analyzePromptIntent()
  -> mostExposedCapability()
  -> PolicyService.evaluate()
  -> SQLite decision / optional approval / graph audit edge
     ├─ ALLOW -> CodexRunner.run()
     ├─ REVIEW_REQUIRED -> awaiting_approval; runner not called
     └─ DENY -> failed; runner not called
```

Tests explicitly count runner calls and prove review/deny prevents startup ([policy-api.test.ts](../apps/server/src/policy-api.test.ts#L159)). Policy evaluation exceptions fail closed ([agent-service.ts](../apps/server/src/agent-service.ts#L421)). This is genuine middleware.

### Exact action interception prototype

```text
POST /api/runs/:id/actions
  -> ResourceGateway.request()
  -> verify Run belongs to a live, eligible Agent
  -> PolicyService.evaluate(exact capability + target + payload)
  -> claimForExecution()
  -> DemoResourceAdapter.execute()
  -> PolicyService.recordSuccess()
```

The mechanics are sound for calls that enter this endpoint. The adapter is explicitly simulated ([resource-gateway.ts](../apps/server/src/resource-gateway.ts#L69)). No frontend method calls it, and `CodexRunner` has no dependency on it.

### Decision behavior

- Missing exact direct capability: deny.
- Score above deny threshold: deny.
- Suspicious regex with capability: require review unless above deny.
- Score above review threshold: require review.
- Otherwise: allow.
- Informational prompt: allow score zero without a durable `policy_decisions` row.
- Action prompt with no capability: allow because the system considers there to be no protected capability, even though Codex still has workspace shell/filesystem/network abilities outside the graph.

### Bypasses and gaps

1. Once Codex starts, all shell, file, and network behavior bypasses policy.
2. `POLICY_ENFORCEMENT=off` removes the pre-run gate entirely ([index.ts](../apps/server/src/index.ts#L44)).
3. “Informational” is regex-classified and enforced only by adding a model instruction. It is not a read-only sandbox.
4. Paraphrased malicious intent can miss the suspicious regex; benign security discussion can false-positive.
5. Pre-run chooses the most exposed capability, not the requested resource/action. This may over-review irrelevant tasks or under-model combined actions.
6. A no-capability Agent still has real Codex workspace capabilities that the graph does not represent.
7. The approval actor is a shared application principal. `actorHumanNodeId` is request-body input despite the comment claiming actor identity is server-derived ([app.ts](../apps/server/src/app.ts#L215)).
8. The same shared token can request and approve; there is no separation of duty.
9. A Gateway adapter failure consumes the one-time claim before execution and stores no structured failure event. Conversely, if an external action succeeds and `recordSuccess()` fails, the caller gets an error after the side effect.
10. Approval expiry is lazy on reads/claims, not background-maintained.

## 8. FLIGHT RECORDER / REPLAY DEEP DIVE

Definitions:

- **Logging:** diagnostic text about requests/errors. The Fastify logger provides this.
- **Tracing:** structured, correlated, ordered events/spans across Run, model, tool, policy, and side effects. This does not exist comprehensively.
- **Replay:** reconstructing or re-executing a prior Run from captured inputs, decisions, tool results/state, and ordering. This does not exist.

What exists:

- `AgentRun`: prompt, final output/error, status, usage, timestamps, and policy summary in JSON.
- `policy_decisions`: structured durable policy evidence.
- `approval_events`: structured approval state transitions.
- `ATTEMPTED`/`DENIED`/`TOUCHED`: graph audit facts for calls that reach policy.
- Codex JSON stream parser: reads events but discards everything except thread ID, final Agent message, usage, and errors ([codex-runner.ts](../apps/server/src/codex-runner.ts#L44)).
- Request logs: not a domain trace and not stored in the application database.

Missing:

- Event table with Run ID, Agent ID, monotonic sequence, event type, timestamp, sanitized payload, parent span, and schema version.
- `run_started`, model/tool requested/completed/failed, policy checked, resource accessed, graph changed, retry, cancellation, and completion events.
- Atomic ordering across concurrent events.
- Redaction before persistence.
- Trace query/export UI.
- State snapshot/hash needed for replay.
- Actual re-execution or dry-run simulation.

Calling Codex `resume` is conversation continuation, not replay. Refusing a second approval claim is replay **prevention**, not execution replay.

## 9. CIRCUIT BREAKER DEEP DIVE

No circuit breaker exists. There are no CLOSED/OPEN/HALF_OPEN states, counters, rolling windows, cooldowns, persisted state, reset endpoint, or independent Agent thresholds.

Existing safeguards are:

- one active Run per Agent;
- manual stop/cancellation;
- wall-clock timeout;
- output-byte limit;
- container CPU/memory/PID limits when the container runtime provider is used.

Those prevent some runaway resource use but do not learn from repeated failures or deny repeated actions. A genuine flow should be:

```text
CLOSED
  -> record failures/denials/repeats in a rolling per-Agent window
  -> threshold exceeded: persist OPEN, emit event, cancel active Run
OPEN
  -> reject new Runs/actions until cooldown_until
  -> cooldown elapsed: HALF_OPEN
HALF_OPEN
  -> allow one bounded probe
  -> success: reset CLOSED
  -> failure: reopen with reason
```

Concurrency requires an atomic database transition, not an in-memory boolean. For the hackathon, denied actions, repeated identical tool calls, and a sharp blast-radius increase are the most graph-relevant triggers.

## 10. DATABASE DEEP DIVE

### SQLite schema

| Table | Purpose and important fields | Relationships / constraints | Audit assessment |
| --- | --- | --- | --- |
| `schema_migrations` | version, name, checksum, applied_at | PK version, unique name | Good immutable checksum model; dates are text without format checks. |
| `graph_nodes` | id, type, label, risk level/weight, classification, metadata, timestamps | STRICT checks and JSON validity | Missing canonical external ID, namespace/environment, label uniqueness, active/deleted state, source, last-seen/version. |
| `graph_edges` | id, source/target, relation, status, optional Run, metadata, created | Endpoint FKs, valid relation/status combinations, indexes | `run_id` is not an FK; no logical uniqueness; no updated/last-seen/active/history fields. |
| `graph_observations` | owner Agent, optional Run, source/target, relation, state, confidence, source kind, evidence, timestamps | Endpoint/Agent FKs; unique Agent/source/target/relation | `run_id` weak; evidence unredacted; no evidence aggregation/count/trust/expiry; traversal omits Agent filter. |
| `policy_decisions` | operation, Run, Agent, capability, target, result/reason, matched edge, score/threshold, version/hash/evidence, expiry/time | unique operation; Agent/target/edge FKs; request-hash checks | Strong immutability/idempotency. Run is a JSON weak reference; no requested-vs-effective identity or latency. |
| `approval_requests` | decision, status, requested/expires/updated | unique decision, expiry ordering, status index | Good state record; no assigned reviewer/role. |
| `approval_events` | request, event type, actor principal/human, reason/time | request and optional human FKs | Append-only behavior is in service/store; actor principal is demo-level identity. |
| `policy_action_claims` | decision, claimed_at | decision PK/FK gives one claim | Strong single-use primitive; does not store claiming actor or execution result. |

Migrations are in [middleware-migrations.ts](../apps/server/src/middleware-migrations.ts#L11). Startup enables foreign keys, a 5s busy timeout, WAL, synchronous NORMAL, checksum validation, unknown-migration refusal, and `foreign_key_check` ([middleware-database.ts](../apps/server/src/middleware-database.ts#L18)). The DB file is chmod 0600.

### JSON schema

`launchpad.json` stores Agents, messages, and Runs, plus unused legacy `graphNodes`/`graphEdges` arrays ([types.ts](../apps/server/src/types.ts#L74)). Writes are serialized in-process and atomically renamed ([store.ts](../apps/server/src/store.ts#L49)). It is explicitly single-process and performs only shallow shape validation on load.

Consequences of split persistence:

- SQLite policy rows refer to JSON Run IDs without referential integrity.
- Restart cancellation of `awaiting_approval` Runs leaves pending SQLite approvals that can become stale/orphaned.
- Agent deletion removes JSON state but intentionally retains graph/policy state, without a tombstone telling the whole-graph UI the Agent is historical.
- No transaction spans Agent creation/deletion and graph synchronization.
- Multiple server processes would race on the JSON file even though SQLite could handle more concurrency.

### Live database verification

`data/middleware.db` contained migrations 1–3, passed `PRAGMA integrity_check` (`ok`), and returned no foreign-key violations. At audit time it contained 17 graph nodes, 20 graph edges, 0 observations, 4 decisions, 2 approval requests, 3 approval events, and 1 action claim. These counts are local runtime state, not hard-coded expectations.

## 11. FRONTEND VS REAL FUNCTIONALITY

| UI | Classification | Evidence and caveat |
| --- | --- | --- |
| Agent list/CRUD/settings | REAL | Live API; workspace path and state are real. |
| Playground messages/Runs | REAL | Live Ark/Codex path when configured. Only the latest Run is surfaced; no history timeline. |
| Inline pre-run approval | REAL | Approve/reject and resume call live policy endpoints. Identity is only a shared operator token. |
| Prompt access suggestion | REAL/PARTIAL | Live deterministic backend heuristic; not semantic LLM inference. |
| Impact Map | REAL | Live graph and blast APIs; paths and factors come from backend. |
| Network Graph | REAL/PARTIAL | Live catalog, but an observed prompt claim is locally converted to edge status `actual` for rendering ([OverallGraphPanel.tsx](../apps/web/src/OverallGraphPanel.tsx#L104)). |
| Observation review | REAL | Live evidence/state APIs. An observation can already affect risk before confirmation. |
| Manual access editor | REAL | Writes actual nodes/edges. Its preview follows only trusted catalog edges and ignores observations, unlike backend policy ([KnowledgeGraphPanel.tsx](../apps/web/src/KnowledgeGraphPanel.tsx#L231)). |
| Resource Gateway action UI | ABSENT | No frontend API functions for `/actions`. |
| Flight recorder/replay UI | ABSENT | No backend capability to display. |
| Circuit breaker UI | ABSENT | No backend capability to display. |
| Runtime label | MISLEADING | `local-process` is displayed as “ECS / Docker · Codex CLI” ([App.tsx](../apps/web/src/App.tsx#L399)). |

Source-based UI quality audit, following the `impeccable` audit rubric:

| Area | Score | Finding |
| --- | ---: | --- |
| Accessibility | 2/4 | Graph nodes are keyboard-operable and focus is visible, but edge evidence is hover-only; modal lacks dialog semantics/focus trap/Escape; tabs lack arrow-key behavior/tabpanels; many controls/text are too small. |
| Performance | 3/4 | Bundle is modest and animations are mostly cheap; four parallel graph requests duplicate catalog work and SVG layouts will degrade at larger node counts. |
| Responsive design | 3/4 | Explicit 900px/680px layouts exist; dense graph/toolbars and 26–38px controls remain difficult on touch devices. |
| Theming | 1/4 | A few root variables exist, but many one-off hex/OKLCH values and no dark/high-contrast theme. |
| Anti-patterns | 3/4 | Information hierarchy is coherent; very small typography and dense nested panels weaken readability. |
| **Total** | **12/20** | Source audit only; there are no real-browser, visual-regression, or automated accessibility tests. |

`prefers-reduced-motion` disables graph animation, but not all motion, including the spinner and JavaScript smooth scrolling. The create modal backdrop closes on mouse down but has no `role="dialog"`, `aria-modal`, focus containment, or focus restoration ([App.tsx](../apps/web/src/App.tsx#L802)).

## 12. SECURITY AND BYPASS ANALYSIS

### P0 findings — resolved after the audit

1. **Authentication bypass via encoded path — fixed.** The original live reproduction was `/api/agents` → 401 and `/%61pi/agents` → 200. Authentication now uses the matched route and canonical pathname, with regression coverage for encoded GET and POST. The rebuilt live service returns 401 for both encoded unauthenticated requests and 200 only with valid authentication.
2. **Cross-Agent graph contamination — fixed.** Observation lookups now require `agent_node_id` as well as `source_node_id`. The two-Agent regression and a compiled-code reproduction prove that Agent A's learned edge does not enter Agent B's traversal.

### High

3. **No per-tool enforcement:** a malicious or hallucinating Codex process can access anything permitted by its sandbox/container regardless of graph policy.
4. **Prompt poisoning:** denied prompts are persisted as observations before the gate, and `observed` facts immediately influence their owning Agent's policy before confirmation.
5. **No real identity/RBAC/separation of duty:** one bearer token controls Agents, graph writes, approvals, and execution.
6. **Approver attribution spoof:** caller can supply any existing `human` node as `actorHumanNodeId`; it is not bound to the authenticated principal.
7. **Ark key available to child runtime:** `ARK_API_KEY` is passed into Codex process/container environment ([codex-runner.ts](../apps/server/src/codex-runner.ts#L242)). Child tools may inherit it; prompt instruction is not secret isolation.
8. **Broad network:** container provider uses Docker bridge, not an egress allowlist ([container-codex-runner.ts](../apps/server/src/container-codex-runner.ts#L57)). Compose defaults to local-process inside the application container, so there is no per-Agent outer container.
9. **Known vulnerable dependencies:** `npm audit --omit=dev` reported 6 production vulnerabilities: 5 high and 1 moderate. Direct `@fastify/static@10.1.0` has path/authorization bypass advisories; transitive `find-my-way`, `fast-uri`, `brace-expansion`, `nanoid`, and `postcss` are affected. Fixes are reported available.

### Medium

10. **Informational-mode bypass:** question syntax can obtain zero-risk execution; the model is merely asked not to mutate.
11. **No rate limiting/lockout:** authentication guesses, graph writes, Runs, prompt observations, and approvals are unbounded.
12. **No CSRF defense:** bearer headers reduce ambient-browser CSRF risk, but the documented browser-facing security boundary remains incomplete.
13. **Unredacted observation evidence:** a matched sentence is persisted verbatim up to 500 characters. Secret-field validation protects JSON keys, not prompt/reply text.
14. **Raw internal errors:** the error handler sends `appError.message`; runtime/database details may reach clients.
15. **Unencrypted local state:** permissions are restrictive, but messages/prompts/evidence are plaintext at rest.
16. **Authorization can be disabled:** an empty token on non-production/loopback leaves all APIs unauthenticated; `POLICY_ENFORCEMENT=off` disables the pre-run gate.
17. **Ordinary sandbox:** the project correctly documents that this is not hardened multi-tenant isolation ([SECURITY.md](../SECURITY.md#L12)).

Positive controls: request schemas and size limits, parameterized SQLite, timing-safe token comparison, log redaction for auth/cookies, recursive rejection of secret-like JSON keys, non-root image user, dropped capabilities, no-new-privileges, resource limits, argument-array process spawning, output/time bounds, approval hash binding, and atomic one-time claims.

## 13. TEST RESULTS

Commands actually run on 2026-08-31:

| Command/check | Actual result |
| --- | --- |
| `npm run check` | **Passed after remediation**: server/web typecheck, 17 test files / 82 tests, web and server production builds. |
| Web build | Passed; 32 modules, JS 241.05 kB (73.80 kB gzip), CSS 32.90 kB (8.09 kB gzip). |
| `git diff --check` | Passed; no whitespace errors. |
| `bash -n scripts/*.sh` | Passed for 4 scripts. |
| `docker compose config --quiet` | Passed. |
| `docker compose up --build -d` | Passed; image built successfully. |
| `docker compose ps` | `launchpad` up and healthy on port 3000. |
| Live `/api/health` | 200. |
| Live `/api/auth` | 200, authentication required. |
| Live authenticated `/api/system` | 200; Ark configured, Codex available, `local-process`. |
| Live authenticated `/api/agents` | 200; six current Agents. |
| Live authenticated `/api/graph` | 200; 17 nodes, 20 edges, 0 observations. |
| SQLite migrations/integrity/FKs | Versions 1–3; integrity `ok`; no FK violation rows. |
| `npm audit --json --omit=dev` | **Failed security gate**: 6 vulnerabilities (5 high, 1 moderate), fixes available. |
| Encoded-path auth probe | **Passed after an expected fail-before regression**: encoded unauthenticated GET/POST return 401; authenticated GET returns 200. |
| Two-Agent observation isolation probe | **Passed after an expected fail-before regression**: Agent A score 11; Agent B score 1. |
| Terraform formatting/validation | **Not run**: `terraform` is not installed on this machine. |
| Lint | No lint script exists; `npm run lint --if-present` had nothing to run. |
| Browser/E2E/a11y tests | None exist; not run. |
| Paid live Ark Run | Not invoked during this audit to avoid modifying an Agent workspace and consuming external model quota. Runner integration was exercised with controlled full-stack test doubles; live readiness was verified. |

Scenario results:

| Required scenario | Result | Evidence |
| --- | --- | --- |
| A — safe Agent | PARTIAL PASS | Low/no graph risk reaches fake runner and completes; graph persists. No trace is created because no recorder exists. |
| B — dangerous Agent before Run | PASS | Score 21 pauses before runner call; above deny threshold fails. Covered at [policy-api.test.ts](../apps/server/src/policy-api.test.ts#L159). |
| C — unexpected runtime access | PARTIAL | A direct unauthorized Gateway request is denied and audited, but Codex runtime access is not intercepted. |
| D — indirect Agent risk | FAIL | There is no Agent-to-Agent edge/model, so A calling B cannot propagate B's sensitive capability. |
| E — runaway Agent | FAIL | Timeout/output/container limits exist, but no circuit breaker state or repeated-behavior trigger. |
| F — trace/replay | FAIL | No ordered event trace or replay capability. |

## 14. BROKEN / INCOMPLETE / DEAD CODE

1. **Resolved:** the auth prefix bypass was replaced with matched-route and canonical-path authorization ([app.ts](../apps/server/src/app.ts)).
2. **Resolved:** both whole-Agent and exact-action observation traversal now filter by `agentNodeId` ([knowledge-graph.ts](../apps/server/src/knowledge-graph.ts)).
3. `buildLlmContext()` is implemented but has no call site ([knowledge-graph.ts](../apps/server/src/knowledge-graph.ts#L274)).
4. `JsonGraphStore` is not wired in production; it is a legacy adapter.
5. `Database.graphNodes` and `graphEdges` remain in JSON types/store but are not authoritative or used by production graph services ([store.ts](../apps/server/src/store.ts#L5)).
6. `run` graph node type is never provisioned.
7. Resource Gateway has no frontend client or Codex runner integration.
8. `DemoResourceAdapter` write revisions and credential handles are in memory and disappear on restart.
9. Comment at [app.ts](../apps/server/src/app.ts#L215) says actor identity never comes from body, but `actorHumanNodeId` does.
10. Informational allow/no-capability allow produce no durable SQLite decision, so audit coverage is inconsistent.
11. `AgentService.initialize()` cancels pending Runs but does not expire/reject their durable approvals ([agent-service.ts](../apps/server/src/agent-service.ts#L39)).
12. Agent deletion retains a live-looking Agent graph node and all edges; this is documented as history but lacks tombstone/history UI semantics ([agent-service.ts](../apps/server/src/agent-service.ts#L125)).
13. Graph logical duplicate prevention is read-then-create in application code with no database unique constraint; concurrent writes may duplicate edges.
14. Frontend access preview excludes observation edges while backend scoring includes them ([KnowledgeGraphPanel.tsx](../apps/web/src/KnowledgeGraphPanel.tsx#L231)).
15. Overall graph casts observations to status `actual`, semantically stronger than `observed` ([OverallGraphPanel.tsx](../apps/web/src/OverallGraphPanel.tsx#L104)).
16. Sidebar mislabels `local-process` as ECS/Docker ([App.tsx](../apps/web/src/App.tsx#L399)).
17. `captureKnowledge()` swallows every error without metric/logging, making silent data loss impossible to diagnose ([agent-service.ts](../apps/server/src/agent-service.ts#L399)).
18. `GraphConfigurationService.validateMetadata()` checks only top-level keys, although the SQLite adapter later performs recursive validation. The duplicated rules can diverge.
19. No lint configuration, frontend tests, coverage threshold, load tests, migration-upgrade fixture, or real runtime integration test.
20. Terraform files exist but could not be locally verified because Terraform is absent.

## 15. HACKATHON ALIGNMENT

“Build the missing middleware, not the platform” is satisfied by:

- graph traversal and explainable risk computation;
- a pre-run interception point that changes execution;
- durable policy/approval/claim mechanics;
- exact capability policy in the Gateway prototype;
- observation review and graph-revision invalidation.

These are starter-platform enhancements, not ordinary CRUD polish.

The following do **not** independently prove middleware:

- Network Graph visualization;
- manual permissions represented as edges;
- demo fixture topology;
- prompt regexes without runtime verification;
- ordinary Agent start/stop and timeout;
- Fastify request logs.

The strongest defensible pitch is:

> “Existing Agent launchers know what an Agent is configured to do, but not the downstream impact of that access. We model authority and dependencies separately, traverse the graph before a Run, and pause or deny Codex before it starts when the reachable impact is too high. Decisions and approvals are durable and bound to the exact graph and request.”

Do not currently append “during execution we intercept every action,” “we replay Runs,” or “the circuit breaker stops pathological agents.”

## 16. SCEPTICAL JUDGE REVIEW

**“Isn't this just a graph UI?”**  
No. `AgentService.applyRunPolicy()` calls graph-backed policy before `runner.run()`, and tests prove the runner remains untouched for review/deny. Caveat: after startup, tool behavior is not graph-enforced.

**“Why couldn't I store this in JSON?”**  
You could store direct permissions in JSON. The value is transitive reachability, shortest evidence paths, reverseable topology potential, graph revision binding, and downstream impact. SQLite gives integrity/queryability, but the current implementation still lacks several graph-native queries.

**“Where exactly is the middleware?”**  
The Run boundary is `AgentService.executeRun()` → `applyRunPolicy()` → `KnowledgeGraphRunPolicyGate` → `PolicyService`. The exact-action prototype is `ResourceGateway`, but it is not connected to Codex.

**“What happens differently because it exists?”**  
A high-risk deploy prompt produces score 21 and stops before Codex. A summary prompt runs with score zero. A suspicious prompt with capability pauses even at low risk. A missing exact Gateway capability is denied.

**“Can you show an Agent being stopped?”**  
Yes, before runtime: submit the Release Guardian deploy prompt and reject the approval or set a score above deny threshold. You cannot yet show a real mid-Run shell/tool call being intercepted.

**“What does the graph do that normal RBAC does not?”**  
It links direct authority to downstream dependencies and explains indirect exposure. It does not yet handle Agent-to-Agent transitive privilege or runtime drift.

**“Why does an Agent platform need this?”**  
Because a narrow permission can have wide downstream impact that is invisible in a flat allowlist. The platform can turn that context into an execution decision.

**“What if runtime behavior differs from configuration?”**  
Today, the product generally does not know. Only callers using the separate Gateway create attempted/denied/touched facts. This is the most important missing capability.

**“How is this different from logs?”**  
Policy rows are structured decision evidence, but there is no full flight recorder. Do not claim one.

**“How is this different from max retries?”**  
It is not, because no circuit breaker exists. Timeout/output limits are simple guards.

**“How is blast radius different from counting permissions?”**  
It follows multi-hop dependencies and counts unique reachable risky assets, retaining a shortest path. Its weighting is still simplistic.

### Red-team argument

The harsh critique is partly true: this is RBAC edges plus a graph UI, with a rule-based text learner that trusts claims rather than observed behavior. The runtime retains broad powers; the graph is not a capability sandbox. The action gateway demonstrates a design but not an integrated enforcement boundary. “Live graph” currently means live database state, not live tool telemetry. The authentication and Agent-scoping bugs found during the audit are fixed, but the remaining trust and runtime gaps still limit production claims.

### Steelman

The strongest real implementation is an explainable pre-flight risk gate. Authority cannot be inferred by the LLM, downstream impact is graph-native and transitive, risky Runs truly pause before execution, and approvals are cryptographically bound to the request and graph revision with a transactional one-time claim. That is a coherent, useful middleware slice if presented precisely.

## 17. FEATURES NOT USED TO THEIR FULL POTENTIAL

### Graph

**CURRENT** — forward BFS from exact Agent capabilities over static topology and text observations.  
**↓ PROBLEM** — no reverse queries, Agent delegation, runtime drift, trust weighting, or history.  
**↓ FULL POTENTIAL** — one live ecosystem graph answering “who can reach this?”, “what changed during Run X?”, “what is the shortest escalation path?”, and “which Agents inherit this exposure?”  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — add Agent-scoped runtime `ATTEMPTED` edges from one real tool and a reverse affected-Agent endpoint. Observation scoping is already fixed.

### Resource Gateway

**CURRENT** — strong policy/claim mechanics around simulated HTTP-invoked effects.  
**↓ PROBLEM** — Codex never calls it, so “single execution boundary” is an architectural intention, not reality.  
**↓ FULL POTENTIAL** — broker every protected connector/tool with capability handles and uniform audit.  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — expose one real allowlisted tool, such as `deploy_service` or `read_customer_metadata`, only through the Gateway and have the runtime call it.

### Policy

**CURRENT** — intent regex plus maximum direct-capability surface.  
**↓ PROBLEM** — does not resolve requested action/target; informational mode is instruction-only.  
**↓ FULL POTENTIAL** — exact action plans with constraints, categorical graph rules, and post-action verification.  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — parse a strict `{capability,target}` proposal, validate it server-side, and run informational tasks with a technically read-only sandbox.

### Learned observations

**CURRENT** — rule-based extraction from prompt/final text with evidence and review.  
**↓ PROBLEM** — a user assertion is treated as risk topology immediately; latest evidence replaces prior evidence.  
**↓ FULL POTENTIAL** — fuse tool events, manifests, OpenAPI, deployments, and human confirmation with provenance/trust.  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — quarantine prompt observations until confirmed; allow audited tool observations to affect risk automatically.

### Blast radius

**CURRENT** — additive unique node weights.  
**↓ PROBLEM** — read and write are equal; paths and sensitive data categories do not change severity.  
**↓ FULL POTENTIAL** — operation-specific, confidence-aware, environment-aware impact with hard policy predicates.  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — capability multipliers plus “any write/call path to restricted or production requires review.”

### Approvals

**CURRENT** — durable, expiring, graph/request-bound, one use.  
**↓ PROBLEM** — shared-token operator, no requester/approver separation, no standalone review queue UI.  
**↓ FULL POTENTIAL** — RBAC, assigned approvers, reason/evidence, notifications, revocation, and audit export.  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — two demo identities/roles and forbid self-approval.

### Runner event stream

**CURRENT** — Codex already emits JSON, but most events are discarded.  
**↓ PROBLEM** — the richest telemetry source is unused.  
**↓ FULL POTENTIAL** — flight recorder, drift edges, breaker signals, cost analysis, and step diagnostics.  
**↓ SMALLEST HIGH-IMPACT IMPROVEMENT** — persist sanitized raw event envelopes with a per-Run sequence before building a sophisticated UI.

## 18. MISSING FEATURES / STRONG ADDITIONS

| Addition | Problem solved | Why graph/middleware enables it | Difficulty | Demo value | Effort | Impact | Recommendation |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| One real brokered tool | Proves runtime enforcement | Attempt becomes an edge checked against exact authority/path | Medium | Very high | 3/5 | 5/5 | Build first after P0 fixes. |
| Structured Run event store | Makes behavior explainable/debuggable | Correlates graph/policy/tool changes over time | Medium | Very high | 3/5 | 5/5 | Build alongside broker. |
| Runtime drift detector | Finds undeclared resource use | Compares attempted edge to expected capability graph | Medium | Very high | 3/5 | 5/5 | Strongest graph-native demo. |
| Agent-to-Agent delegation | Supports indirect Scenario D | Graph naturally propagates authority through delegation | Medium | High | 3/5 | 4/5 | Add only with one controlled delegation tool. |
| Small circuit breaker | Stops repeated denied/failed calls | Trace supplies counters; graph supplies blast-radius spike signal | Medium | High | 3/5 | 4/5 | Add after event store. |
| Reverse impact query | Answers affected Agents for asset | Reverse traversal is graph-native | Low | High | 2/5 | 4/5 | Quick judge-visible win. |
| Trust/freshness for observations | Prevents poisoning/stale facts | Provenance/state/confidence become policy inputs | Low–medium | Medium | 2/5 | 5/5 | Required for safe learning. |
| Real identity + role approval | Makes approvals credible | Policy already records principals/events | Medium | Medium | 3/5 | 5/5 | Production-critical; demo can use two fixed roles. |
| LLM structured extraction | Improves language coverage | Produces candidates, never authority | Medium | Medium | 3/5 | 3/5 | Lower priority than runtime evidence. |
| Full deterministic replay | Reproduces failures | Requires captured tools/results/snapshots | Very high | High if real | 5/5 | 3/5 | Do not build for this hackathon. |

## 19. FEATURE SYNERGY

Current interaction:

```text
Configured graph + text observations
            -> blast radius
            -> pre-run allow/review/deny
            -> approval state
            -> Codex starts or does not start

Separate HTTP Gateway
            -> exact graph policy
            -> simulated action
            -> a few audit graph edges

Flight recorder: absent
Circuit breaker: absent
```

Desired interaction:

```text
Prompt -> pre-run policy -> runtime begins
                            |
                            v
                    tool/action requested
                            |
                            v
                 append ordered trace event
                            |
                            v
             create attempted runtime graph edge
                            |
                            v
            exact capability + path-risk policy
                   | allow       | deny
                   v             v
              real adapter    denial event
                   |             |
                   v             v
              touched edge -> breaker counters
                                    |
                      threshold -> cancel Run + OPEN

All events + graph revision + policy result -> explainable timeline/replay input
```

The graph should supply context, policy should decide, the Gateway should enforce, the recorder should prove, and the breaker should react. Today only the first two are joined in the real runtime path.

## 20. P0 / P1 / P2 / P3 ROADMAP

### P0 — before sharing or judging

1. **Completed:** canonicalize/authenticate API paths in [app.ts](../apps/server/src/app.ts) and cover encoded unauthenticated GET/POST requests. Still upgrade `@fastify/static` and all fixable vulnerable dependencies, then rerun the security audit.
2. **Completed:** require `agentNodeId` for observation traversal in [knowledge-observation.ts](../apps/server/src/knowledge-observation.ts), [sqlite-knowledge-observation-store.ts](../apps/server/src/sqlite-knowledge-observation-store.ts), and [knowledge-graph.ts](../apps/server/src/knowledge-graph.ts), with an exact two-Agent regression.
3. Stop unconfirmed prompt observations from affecting enforcement, or quarantine them until review. Never allow a denied prompt to silently alter policy state.
4. Redact/token-scan observation evidence before persistence.
5. Make demo claims precise: pre-run enforcement yes; runtime edge enforcement, recorder, replay, breaker no.
6. Add a deterministic judge smoke script that verifies score 21, summary allow, deploy review, rejection, and database evidence.

### P1 — highest judging return

1. Add `run_events` migration/store with monotonic per-Run sequence and strict event allowlist.
2. Preserve sanitized Codex event envelopes instead of discarding tool-related JSON in [codex-runner.ts](../apps/server/src/codex-runner.ts#L44).
3. Implement one real, allowlisted Resource Adapter and invoke it through the Gateway from a controlled runtime tool.
4. Emit expected/attempted/touched/denied edges and show them in a Run timeline.
5. Demonstrate a requested unauthorized resource being denied mid-Run.
6. Add Playwright coverage for the judge flow and keyboard/modal behavior.

### P2 — deepen graph intelligence

1. Add `DELEGATES_TO`/`CALLS_AGENT` and Agent-to-Agent risk propagation with cycle/depth limits.
2. Add reverse reachability and shortest-dangerous-path endpoints/UI.
3. Add capability/environment/path-confidence weighting and hard categorical rules.
4. Add observation provenance aggregation, aliases, namespaces, last-seen, expiry, and contradiction review.
5. Add a small persistent circuit breaker driven by trace events and graph-risk deltas.
6. Move Runs/messages to SQLite so policy/events have real FKs and transactions.

### P3 — do not build for this hackathon

1. General-purpose graph query language.
2. Full deterministic replay across arbitrary shell/network side effects.
3. Multi-cloud connector marketplace.
4. ML anomaly platform or custom model training.
5. Enterprise multi-tenant policy DSL before one real tool is enforced.

## 21. BEST FINAL ARCHITECTURE

```text
┌──────────────────────────────────────────────────────────────┐
│ UI: Agents | Impact | Approval Queue | Run Timeline          │
└──────────────────────────┬───────────────────────────────────┘
                           v
┌──────────────────────────────────────────────────────────────┐
│ Fastify Control Plane                                        │
│ canonical auth + identity/RBAC + validation + rate limits    │
└──────────────┬───────────────────────────┬───────────────────┘
               │                           │
               v                           v
┌──────────────────────────────┐  ┌────────────────────────────┐
│ Pre-run Policy               │  │ Event Recorder             │
│ graph query + intent/plan    │  │ Run sequence + redaction   │
└──────────────┬───────────────┘  └──────────────┬─────────────┘
               │ ALLOW                           │
               v                                 │
┌──────────────────────────────┐                 │
│ Agent Runtime                │                 │
│ model + controlled tools     │                 │
└──────────────┬───────────────┘                 │
               │ every protected request         │
               v                                 │
┌──────────────────────────────────────────────────────────────┐
│ Resource Gateway                                             │
│ attempted edge -> exact capability -> action blast radius    │
│ -> ALLOW / APPROVAL / DENY -> real adapter -> touched edge   │
└──────────────┬───────────────────────────┬───────────────────┘
               │                           │ events/counters
               v                           v
      Real allowlisted service     ┌───────────────────────────┐
                                   │ Circuit Breaker           │
                                   │ CLOSED/OPEN/HALF_OPEN     │
                                   └───────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ One SQLite DB for Agents/Runs/Graph/Policy/Events/Breaker    │
│ trusted topology separated from scoped observed evidence     │
└──────────────────────────────────────────────────────────────┘
```

This remains hackathon-realistic if scope is one real protected tool, one event timeline, and one breaker trigger. Do not attempt transparent interception of arbitrary shell commands in a day; expose a controlled high-value action and prove the complete middleware loop.

## 22. BEST DEMO FLOW

Target: 4 minutes, deterministic fixture, no hidden manual database edits.

1. **0:00–0:30 — problem and topology.** Open Release Guardian → Impact Map. Show `CAN_WRITE` to deployment config and the path to production/customer data. Say: “A flat permission says it can edit one config; our graph shows that config can affect restricted customer data.”
2. **0:30–1:00 — explain score.** Click Customer dataset and a lower-risk term. Show 4 + 7 + 10 = 21 and focused shortest path. Say exactly that unique assets are counted once and cycles are bounded.
3. **1:00–1:25 — informational request.** Ask “Summarize release readiness responsibilities.” It should run without approval and show informational/zero action risk. Explain that current classifier is deterministic and informational mode is a POC instruction, not a hard tool sandbox.
4. **1:25–2:15 — pre-run enforcement.** Ask “Deploy the release.” Show approval card, factors, and that the runtime has not started. Reject it and show failed/denied state. This proves middleware changes execution.
5. **2:15–3:00 — live knowledge.** Use a controlled sentence such as “Release API reads from Orders database.” Show the dashed observed relationship, exact evidence/confidence, and review controls. Reject it and show it leave risk traversal. Explain that it never grants permission.
6. **3:00–3:35 — durable proof.** Show the policy endpoint or a prepared read-only SQLite query for decision/approval/audit correlation. Avoid scrolling raw secrets or `.env`.
7. **3:35–4:00 — honest boundary and roadmap.** Say: “Today we enforce before Codex starts. The next step is routing one real protected runtime tool through the existing exact-action Gateway so attempted drift is blocked and recorded.”

The two original P0 defects are fixed. Keep the demo on a controlled local or trusted network until the vulnerable dependency chain and remaining identity/runtime boundaries are addressed. If P1 is completed, replace step 6 with a live unauthorized tool request denied in the Run timeline; that is the highest-value final demo.

## 23. QUESTIONS JUDGES WILL PROBABLY ASK

1. **Where is the graph used outside the UI?**  
   **Strong answer:** `AgentService.applyRunPolicy()` calls graph-backed policy before `runner.run()`; score 21 pauses the runtime.  
   **Weak point/caveat:** tool calls after startup are not intercepted.

2. **Is permission inference performed by an LLM?**  
   **Strong answer:** No authority is LLM-inferred. Direct permission suggestions and relationship extraction are deterministic, bounded rules; users confirm authority.  
   **Weak point/caveat:** language coverage is narrow and relationship observations still trust text claims.

3. **What exactly is “learned”?**  
   **Strong answer:** evidence-backed resource relationships from prompts/final replies are persisted, reviewed, and can conservatively extend impact.  
   **Weak point/caveat:** no model is trained and no tool telemetry is learned.

4. **Can an inferred edge grant access?**  
   **Strong answer:** No. Only exact direct authorized Agent-to-asset `CAN_*` edges grant a capability.  
    **Weak point/caveat:** an unconfirmed observation can currently change its owning Agent's risk before human review.

5. **How is blast radius calculated?**  
   **Strong answer:** bounded deterministic BFS, unique risky assets summed once, shortest path retained.  
   **Weak point/caveat:** weights are static and permission/path semantics are not weighted.

6. **Why is Release Guardian 21?**  
   **Strong answer:** deployment config 4 + production service 7 + customer dataset 10.  
   **Weak point/caveat:** those weights are fixture/configuration values, not statistically calibrated risk.

7. **Does a cycle inflate the score?**  
   **Strong answer:** No, visited node IDs prevent loops/double counting; tested.  
   **Weak point/caveat:** traversal fails above fixed 32/64 bounds.

8. **Can Agent A inherit Agent B's access?**  
   **Strong answer:** Not in the current model.  
   **Weak point/caveat:** required indirect-Agent scenario is unsupported; do not claim it.

9. **Can you block a real shell command?**  
   **Strong answer:** We can block the entire Run before Codex starts.  
   **Weak point/caveat:** not an individual shell command once started.

10. **What makes approvals safe from replay?**  
    **Strong answer:** request hash binds policy version, Run, Agent, capability, target, payload, and graph revision; claim is transactional and one-use.  
    **Weak point/caveat:** approver identity is only a shared token.

11. **What happens when the graph changes after approval?**  
    **Strong answer:** claim recomputes the graph revision and rejects mismatch.  
    **Weak point/caveat:** Agent-owned observations are isolated, but intentional shared-topology edits can still invalidate approvals through the graph revision.

12. **Is the Resource Gateway real?**  
    **Strong answer:** Its decision, denial, approval, claim, and audit mechanics are real and tested.  
    **Weak point/caveat:** its adapter is simulated and Codex is not wired to it.

13. **Do you have a flight recorder?**  
    **Strong answer:** No; we have structured policy evidence and Run summaries, which are foundations.  
    **Weak point/caveat:** tool event ordering and reconstruction are absent.

14. **Can you replay a Run?**  
    **Strong answer:** No. We resume conversations and prevent approval replay, but do not replay execution.  
    **Weak point/caveat:** avoid the word replay in the pitch.

15. **Do you have a circuit breaker?**  
    **Strong answer:** No; only timeout/output/resource caps and cancellation.  
    **Weak point/caveat:** repeated failures/denials do not automatically open a breaker.

16. **How do you authenticate approvers?**  
    **Strong answer:** The POC uses one timing-safe bearer token and records a server principal.  
    **Weak point/caveat:** no individual identity/RBAC; the encoded-path bypass is fixed but all operators still share one bearer-token authority boundary.

17. **Can one Agent affect another Agent's graph?**  
    **Strong answer:** Trusted topology is shared intentionally.  
    **Weak point/caveat:** Agent-owned observations are now isolated; intentional Agent-to-Agent delegation is still unsupported.

18. **What happens on restart?**  
    **Strong answer:** SQLite graph/policy state, JSON conversations/Runs, workspaces, and Codex sessions persist; active Runs are cancelled.  
    **Weak point/caveat:** pending approvals can become inconsistent with cancelled JSON Runs.

19. **Why SQLite?**  
    **Strong answer:** self-contained hackathon deployment with FKs, transactions, WAL, immutable migrations, and no external service.  
    **Weak point/caveat:** split JSON/SQLite persistence prevents full referential integrity and scale-out.

20. **What is your single next feature?**  
    **Strong answer:** route one real protected runtime tool through the existing Gateway and persist its ordered attempted/allowed/denied events.  
    **Weak point/caveat:** dependency, identity, and observation-trust hardening still precede any production claim.

## 24. FINAL GO / NO-GO CHECKLIST

- [x] Agent Run actually passes through pre-run middleware when `POLICY_ENFORCEMENT=on`.
- [x] Dangerous Run can be paused or denied before runner start.
- [x] Informational Run can avoid action-risk approval.
- [x] Graph traversal includes multi-hop resource dependencies.
- [x] Cycles and duplicate paths do not double-count assets.
- [x] Blast-radius calculation and paths are explainable.
- [x] Exact direct capability is required by the Resource Gateway.
- [x] Approval is request/graph-bound, expiring, and one-use.
- [x] SQLite migrations work from clean state.
- [x] Live database passes integrity and foreign-key checks.
- [x] Production TypeScript builds pass.
- [x] All current automated tests pass.
- [x] Docker production image builds and service becomes healthy.
- [x] Frontend graph/approval data comes from live APIs, not hard-coded display arrays.
- [x] Encoded API paths cannot bypass authentication; verified for unauthenticated GET/POST against the rebuilt service.
- [x] Agent-owned observations are isolated during traversal; verified by regression and compiled-code reproduction.
- [ ] Unconfirmed/denied-prompt observations cannot poison enforcement.
- [ ] Production dependency audit has no high vulnerabilities.
- [ ] Runtime tool/file/network actions pass through middleware.
- [ ] Denied real runtime action demonstrably fails.
- [ ] Runtime-discovered edges are created from audited tool activity.
- [ ] Agent-to-Agent indirect risk is supported.
- [ ] Flight recorder captures real ordered events.
- [ ] Trace UI can reconstruct a Run timeline.
- [ ] Replay exists (do not claim it).
- [ ] Circuit breaker can automatically terminate and record a runaway Run.
- [ ] Individual requester/approver identity and role separation exist.
- [ ] Observation evidence is redacted and trust/freshness-aware.
- [ ] Frontend has automated browser, accessibility, and responsive tests.
- [ ] Terraform formatting/validation is verified in CI or a machine with Terraform.
- [ ] README clean-clone steps are exercised in CI.
- [ ] Demo is repeatable from a clean seeded state without manual fixes.
- [ ] Product wording distinguishes configuration, textual observation, and actual runtime activity.

**Current go/no-go:** **GO for a controlled hackathon demo of the pre-run graph-risk prototype. NO-GO for a production-security claim or untrusted network exposure** until dependency vulnerabilities, identity/RBAC, observation trust, and per-tool enforcement are addressed.

## 25. FINAL VERDICT

### If submission were in 1 hour

1. Quarantine unconfirmed prompt observations from policy, especially evidence extracted from a denied prompt.
2. Upgrade the vulnerable Fastify/static dependency chain and rerun `npm audit`, tests, build, and Docker smoke checks.
3. Seed/reset a deterministic demo and rehearse the 21-point review flow.
4. Remove every claim of flight recorder, replay, circuit breaker, or integrated runtime-edge enforcement.
5. Keep the new encoded-auth and Agent-isolation regressions in the release gate.

### If submission were tomorrow

Do the one-hour list, then add a `run_events` table and one real protected tool through `ResourceGateway`. Show attempted → policy checked → denied/touched in a Run timeline. Add a read-only mode for informational Runs and a Playwright judge-flow test. This creates the missing proof that actual behavior, not just prompts, is mediated.

### If we had 3 days

Add Agent-to-Agent delegation, reverse impact/shortest-dangerous-path queries, a small persistent circuit breaker driven by trace events, individual demo identities with separation of duty, observation trust/freshness, and move Run/event persistence into SQLite. Do not spend the time on general-purpose replay or broad connector coverage.

### Single most important change

**Route one real Agent tool/action through the Resource Gateway and record its attempted, allowed/denied, and completed events.** The two audit blockers are already fixed; this is now the clearest step from “graph dashboard with a pre-flight gate” to visibly useful runtime middleware.

### Strongest unique feature we can realistically claim

> **An explainable, graph-revision-bound pre-run risk gate that traverses indirect resource dependencies and can pause Codex before execution, with durable expiring approval and a transactional one-time claim.**

That claim is supported by the current architecture and tests. It is technically stronger—and safer—than overstating unfinished runtime tracing or enforcement.
