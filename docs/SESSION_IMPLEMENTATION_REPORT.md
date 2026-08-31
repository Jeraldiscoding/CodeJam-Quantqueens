# Session Implementation Report

> **Historical before-state report.** The counts and capability gaps below
> describe the graph session at that point in time and are intentionally
> retained as engineering history. For current executable behavior and known
> limits, use [Architecture](ARCHITECTURE.md) and
> [Current Weaknesses](CURRENT_WEAKNESSES.md).

Date: 2026-08-31  
Branch reviewed: `policy-enforcement`  
Status: implemented and verified locally; the changes are not committed by this report.

## What changed

This session turned the Knowledge Graph from a manually configured permission
catalog into two deliberately separate layers:

```text
TRUSTED AUTHORITY (explicit)                 LEARNED KNOWLEDGE (automatic)

Agent --CAN_READ/CAN_WRITE/...--> Asset      Asset --READS_FROM/CALLS/...--> Asset
             |                                             |
             | grants authority                            | adds risk context
             |                                             | never grants authority
             +------------------- traversal ----------------+
```

The separation is the most important safety property in the implementation.
An inferred relationship can make a policy decision more cautious, explain a
dependency, and extend a focused path. It cannot create `OWNS`, `CAN_READ`,
`CAN_WRITE`, `CAN_CALL`, or `CAN_USE`.

The session also added intent-aware approval handling, explainable blast-radius
factors and paths, an overall network graph, user-facing Agent summaries,
prompt-assisted access configuration, observation review controls, and an ARM-
compatible Docker build.

## Is the inference built by the LLM?

No. The current relationship extractor is deterministic TypeScript code, not
an LLM call.

There are three different pieces that can look like “AI inference,” but their
implementations are different:

| Behaviour | Current implementation | Uses an LLM? |
| --- | --- | --- |
| The Agent writes its reply | The configured Codex/Ark Agent runner | Yes |
| Prompt intent: informational, action, or suspicious | Ordered regular expressions and conservative fallback rules in [`prompt-intelligence.ts`](../apps/server/src/prompt-intelligence.ts) | No |
| Direct resource/access suggestion | Resource keywords, action verbs, and classification keywords in [`prompt-intelligence.ts`](../apps/server/src/prompt-intelligence.ts) | No |
| Semantic graph relationship extraction | Sentence patterns in [`knowledge-observation.ts`](../apps/server/src/knowledge-observation.ts) | No |
| Risk calculation and focused paths | Deterministic breadth-first graph traversal in [`knowledge-graph.ts`](../apps/server/src/knowledge-graph.ts) | No |

The system scans both the original user prompt and the completed LLM reply. The
reply is LLM-produced, but the relationship stored from that reply is still
selected by the same rule-based extractor. There is no second LLM extraction
call, embedding search, knowledge-model training, or model-weight update.

This design was chosen because its behaviour is bounded, cheap, inspectable,
and testable. It also prevents an LLM from directly inventing permissions. Its
trade-off is limited language understanding: it handles explicit statements
well, but not pronouns, implied relationships, contradictions, or complicated
multi-sentence reasoning.

In this version, “learning” means **persisting evidence-backed graph facts**, not
training a machine-learning model.

## What the automatic learner understands

The extractor currently recognizes these learned relations:

- `DEPLOYS_TO`: “Release API deploys to Production service.”
- `READS_FROM`: “Checkout API reads from Orders database.”
- `CALLS`: “Orders database calls Fraud service.”
- `DEPENDS_ON`: “Billing service depends on Customer database.”
- `PROCESSES`: “Payments service processes customer records.”
- `CONTAINS`: “Customer dataset contains personal information.”

Each matching sentence becomes an observation containing:

- source node and target node;
- relation type;
- confidence score;
- the exact evidence sentence, limited to 500 characters;
- whether it came from a user prompt or Agent reply;
- the source Run ID when available;
- review state: `observed`, `confirmed`, or `rejected`;
- creation and update timestamps.

The service reuses an existing node when its type and case-insensitive label
match. Otherwise, it creates a new inferred node. Classification and initial
risk defaults are derived from keywords:

| Classification | Default risk |
| --- | --- |
| `public` | low, 0 points |
| `internal` | low, 2 points |
| `confidential` | high, 7 points |
| `restricted` | critical, 10 points |

`data_category` nodes explain what data is present but carry zero risk weight;
risk is scored on reachable asset nodes.

## End-to-end data flow

When a user sends a message:

1. [`AgentService`](../apps/server/src/agent-service.ts) saves the message and Run.
2. The prompt is sent to `KnowledgeObservationService`. A learning failure is
   intentionally non-fatal and cannot fail the Agent Run.
3. Explicit relationship sentences are extracted. Matching graph nodes are
   reused or created, and observations are upserted into SQLite.
4. The pre-run gate classifies the prompt intent.
5. Informational prompts run without blast-radius approval and receive an
   explanation-only runtime instruction. Action prompts are evaluated against
   the graph. Suspicious prompts force human review when a protected capability
   exists, and are denied when none exists.
6. For an action, the gate calculates the largest downstream impact among the
   Agent's explicit direct capabilities. This is the maximum operation the Run
   could perform with its current authority.
7. If the Run executes, the Agent reply is scanned by the same relationship
   extractor and any new evidence is persisted.
8. The Agent graph and overall graph APIs return explicit edges and learned
   observations as separate collections.
9. The UI draws learned edges with a dashed style and exposes confidence,
   evidence, provenance, and Confirm/Reject controls.

The prompt is observed before the policy decision. That means a rejected or
blocked prompt may still contribute a non-authorizing observation. This is
useful for audit and attempted-activity context, but it also means production
hardening should add trust controls against graph-poisoning attempts; see
[What is still missing](#what-is-still-missing).

## How risk and focused paths work

Traversal always begins with a stored, authorized Agent capability:

```text
Agent --CAN_*--> directly permitted asset
                    |
                    +-- trusted topology edge
                    +-- non-rejected learned observation
```

Disconnected learned relationships do not affect that Agent. A learned edge
only contributes when its source can already be reached from explicit
authority.

Traversal is breadth-first, deterministic, and bounded to 32 nodes and 64
edges. The first shortest path found for each node is retained. The blast
radius is the sum of each unique reachable risk-bearing asset once, so cycles
and multiple paths do not double-count an asset.

For Release Guardian, the seeded score of 21 is:

```text
Deployment configuration  4
Production service         7
Customer dataset          10
                         ----
Total                     21
```

The graph initially focuses the scored asset with the highest individual risk
weight. For Release Guardian that is Customer dataset at 10 points. Selecting
another term in the score equation changes the focus. The highlighted path is
the stored Agent permission followed by the deterministic shortest chain of
trusted topology and non-rejected learned relationships to that selected
asset.

Both `observed` and `confirmed` relationships currently participate in risk
traversal. A `rejected` relationship remains in the audit record but is
excluded from traversal and display paths.

## Approval behaviour

The pre-run gate now treats prompts differently according to intent:

- Explanation, summary, and question-only prompts are allowed with risk score
  zero. The runtime is instructed not to make changes and to keep the answer
  focused on the Agent's user-facing purpose.
- Action prompts are evaluated using graph permissions and downstream risk.
- Suspicious prompts, such as attempts to bypass controls or reveal secrets,
  require review when the Agent holds a protected capability. With no
  protected capability, they are denied.
- Unclear prompts default to action rather than being assumed informational.

Approvals are bound to the Run, hashed prompt payload, capability, target, and
the current graph revision. The revision includes non-rejected observations,
so changing relevant learned knowledge invalidates an approval made for the
older graph. Approved claims are single use.

One current simplification is that the pre-run gate scores the most exposed
direct capability rather than perfectly matching the exact requested action
and resource. The lower-level Resource Gateway supports exact capability and
target checks, but full per-tool enforcement is future work.

## SQLite implementation

The live local database is created at [`data/middleware.db`](../data/middleware.db)
when Docker Compose runs. The container maps `./data` to `/app/data`; it is not
using `apps/server/.data/middleware.db` in this Compose setup.

The migration sequence is:

| Version | Migration | Main responsibility |
| --- | --- | --- |
| 1 | `create_graph_store` | `graph_nodes`, explicit `graph_edges`, indexes, constraints |
| 2 | `create_policy_and_approval_store` | decisions, approvals, events, one-time action claims |
| 3 | `create_graph_observation_store` | learned relations, confidence, evidence, provenance, review state |

The `graph_observations` table has a uniqueness constraint on Agent, source,
target, and relation. Repeated evidence updates provenance and keeps the
highest confidence instead of creating duplicate edges. The upsert does not
silently reset a human-reviewed state, so later matching text does not revive a
rejected observation.

The application uses parameterized SQLite statements, strict tables, foreign
keys, value checks, indexes, and immutable checksum-verified migrations.

## Frontend behaviour

The Agent Impact Map now shows:

- the live Agent graph and blast-radius total;
- a clickable risk-factor equation;
- the reason a path is focused and how the path was chosen;
- trusted edges as solid lines and learned relationships as dashed lines;
- learned observation confidence, prompt/reply origin, evidence, and state;
- inline Confirm and Reject actions;
- a clear statement that learned relationships may affect risk but do not grant
  permission.

The overall Network Graph shows all stored nodes and both relationship layers,
so cross-system connections are visible outside a single Agent view. Graph
nodes and score factors are keyboard operable, focus states are visible, and
the layout has responsive variants. The implementation was reviewed for the
critical distinction between trusted authority and inferred evidence.

## Verification performed

The following checks were run by Codex in this workspace on 2026-08-31:

| Check | Result |
| --- | --- |
| Server and web TypeScript typecheck | Passed |
| Server automated suite | **17 test files passed, 82 tests passed** |
| Web production build | Passed |
| Server production build | Passed |
| Full `npm run check` | Passed |
| Git whitespace/error check | Passed |
| Live SQLite migrations | Versions 1, 2, and 3 present |
| Live SQLite foreign-key check | Passed; no violation rows returned |
| Docker production image rebuild | Passed |
| Docker Compose health check | `launchpad` is healthy on port 3000 |
| Live authenticated `/api/agents/:id/graph` | HTTP OK; observation field present |
| Live authenticated `/api/graph` | HTTP OK; observation collection present |

## Post-audit remediation: authentication and Agent isolation

The full audit found two release-blocking defects. Both were first captured by
regression tests that failed against the old implementation, then fixed and
verified through the complete build and production-like checks.

### 1. Encoded API routes can no longer bypass authentication

The old Fastify authentication hook checked the raw request string with
`startsWith("/api/")`. Fastify would later decode a path such as
`/%61pi/agents` and route it to `/api/agents`, but the raw prefix check did not
recognize it as an API request. That allowed the route to run without the
bearer-token check.

[`app.ts`](../apps/server/src/app.ts) now determines protection from Fastify's
matched route and a bounded canonical pathname fallback. The fallback decodes
the path safely, normalizes backslashes and repeated separators, and treats a
malformed encoding as non-canonical instead of throwing. Public `/api/health`
and `/api/auth` handling uses the same matched/canonical values.

[`app.test.ts`](../apps/server/src/app.test.ts) now verifies:

- unauthenticated encoded GET is `401`;
- unauthenticated encoded POST is `401`;
- the same encoded GET succeeds with the valid bearer token.

The production Docker image was rebuilt and the same live probes returned
`401`, `401`, and `200` respectively. A normal unauthenticated `/api/agents`
request also remains `401`.

### 2. Learned relationships remain owned by their Agent

Trusted catalog topology is intentionally shared, but a prompt-derived
observation belongs to the Agent that supplied the evidence. Previously,
traversal queried observations by source node and state only. If Agent A and
Agent B could both reach the same API node, Agent A's learned downstream edge
could incorrectly enter Agent B's blast radius.

The observation-store contract now requires both `agentNodeId` and
`sourceNodeId`. [`sqlite-knowledge-observation-store.ts`](../apps/server/src/sqlite-knowledge-observation-store.ts)
filters on both columns, and [`knowledge-graph.ts`](../apps/server/src/knowledge-graph.ts)
passes the active Agent into exact-action and whole-Agent traversal. This is a
database-enforced query boundary, not an LLM instruction or frontend filter.

[`knowledge-observation.test.ts`](../apps/server/src/knowledge-observation.test.ts)
creates two Agents with access to one shared API, adds a learned relationship
for Agent A only, and proves that only Agent A follows it. A separate run using
the compiled production classes produced:

- Agent A score: `11` — shared API weight `1` plus its learned dependency `10`;
- Agent B score: `1` — shared API only, with no contribution from Agent A's
  observation.

After both changes, `npm run check` passed all **82 tests**, both workspace
typechecks, and both production builds. Docker Compose rebuilt the application
and reported the service healthy on port 3000.

The final repeat run also exposed and fixed a flaky integration-test timing
assumption: policy and observation tests now poll for the expected Run state
instead of sleeping for a fixed 60–80 milliseconds. This makes the tests
reliable on slower or concurrently loaded machines without weakening their
assertions.

A new full-stack HTTP integration test lives in
[`knowledge-observation-api.test.ts`](../apps/server/src/knowledge-observation-api.test.ts).
It boots the real Fastify application against a temporary SQLite database and a
controlled fake Agent runner. It verifies this exact lifecycle:

1. create an Agent and a single explicit `CAN_CALL` permission;
2. infer `Checkout API READS_FROM Orders database` from the user prompt;
3. infer `Orders database CALLS Fraud service` from the Agent output;
4. return evidence and confidence through the observation API;
5. return learned edges through both graph APIs;
6. calculate a blast radius of 4 through the learned chain;
7. confirm the observation without changing the score;
8. reject it and observe the score fall to 0;
9. prove that the Agent still has exactly one explicit capability throughout.

The integration test uses a temporary database and deletes it after the test.
The authenticated live API check was read-only and did not add mock data to the
user's database.

The production frontend was typechecked and built, and its interaction and
accessibility implementation was audited in source. There is not yet an
automated real-browser visual regression test, so pixel-level rendering across
browsers remains an explicit gap.

## Main implementation files

| File | Purpose |
| --- | --- |
| [`knowledge-observation.ts`](../apps/server/src/knowledge-observation.ts) | deterministic relationship extraction and node creation |
| [`sqlite-knowledge-observation-store.ts`](../apps/server/src/sqlite-knowledge-observation-store.ts) | SQLite observation persistence and state transitions |
| [`middleware-migrations.ts`](../apps/server/src/middleware-migrations.ts) | all three immutable database migrations |
| [`knowledge-graph.ts`](../apps/server/src/knowledge-graph.ts) | traversal, scoring, paths, capabilities, graph revision |
| [`prompt-intelligence.ts`](../apps/server/src/prompt-intelligence.ts) | intent, direct-access, and classification heuristics |
| [`run-policy-gate.ts`](../apps/server/src/run-policy-gate.ts) | informational/action/suspicious run decisions |
| [`policy-service.ts`](../apps/server/src/policy-service.ts) | durable decisions, approval binding, expiry, and claims |
| [`agent-service.ts`](../apps/server/src/agent-service.ts) | captures prompt/output observations and controls Run lifecycle |
| [`app.ts`](../apps/server/src/app.ts) | graph, observation, review, and policy HTTP routes |
| [`app.test.ts`](../apps/server/src/app.test.ts) | API authentication, including encoded-path bypass regression coverage |
| [`KnowledgeGraphPanel.tsx`](../apps/web/src/KnowledgeGraphPanel.tsx) | per-Agent impact, focus path, and observation review UI |
| [`OverallGraphPanel.tsx`](../apps/web/src/OverallGraphPanel.tsx) | whole-network visualization |
| [`App.tsx`](../apps/web/src/App.tsx) | approval experience and prompt-assisted access confirmation |
| [`knowledge-observation-api.test.ts`](../apps/server/src/knowledge-observation-api.test.ts) | end-to-end learning and authority-isolation verification |
| [`knowledge-observation.test.ts`](../apps/server/src/knowledge-observation.test.ts) | extraction, review-state effects, and two-Agent observation isolation |

## What is still missing

### Recommended next sprint

Do these items in sequence because each one creates the evidence or safety
boundary needed by the next:

- [ ] **Quarantine unconfirmed observations.** Store them for review, but do
  not let a prompt—especially a denied prompt—change enforcement until it is
  confirmed or assigned an explicit low-trust policy effect.
- [ ] **Remediate dependencies.** Upgrade the fixable Fastify/static and
  transitive packages, then rerun `npm audit --omit=dev`, `npm run check`, the
  encoded-path probes, and the Docker health check.
- [ ] **Build one real mediated action.** Choose one narrow tool such as
  `read_customer_metadata` or `deploy_service`, expose it only through the
  Resource Gateway, and prove an unauthorized target cannot be reached.
- [ ] **Persist an ordered Run timeline.** Add `run_events` with monotonic
  per-Run sequence numbers and record requested, attempted, policy-checked,
  denied, completed, and failed events from the mediated action.
- [ ] **Add a browser judge-flow test.** Cover informational allow, risky
  approval, rejection, focused graph path, observation review, and keyboard
  operation in one deterministic Playwright scenario.

The next sprint is complete when a clean Docker deployment can demonstrate a
real tool request being denied and recorded, while the existing 82-test suite,
encoded-path authentication test, and two-Agent isolation test remain green.

### Highest priority

1. **Per-tool enforcement.** The pre-run gate protects a Run before it starts,
   but arbitrary Codex file, shell, network, or connector actions are not yet
   intercepted individually. Every real external operation should pass through
   a Resource Gateway that checks the exact `CAN_*` relation and target.
2. **Real user identity and RBAC.** The current deployment uses an application
   token. Production approval needs authenticated human identities, roles, and
   separation between requester and approver.
3. **Observation trust and graph-poisoning controls.** User prompts can add
   observations before policy evaluation, and `observed` facts immediately
   affect risk. Add origin trust levels, rate limits, moderation, quarantine,
   or require confirmation before low-trust evidence affects enforcement.
4. **Hybrid semantic extraction.** Keep the deterministic rules as a safe
   high-confidence path, then optionally ask an LLM for structured relationship
   candidates using a strict JSON schema. Validate relation allowlists, node
   types, quoted evidence, confidence, and limits on the server. An LLM
   candidate must still never create `OWNS` or `CAN_*`.

### Product and data quality

5. Add node aliasing, merge/edit controls, a rejected-observation history,
   pruning, and confidence decay so spelling variations and stale facts do not
   clutter the graph.
6. Add contradiction detection and evidence aggregation. Multiple independent
   observations should be visible instead of only retaining the latest
   evidence text for a deduplicated relationship.
7. Ingest stronger evidence sources such as audited tool-call events, OpenAPI
   schemas, deployment metadata, repository manifests, and data catalogs.
8. Add more relations such as `WRITES_TO`, `SENDS_TO`, and `USES`, plus entity
   and pronoun resolution for less explicit language.
9. Decide whether `observed` and `confirmed` facts should have different policy
   weight. They currently affect traversal equally; a safer product may make
   unconfirmed facts trigger review without treating them as fully trusted.
10. Replace worst-capability pre-run scoring with requested-action and
    requested-resource resolution, while preserving fail-closed behaviour when
    the request is ambiguous.

### Testing and operations

11. Add Playwright browser tests for create-Agent, prompt suggestion,
    approval, focused-path selection, observation confirmation/rejection,
    responsive layouts, and keyboard navigation.
12. Add migration upgrade tests against copied production-like databases,
    backup/restore documentation, retention rules, and concurrency/load tests.
13. Audit and remediate the dependency issues reported by `npm audit` rather
    than changing dependencies blindly during feature work.
14. Connect the Resource Gateway to real protected services; the current flow
    proves policy mechanics but is not a complete production authorization
    boundary.

### Longer-term audit roadmap

15. Add a durable `run_events` table with ordered, sanitized events and a Run
    timeline. Preserve useful Codex tool envelopes instead of discarding them;
    this is the foundation for a real flight recorder.
16. Add a small persistent circuit breaker driven by repeated denials,
    failures, timeout events, or sudden graph-risk changes. Record open,
    half-open, and closed transitions rather than claiming current resource
    limits are a breaker.
17. Model intentional Agent-to-Agent relations such as `DELEGATES_TO` or
    `CALLS_AGENT`, then add bounded indirect-risk traversal and reverse-impact
    queries. Agent observation ownership must remain intact.
18. Move Runs and messages from JSON into SQLite so graph, policy, approval,
    and event records can use real foreign keys and transactions.
19. Add rate limiting, observation-evidence redaction, safer client error
    responses, identity-bound approver attribution, and an explicit egress
    policy for child runtimes.
20. Fix the frontend audit gaps: modal dialog semantics and focus trapping,
    keyboard-complete tabs, non-hover edge evidence, larger touch targets,
    consistent design tokens, and complete reduced-motion handling.
21. Add CI checks for a clean-clone Docker smoke test, dependency audit,
    migration upgrades, Terraform validation, and a deterministic seeded judge
    flow. Keep claims limited to pre-run enforcement until a real runtime tool
    is mediated and recorded.

## Useful verification commands

These are recorded for reproducibility; the checks above have already been run.

```bash
npm run check
docker compose config --quiet
docker compose up --build -d
docker compose ps
sqlite3 -readonly data/middleware.db \
  "SELECT version, name FROM schema_migrations ORDER BY version; PRAGMA foreign_key_check;"
```

With a healthy Compose deployment, the expected migration rows are versions 1,
2, and 3. `PRAGMA foreign_key_check` should print nothing. `docker compose ps`
should show the `launchpad` service as healthy.
