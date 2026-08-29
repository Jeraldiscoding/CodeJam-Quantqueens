# Graph Governance Implementation Plan

## Purpose

This is the shared implementation contract for the Knowledge Graph / Blast
Radius, GraphStore, and Enforcement workstreams. Its goal is to make the graph
a source of policy decisions that control execution, not a visualization
assembled after a Run.

### Current starter-kit facts

The current application has:

- Fastify routes in apps/server/src/app.ts.
- Agent lifecycle and the call to runner.run() in apps/server/src/agent-service.ts.
- Agent, Message, and Run persistence in APP_DATA_DIR/launchpad.json.
- An AgentRunner abstraction, but no policy engine, identity model, audit
  middleware, graph store, or SQLite dependency.
- A shared bearer token for access; the architecture explicitly says that token
  is not user identity or authorization.

The graph database is new and additive. It must live at
APP_DATA_DIR/middleware.db; launchpad.json remains the owner of existing Agent,
Message, and AgentRun data.

### Critical non-goal

This work does not automatically intercept arbitrary shell commands or
filesystem calls made inside the Codex runtime. A protected action is enforced
only when it passes through the Resource Gateway, such as a protected mock API,
credential vault accessor, or protected file accessor. Never claim an
unwrapped runtime action is protected.

## Decisions locked before implementation

| Topic | Contract |
| --- | --- |
| Canonical Agent ID | Existing Agent.id UUID in launchpad.json. All graph APIs accept this UUID, never a display name. |
| Graph node IDs | Prefix IDs: human:..., agent:..., run:..., resource:..., credential:..., host:.... Edges use graph IDs only. |
| Agent graph node | agent:{Agent.id}. Its metadata contains agent_id with the exact existing UUID. |
| Run graph node | run:{AgentRun.id}. Every activity edge also stores run_id as the existing Run UUID. |
| Risk formula | Sum the risk_weight of every unique reachable protected target. Count a target once, even with multiple paths. |
| Score source | risk_weight is the only v1 scoring input. There are no hidden risk multipliers. |
| Threshold | One injected/configured BLAST_RADIUS_THRESHOLD, default 20. It must not be hard-coded in traversal. |
| Policy decisions | ALLOW, APPROVAL_REQUIRED, or DENY. An approval belongs to exactly one Run and one graph revision. |
| Safe default | Gateway denies a missing/invalid Agent, target, action mapping, or authorized edge. |
| Empty permission set | A valid Agent with no permissions may run harmless work. It is not a pre-run DENY merely for lacking future permissions. |
| Credentials | SQLite, responses, logs, and UI contain credential references only; never values. |

## The graph model

### Nodes

| Type | Required metadata or rule |
| --- | --- |
| human | Stable external ID if one exists. The starter kit has no identity; use an explicitly seeded demo owner. |
| agent | metadata_json.agent_id is the existing Agent UUID. Label mirrors the Agent name but is not an identifier. |
| run | metadata_json.run_id is the existing AgentRun UUID. May include a non-secret policy summary. |
| resource | metadata_json has resource_kind (file or directory) and a canonical protected path/alias. |
| credential | metadata_json.credential_ref is a non-secret vault/reference identifier. |
| external_host | metadata_json.host is the normalized host, with optional base path. |

Every node has:

- id
- type
- label
- risk_level: low, medium, high, or critical
- risk_weight: integer 0 through 100
- classification: public, internal, confidential, or restricted
- metadata_json
- created_at
- updated_at

Suggested initial score weights are low=1, medium=3, high=7, critical=10.
An explicit valid risk_weight on the node is always authoritative.

### Edge vocabulary and exact semantics

Type is the relationship verb; status is the state. They must not be treated as
two independent, arbitrary enums.

| Type | Source -> target | Required status | Meaning |
| --- | --- | --- | --- |
| OWNS | human -> agent | authorized | Accountability/ownership only. It does not grant the Agent authority. |
| CAN_READ | agent -> resource | authorized | Agent may read that protected resource. |
| CAN_WRITE | agent -> resource | authorized | Agent may write that protected resource or directory. |
| CAN_CALL | agent -> external_host | authorized | Agent may call that protected host/API. |
| CAN_USE | agent -> credential | authorized | Agent may use/retrieve that credential through the gateway. |
| TOUCHED | agent -> resource, credential, or host | actual | A gateway-approved protected operation succeeded. Exact action is in metadata. |
| CREATED | agent -> resource | actual | A protected resource was created successfully. |
| ATTEMPTED | agent -> resource, credential, or host | attempted | A protected operation was requested. |
| DENIED | agent -> resource, credential, or host | denied | The gateway refused the requested operation. |

For a denied protected request, create both:

1. ATTEMPTED / attempted
2. DENIED / denied

The rows must share the same run_id, action, request/correlation ID, and target.
They should be inserted transactionally.

For a successful protected request, create:

1. ATTEMPTED / attempted
2. TOUCHED / actual, or CREATED / actual

Never create an actual edge for a denied request. Activity evidence never grants
a new capability and never changes blast radius.

The requested relationship list contains no Agent-to-Run relationship. Do not
quietly invent one. In v1, run:{runId} is an audit/UI node while graph_edges.run_id
is the canonical activity correlation. getEdgesForRun(runId) retrieves that
activity. If a persisted Agent -> Run link becomes necessary later, add a new,
reviewed EXECUTED edge type in one coordinated schema migration.

## Database workstream: Jerome (Maybe supabase?)

### SQLite requirements

Use SQLite in a separate middleware.db, created under config.dataDirectory
(APP_DATA_DIR). Initialize it beside the existing JsonStore in
apps/server/src/index.ts. Do not migrate or duplicate the existing JSON store.

The project currently has no SQLite package. Add and pin one in
apps/server/package.json after the team selects it. Confirm the choice works in
the Node 22 target and the deployed runtime image. Enable foreign keys and WAL
mode. Migrations must be idempotent and tests must use a temporary database,
never .data/middleware.db.

Required tables:

    CREATE TABLE graph_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN
        ('human', 'agent', 'run', 'resource', 'credential', 'external_host')),
      label TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK (risk_level IN
        ('low', 'medium', 'high', 'critical')),
      risk_weight INTEGER NOT NULL CHECK (risk_weight BETWEEN 0 AND 100),
      classification TEXT NOT NULL CHECK (classification IN
        ('public', 'internal', 'confidential', 'restricted')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES graph_nodes(id),
      target_id TEXT NOT NULL REFERENCES graph_nodes(id),
      type TEXT NOT NULL CHECK (type IN
        ('OWNS', 'CAN_READ', 'CAN_WRITE', 'CAN_CALL', 'CAN_USE',
         'TOUCHED', 'CREATED', 'ATTEMPTED', 'DENIED')),
      status TEXT NOT NULL CHECK (status IN
        ('authorized', 'actual', 'attempted', 'denied')),
      run_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_graph_edges_source_status
      ON graph_edges(source_id, status);
    CREATE INDEX idx_graph_edges_run
      ON graph_edges(run_id, created_at);

Add durable decision state. An approval cannot be reliably reconstructed from
edges alone:

    CREATE TABLE run_policy_decisions (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN
        ('ALLOW', 'APPROVAL_REQUIRED', 'DENY')),
      blast_radius INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      graph_revision TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason_detail TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      approved_by_node_id TEXT REFERENCES graph_nodes(id),
      approved_at TEXT,
      approval_note TEXT
    );

The JSON-store Run IDs are application-level foreign keys: SQLite cannot enforce
them because the Run record remains in launchpad.json.

### GraphStore contract

Jerome owns SQL. Everyone else consumes a clean GraphStore API from
apps/server/src/graph-store.ts and shared types; no other module writes SQL or
imports the driver.

The API must cover:

- initialize()
- createNode(input)
- upsertNode(input)
- getNode(id)
- createEdge(input)
- getOutgoingEdges(sourceId, options)
- getEdgesForAgent(agentId, options)
- getEdgesForRun(runId)
- recordAttempt(input)
- recordDenial(input)
- savePolicyDecision(input)
- getPolicyDecision(runId)
- approveRun(input)

Implementation rules:

- Validate graph-ID prefixes, type/status combinations, target-type pairings,
  risk range, and JSON metadata before storing data.
- Parse metadata_json before returning records.
- getEdgesForAgent(agentId) must convert the UUID to agent:{agentId} internally.
- Return deterministic ordering: created_at, then id.
- recordAttempt plus recordDenial must write both audit edges in a single
  transaction.
- Reject credential metadata containing likely secret fields such as secret,
  token, password, or value.
- Never cascade-delete audit history on Agent deletion. Prefer archived metadata
  on the graph node while retaining evidence.

### Jerome implementation checklist

1. Select/pin the SQLite driver, add types and the GraphStore interface.
2. Implement initialization, schema migrations, foreign keys, and WAL.
3. Implement strict node and edge persistence plus indexes.
4. Implement deterministic query methods.
5. Implement transactional activity and policy-decision methods.
6. Initialize the store in index.ts and inject it into graph/policy services.
7. Add temporary-database tests.

### Jerome acceptance tests

- Reopening a database preserves nodes, edges, and policy decisions.
- Unknown source_id or target_id is rejected by foreign keys.
- Bad enum, bad risk weight, bad prefix, and invalid type/status combinations
  are rejected.
- recordAttempt plus recordDenial creates exactly two correlated rows.
- getEdgesForRun returns only that Run's rows in stable order.
- Credential secret values are rejected and never returned.

## Knowledge Graph / blast-radius workstream: Jerald

### Service boundary

Create apps/server/src/knowledge-graph.ts and focused unit tests. It may depend
on GraphStore and graph types only. It must not import Fastify, JsonStore, UI
code, or a SQLite driver.

The public service has these logical outputs:

- getAgentGraph(agentId)
  - agentId and Agent node
  - owner edges
  - authorized capability edges
  - actual-use edges
  - attempted edges
  - denied edges
  - reachable nodes
  - graph revision
- calculateBlastRadius(agentId)
  - agentId
  - score
  - unique reachable protected targets
  - one or more explainable paths to each target
  - graph revision

### Traversal specification

1. Resolve agent:{agentId}. If it is missing or is not type agent, return the
   domain error GRAPH_AGENT_NOT_FOUND. Read methods must not silently create it.
2. Retrieve OWNS edges that target the Agent separately. They are shown for
   accountability and excluded from Agent authority traversal.
3. Start at the Agent and follow only outgoing capability edges with
   status=authorized:
   CAN_READ, CAN_WRITE, CAN_CALL, CAN_USE.
4. Use visited-node and visited-edge sets. Sort before traversal. This prevents
   cycles, double counting, and nondeterministic response order.
5. Set defensive limits of 32 nodes and 64 edges. Exceeding a limit returns
   GRAPH_TRAVERSAL_LIMIT; never label a partial score as complete.
6. Reachable protected targets are resource, credential, and external_host
   nodes reached on those capability edges. Human, Agent, and Run nodes add no
   risk to the score.
7. Add every unique reachable target's risk_weight once. Return all discovered
   paths for a UI explanation of why the score is high.
8. Query actual, attempted, and denied activity independently. Those edges do
   not change reachability or the score.

V1 is deliberately direct Agent capability edges. Do not make OWNS, activity,
or generic graph edges traversable. If delegation is added later, define the
new capability shape, upper bounds, and tests before enabling it.

### Graph revision

A graph revision is required to prevent stale approvals. Compute a deterministic
SHA-256 digest of sorted reachable authorized node/edge fields sufficient to
change a policy decision: IDs, types, statuses, target risk weights, and target
classifications. Persist it with the pre-run decision. On approval, recompute
before runner execution. If it changed, reject the approval and make a fresh
decision.

### Jerald implementation checklist

1. Define output types and domain errors.
2. Implement canonical Agent UUID to graph-node resolution.
3. Implement ownership lookup and independent activity grouping.
4. Implement bounded deterministic authorized traversal.
5. Implement unique scoring and explainable paths.
6. Implement graph revision.
7. Write unit tests against a fake GraphStore, not SQLite internals.

### Jerald acceptance tests

- Two paths to one restricted resource yield one target and one risk
  contribution.
- A TOUCHED or DENIED edge never creates authority.
- OWNS returns the Human owner but adds no score.
- A cycle terminates deterministically.
- A missing Agent node returns GRAPH_AGENT_NOT_FOUND.
- Authorized, actual, attempted, and denied groups do not overlap.

## Enforcement and integration workstream: Malcolm (Maybe?)

### Required state machine

Today, AgentService.sendMessage() creates a Run and immediately schedules
executeRun(), which then calls runner.run(). Change the order so policy runs
after creating the JSON Run plus run graph node but before runner.run().

    create Run + run graph node
               |
               v
    validate graph / calculate score / save decision
               |
    +----------+---------------+
    |          |               |
    v          v               v
    ALLOW   APPROVAL_REQUIRED  DENY
    |          |               |
    v          v               v
    runner   wait for Human    terminal policy error
    runs     approval          and no runner call

Add approval_required to RunStatus and awaiting_approval to AgentStatus.
awaiting_approval is an active state: it blocks a second Run for that Agent and
can be stopped/cancelled. This preserves the existing one-active-run invariant.

A policy result must expose:

- decision: ALLOW, APPROVAL_REQUIRED, or DENY
- blastRadius
- threshold
- reasonCode
- reasonDetail
- graphRevision

### Pre-run decision algorithm

1. Validate integrity: Agent node exists, it has a valid human OWNS edge, and
   every declared authorized capability has an appropriate target type.
   Malformed configuration yields DENY.
2. Calculate blast radius.
3. Score less than or equal to threshold yields ALLOW. Score above threshold
   yields APPROVAL_REQUIRED.
4. A future action lacking permission is not automatically an invalid graph;
   safe work can start. Its protected action will be denied by the gateway.
5. Persist the decision before state changes or runner invocation.
6. Return the decision with the message-submission response so UI does not
   infer policy from polling.
7. Approval verifies: waiting Run, Human node, decision is
   APPROVAL_REQUIRED, and current graph revision equals stored revision. Only
   then update the decision and start that exact Run.

### Resource Gateway

Create a small testable service such as apps/server/src/resource-gateway.ts.
All protected mock API calls, credential retrieval, and protected file actions
must call this service before the underlying action happens.

Gateway input:

- agentId (canonical UUID)
- runId (canonical UUID)
- action: read, write, call, or use_credential
- targetId (prefixed graph ID)
- requestId for correlation

| Action | Required target type | Required edge |
| --- | --- | --- |
| read | resource | CAN_READ |
| write | resource | CAN_WRITE |
| call | external_host | CAN_CALL |
| use_credential | credential | CAN_USE |

Gateway steps:

1. Validate Agent ID, Run ID, action, and target.
2. Record ATTEMPTED with request ID and exact action metadata.
3. Look for an exact authorized Agent -> target edge of the required type.
4. If absent, record DENIED in the same transaction, return
   POLICY_EDGE_MISSING, and do not invoke the underlying operation.
5. If present, invoke the protected operation. On success record TOUCHED or
   CREATED. An underlying operational failure is not a policy denial; record it
   as non-secret metadata or a normal error.

Do not hand raw environment credentials or direct protected mock clients to
Agent/runner integration. Put them behind this gateway. Real Codex shell file
operations are ungoverned until a real tool/MCP boundary routes them through it.

### API contract for the minimal UI

Follow the existing Fastify plus Zod approach in apps/server/src/app.ts.

| Route | Purpose |
| --- | --- |
| GET /api/agents/:id/graph | Return graph groups, reachable nodes, owners, and revision. |
| GET /api/agents/:id/blast-radius | Return score, targets/paths, revision, and configured threshold. |
| GET /api/runs/:id/policy-decision | Return persisted decision, reason, score, threshold, and approval data. |
| POST /api/runs/:id/approve | Validate approverNodeId and optional note; re-check revision, then start the waiting Run. |
| POST /api/runs/:id/deny | Validate approverNodeId and optional note; terminally deny/cancel the waiting Run. |

The current bearer token does not identify an approver. For the POC, the API/UI
must use a seeded demo Human node and explicitly label this as demo identity.

### Malcolm acceptance tests

- Score 17 with threshold 20 calls runner.run() exactly once.
- Score 27 with threshold 20 does not call runner.run(), creates
  approval_required state, and blocks a second Run for that Agent.
- A valid Human approval starts exactly that Run.
- Approval after an authorized graph change fails and does not call runner.run().
- Invalid graph configuration causes terminal DENY and no runner call.
- Unauthorized mock Upload API call records ATTEMPTED plus DENIED and performs
  no side effect.
- Authorized mock Market API call executes and records actual use.

## Integration order and merge boundaries

Implement and merge in this order:

1. Jerome: GraphStore schema, migrations, store types, and tests. Do not
   modify AgentService policy behavior yet.
2. Jerome plus Jerald: seed one demo Human, Agent, resource, credential,
   external host, OWNS edge, and capability edges. Agree on all exact IDs.
3. Jerald: traversal, activity grouping, scoring, graph revision, and tests.
4. Malcolm: policy engine, Resource Gateway, AgentService state changes,
   approval persistence, and API routes.
5. All: UI consumes server results only. It displays graph, score, paths,
   activity groups, decision, and approval action; it never scores or
   authorizes client-side.
6. All: end-to-end restart test and demo rehearsal.

| Owner | Owns | Avoids initially |
| --- | --- | --- |
| Jerald | knowledge-graph.ts, traversal/scoring/revision tests | SQLite SQL and runner changes |
| Jerome | graph-store.ts, SQLite adapter/migrations/tests, initialization wiring | Score semantics and UI policy |
| Malcolm | policy engine, gateway, AgentService integration, policy routes/tests | Changing graph-score rules |
| All | UI after backend contract is stable | Duplicating enforcement in React |

## Definition of done

- middleware.db persists graph/audit/approval data through restart, and existing
  launchpad.json behavior is unchanged.
- Agent ID yields graph, reachable resources, paths, separated activity groups,
  score, and revision from the backend.
- Pre-run decision controls whether runner.run() begins.
- Approval is durable, Human-linked, Run-specific, and revision-bound.
- One protected action succeeds and records actual use.
- One unauthorized protected action is blocked before side effects and records
  both attempted and denied evidence.
- No credential secret appears in SQLite, API responses, logs, snapshots, or UI.
- npm run typecheck and npm test pass at repository root.

## Two-minute demo script

1. Show FinanceAgent's CAN_READ, CAN_WRITE, CAN_CALL, and CAN_USE edges and its
   blast-radius explanation.
2. Start a Run below threshold. Show ALLOW and a Market API action with
   ATTEMPTED plus TOUCHED evidence.
3. Add or raise a high-risk capability. Start a new Run and show
   APPROVAL_REQUIRED before the runner starts.
4. Approve as the seeded demo Human and show that exact Run starts.
5. Attempt Upload API without CAN_CALL. Show ATTEMPTED plus DENIED and prove the
   mock API did not receive a request.

## Remaining team decisions

These must be settled before implementation expands beyond this plan:

1. Which SQLite driver will be pinned for Node 22 and the deployment image:
   a native package or the built-in Node SQLite API at an explicitly pinned
   supported version?
2. Which actions are genuinely protected in the demo? Recommended initial set:
   mock Market API, mock Upload API, credential vault accessor, protected file
   accessor.
3. Which seeded Human node(s) may approve in the demo, given no real identity
   system yet?
4. Is the threshold global as assumed here, or per-Agent as a later policy
   field?
