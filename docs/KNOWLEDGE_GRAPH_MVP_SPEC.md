# Knowledge Graph MVP Specification

## Goal

Build a small, queryable graph that explains an Agent's indirect impact. It is
not only an access-control list: the graph connects an Agent's permitted action
to the systems, data, and classification it can affect.

The graph never invents facts or grants permission through an inferred path.
It finds paths through explicitly stored, typed relationships.

## Core intuition and hackathon fit

The Knowledge Graph is primarily a **relationship-discovery and explanation
engine**, not a visual permission table.

Permissions are only the trustworthy starting point: they answer, “What action
may this Agent attempt directly?” The graph then follows operational facts such
as `DEPLOYS_TO`, `PROCESSES`, and `CONTAINS` to answer the more valuable
question: “What systems, people, and data could that permitted action
indirectly affect?”

```text
Direct authority                  Relationship discovery
Agent --CAN_WRITE--> Config  →    Config → Production → Customer data → PII
```

This preserves the hackathon’s governance problem: an Agent must never gain
authority merely because it is near an important node, but judges can see why a
seemingly ordinary permission creates meaningful downstream risk. The result
is an explainable decision, not an opaque score and not a static JSON ACL.

The demo should communicate this in one sentence:

> “Direct permissions define what the future gateway may enforce, and the graph
> reveals and explains what that action can affect.”

## Demo graph

```text
human:alice --OWNS--> agent:{Agent UUID}
agent:{Agent UUID} --CAN_WRITE--> asset:deployment-config
asset:deployment-config --DEPLOYS_TO--> asset:production-service
asset:production-service --PROCESSES--> asset:customer-dataset
asset:customer-dataset --CONTAINS--> data_category:pii
```

The demo also includes a `CAN_CALL` Release API path that joins production,
plus a staging-service branch that processes only a zero-risk synthetic dataset
containing test data. These extra branches make the visualization a useful
relationship map while keeping the scored production blast radius at 21.

A second demo Agent, Data Steward, is owned by Marcus and has its own direct
`CAN_READ` relationship to the customer dataset. The visualization treats this
as optional peer context so that shared-resource relationships are visible
without obscuring the selected Agent's primary impact path.

These are the only seeded examples. A newly created Agent is provisioned with
its `agent:{UUID}` node only: it has no owner, permission, protected asset, or
impact edge until those facts are explicitly configured. Its initial Blast
Radius is therefore `0 / 20` and the UI must show an empty relationship field,
not reuse a demo topology.

The graph answers: "What could this Agent's permitted configuration change
affect?" The returned path reaches a production service and restricted
customer data containing PII.

## Scope and implementation status

Implemented:

- Explicit node and edge storage.
- Bounded, deterministic impact-path traversal.
- Blast Radius: unique reachable risk-bearing asset weights are summed once.
- A seeded, presentation-only Impact Map and textual explanation.
- SQLite graph persistence, migrations, policy-decision records, approval state,
  and one-time action claims.

Planned integration:

- Direct protected-action checks through a Resource Gateway.
- Automatic Run-correlated attempted, successful, and denied evidence.
- Safe LLM context derived from a Run's graph snapshot.
- Authenticated human approval routes and resumption of an approved action.
- API/SQLite-backed Impact Map data in the Web UI.

Not included:

- Automatic relationship extraction from documents or LLM output.
- Group, team, delegated, or inherited permissions.
- Community detection.
- Arbitrary Codex shell/filesystem interception.
- Real credential values.

## Data model

### Nodes

| Type | Example | Required metadata |
| --- | --- | --- |
| `human` | `human:alice` | stable external/demo owner ID |
| `agent` | `agent:{Agent UUID}` | `agentId`, the existing application UUID |
| `asset` | config, service, dataset | `kind`: `configuration`, `service`, or `dataset` |
| `data_category` | `data_category:pii` | optional category code |
| `run` | `run:{Run UUID}` | `runId`, initiating message reference, graph snapshot |

All nodes have `id`, `type`, `label`, `riskLevel`, `riskWeight`,
`classification`, `metadata`, `createdAt`, and `updatedAt`.

`metadata` is a small, JSON object for future optional fields such as `region`,
`systemOwner`, and `retentionPeriod`. It must contain no secret values. Core
graph logic must not rely on an unvalidated arbitrary metadata field.

### Edges

| Category | Types | Meaning |
| --- | --- | --- |
| Accountability | `OWNS` | Human is accountable for Agent; no authority granted. |
| Permission | `CAN_READ`, `CAN_WRITE`, `CAN_CALL`, `CAN_USE` | Directly permitted Agent action. |
| Asset relationship | `DEPLOYS_TO`, `PROCESSES`, `CONTAINS` | Explicit downstream impact relationship. |
| Audit | `ATTEMPTED`, `TOUCHED`, `DENIED` | Run-correlated operation evidence; no authority granted. |

All edges have `id`, `sourceId`, `targetId`, `relation`, `status`, optional
`runId`, `metadata`, and `createdAt`.

## Rules

### Planned Resource Gateway contract

When the Resource Gateway is implemented, it must require a live, eligible
platform Agent, a Run owned by that Agent, an authenticated actor, and this
exact direct edge:

```text
agent:{id} --CAN_WRITE/authorized--> target asset
```

Ownership, an impact path, previous successful activity, and nearby nodes do
not imply a permission.

### Impact traversal

The Knowledge Graph service begins at `agent:{id}` and follows this exact
sequence:

```text
agent --authorized CAN_*--> asset --DEPLOYS_TO/PROCESSES/CONTAINS--> downstream node
```

Only outgoing edges are used. Audit and `OWNS` edges are excluded. Traversal is
deterministic, cycle-safe, and capped at 32 nodes / 64 edges. Exceeding a cap
returns an error rather than a misleading partial answer.

The Blast Radius score adds the `riskWeight` of every unique reachable `asset`
once. `data_category` explains the classification but has a risk weight of
zero, avoiding double-counting customer data and its PII label.

The current threshold is 20. A score above it returns `REVIEW_REQUIRED`;
otherwise it returns `ALLOW`.

### Planned Run and LLM context integration

The full user prompt remains in the existing Message store. The reserved Run
graph node may hold only an initiating message ID and a safe graph-context
snapshot. A future server integration may send that short context to the LLM
with the prompt, but policy enforcement must remain in backend code.

## GraphStore contract for persistence

**Database decision for this hackathon: use SQLite.** It is the best fit for a
single deployed demo, needs no hosted account or network dependency, and keeps
the graph queryable with real relational persistence. Supabase is a later
alternative only if the team specifically needs a shared hosted database.

The Knowledge Graph only depends on this TypeScript contract:

```ts
interface GraphStore {
  getNode(id: string): Promise<GraphNode | null>;
  getOutgoingEdges(sourceId: string, filter?: EdgeFilter): Promise<GraphEdge[]>;
  getIncomingEdges(targetId: string, filter?: EdgeFilter): Promise<GraphEdge[]>;
  getEdgesForRun(runId: string): Promise<GraphEdge[]>;
  createNode(node: GraphNode): Promise<void>;
  createEdge(edge: GraphEdge): Promise<void>;
  upsertNode(node: GraphNode): Promise<void>;
  upsertEdge(edge: GraphEdge): Promise<void>;
}
```

`EdgeFilter` supports `relations` and `statuses`. Query results must be sorted
by `createdAt`, then `id`. The persistence layer validates IDs, known relation
and status combinations, metadata JSON, risk weights 0–100, and rejects likely
credential-secret keys.

`upsertNode` and `upsertEdge` are required for Agent synchronization. They
must be idempotent: synchronizing an existing Agent refreshes the same node and
relationships rather than duplicating them.

## SQLite persistence foundation

`SqliteGraphStore` is the application `GraphStore` for the POC. It persists
graph nodes and edges in `APP_DATA_DIR/middleware.db`; graph services,
configuration, Agent lifecycle, and route shapes remain adapter-independent.
`JsonGraphStore` remains a legacy reference and is not authoritative at
runtime.

`SqliteGovernanceStore` also implements durable policy decisions, approval
transitions, and single-use execution claims. It is tested in isolation but is
not yet constructed by server startup or exposed through routes. A trusted
`PolicyService` and Resource Gateway must be added before this persistence
foundation becomes operational approval middleware.

Useful existing code:

| File | Responsibility to preserve |
| --- | --- |
| `apps/server/src/graph-types.ts` | canonical node, edge, filter, and `GraphStore` types |
| `apps/server/src/knowledge-graph.ts` | deterministic traversal and Blast Radius calculation |
| `apps/server/src/graph-configuration.ts` | validates explicit relationship authoring |
| `apps/server/src/agent-graph-provisioner.ts` | creates an Agent graph identity and demo facts |
| `apps/server/src/sqlite-graph-store.ts` | authoritative graph persistence adapter |
| `apps/server/src/sqlite-governance-store.ts` | policy, approval, and claim persistence adapter |
| `apps/server/src/json-graph-store.ts` | legacy local reference adapter |
| `apps/server/src/app.ts` | server graph routes that the frontend/integration can consume |

### SQLite database invariants

The application creates `middleware.db` under `APP_DATA_DIR` using the pinned
Node 22-compatible `better-sqlite3` runtime dependency. It enables foreign keys,
WAL mode, a busy timeout, and idempotent numbered migrations. Applied migrations
are immutable and checksum-verified; schema changes require a new higher-numbered
migration.

`graph_nodes` and `graph_edges` use the fields in the data model.
`graph_edges.source_id` and `graph_edges.target_id` must reference
`graph_nodes.id`; add indexes on `(source_id, status, created_at)`,
`(target_id, status, created_at)`, and `(run_id, created_at)`. Store metadata
as JSON text and preserve ISO timestamps. Query results must always be ordered
by `created_at`, then `id`.

The database enforces or the adapter validates:

- known node types, edge relations, statuses, classifications, and risk levels;
- risk weights from 0 through 100;
- valid JSON metadata with no likely secret fields;
- both edge endpoints exist;
- the allowed relation/source/target combinations in the configuration flow.

The governance migration also creates `policy_decisions`, `approval_requests`,
`approval_events`, and `policy_action_claims`. The governance adapter binds a
claim to the same operation ID and SHA-256 request hash, uses a server-side
clock for expiry, and consumes an approved review only once.

### Verified wiring and boundaries

- `middleware.db` initializes before `AgentService.initialize()`.
- Startup constructs `SqliteGraphStore` and injects it into graph services and
  `DemoAgentGraphProvisioner`.
- Existing Agents are reconciled into SQLite; demo topology is added only when
  the corresponding demo Agents exist.
- Legacy non-demo JSON graph facts are not imported automatically.
- Database and graph API tests use temporary file-backed SQLite databases,
  never the developer's real `APP_DATA_DIR/middleware.db`.
- `SqliteGovernanceStore` is implemented and tested but remains intentionally
  unwired until a trusted policy/gateway layer supplies Run ownership, policy
  provenance, live-Agent eligibility, authenticated approvers, request hashing,
  and audit emission.
- The current Web Impact Map is seeded presentation data and does not call the
  graph API; that frontend integration remains planned.

The current routes are ready and should retain their behaviour:

| Route | Meaning |
| --- | --- |
| `GET /api/agents/:id/graph` | explainable Agent graph: owners, direct capabilities, reachable nodes, edges, and paths |
| `GET /api/agents/:id/blast-radius` | score, threshold, decision, and scored targets |
| `POST /api/graph/nodes` | create an explicit human, asset, or data-category fact |
| `POST /api/agents/:id/graph/relationships` | add an explicit, validated relationship in that Agent’s connected graph |

Do not let the LLM write directly to either table. It may return a suggested
configuration draft, but a human or trusted integration submits approved facts
through the server API.

Agent creation and Agent name updates both synchronize the corresponding graph
node. The initial synchronisation creates identity only for normal Agents; a
later configuration flow is responsible for adding ownership, capability, and
asset-relationship edges.

### Configuration flow

The server exposes a deliberately explicit authoring flow:

1. `POST /api/graph/nodes` creates a human, asset, or data-category node.
2. `POST /api/agents/:id/graph/relationships` creates an approved relationship
   for that Agent's connected subgraph.

Only `OWNS`, `CAN_*`, `DEPLOYS_TO`, `PROCESSES`, and `CONTAINS` are writable.
Capabilities must run from the selected Agent directly to an asset. Downstream
relationships must start at an already reachable asset, so a user cannot join
unrelated systems into an Agent's graph accidentally. `ATTEMPTED`, `TOUCHED`,
and `DENIED` are reserved for future backend-generated audit evidence only.

An LLM may propose this configuration as a draft, but cannot create or approve
an edge. A human or trusted infrastructure integration must submit the final
relationship fact.

### Startup wiring

After initializing the persistent `GraphStore`, construct
`DemoAgentGraphProvisioner(graphStore)` and pass it as the final argument to
`AgentService`. The service then provisions the graph after every new Agent is
created and reconciles all existing Agents during startup. No endpoint needs to
know which persistence implementation is in use.

## Implemented API

| Route | Result |
| --- | --- |
| `GET /api/agents/:id/graph` | nodes, edges, owner, capabilities, activity groups, and impact paths |
| `GET /api/agents/:id/blast-radius` | score, threshold, decision, scored assets, and explainable paths |

## Planned protected-action API

The Resource Gateway will need a protected-action route plus decision lookup,
approval, and rejection routes. Those routes must derive actor identity and
timestamps on the server, verify the Agent is still live and eligible, verify
Run ownership, and correlate decisions with `ATTEMPTED`, `TOUCHED`, and
`DENIED` graph evidence.

## Minimum acceptance tests

- The demo graph produces the Agent → config → service → dataset → PII path.
- The calculated score is 21 for the seeded risk weights 4, 7, and 10.
- Audit edges do not grant authority or alter the score.
- A cycle does not loop or double-count an asset.
- Multiple direct capabilities to the same asset do not double-count it.
- SQLite migrations, foreign keys, approval expiry, operation idempotency, and
  one-time claims are covered by temporary file-backed tests.

Future Resource Gateway acceptance must additionally prove that a missing exact
capability is denied, high-risk execution pauses for approval, rejection and
expiry prevent execution, and attempt/outcome evidence shares the correct Run
and policy decision correlation.
