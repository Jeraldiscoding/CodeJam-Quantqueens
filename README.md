# QuantQueens Agent Safety Middleware

A graph- and history-informed enforcement layer for Agent systems, built on the
Volc Agent Launchpad starter. It provides Agent CRUD, a browser Playground,
persistent workspaces, and Codex CLI backed by the Volcengine Ark Responses API.

> **Selected hackathon track: Track B — The Bouncer (Identity and
> Authorization).** The required proof uses two deterministic mock users:
> Alice's Agent reads Alice's managed record through the backend gateway, then
> the same Agent is denied access to Bob's managed record. The caller cannot
> change the trusted user in request JSON or headers. The graph-informed,
> history-adaptive safety stop is an integrated extension of that same runtime
> boundary, not a second selected track.

Run it locally with Docker, Colima, or rootless Podman, or deploy it to
Volcengine ECS.

> [!WARNING]
> This is a proof of concept with one authenticated demo session and a
> deterministic two-owner authorization fixture, not a multi-tenant identity
> system. Protected managed actions have a server-attested identity, RBAC,
> graph ownership and impact checks, trusted-history checks, and a pre-effect
> circuit breaker. It does not provide an external identity provider or
> transparently mediate arbitrary Codex shell and network actions. Do not use
> production data or credentials. See [SECURITY.md](SECURITY.md).

## Screenshots

### Agent Playground

![Agent Playground showing lifecycle controls, starter prompts, and the Codex Runtime](docs/assets/playground.jpg)

### Create an Agent

![Create Agent form with name, description, and workspace instructions](docs/assets/create-agent.jpg)

## Features

- React and TypeScript Web UI
- Agent create, edit, start, stop, delete, and multi-turn chat
- Fastify control plane with asynchronous Run state
- Persistent Agent workspaces and Codex sessions
- SQLite-backed Knowledge Graph and governance persistence
- Prompt-assisted access configuration and Agent-scoped learned relationships
- Explainable Blast Radius paths and pre-run allow/review/deny decisions
- Expiring, graph-bound approvals with atomic one-time claims
- Ordered, persistent structured Run-event timelines
- Server-attested Run identity and scope-preserving Agent delegation
- Backend-enforced Agent/resource ownership with a two-user authorization proof
- Reverse graph impact queries used by runtime policy
- Bounded trusted-history behavioral baselines with poisoning protection
- A persistent pre-effect circuit breaker for managed resource actions
- A reloadable safety-proof view that distinguishes permission, contextual
  risk, and whether the adapter changed anything
- Disposable Docker, Colima, or Podman container for each local turn
- Docker and Terraform deployment paths for Volcengine ECS

## Three-minute judge flow

1. Start the development app and click **Create Agent**. Name it **Alice
   Boundary Judge**, then open **Playground**.
2. Click **Grant Alice-only read**. The admin backend creates one exact
   `CAN_READ` graph capability; Agent creation has already persisted
   `human:alice -> OWNS -> agent:<new ID>`.
3. Run the Alice/Bob boundary proof. Alice's managed record completes through
   the real SQLite adapter with the newly created Agent as actor. The same
   Agent's attempt against Bob's record returns `DENY`,
   the adapter is not called, and the Run timeline explains that Bob owns the
   resource. Supplying `human:bob` in the body or a header does not change the
   server-attested origin.
4. Click **Stop** and observe that another protected action returns `409`
   without a claim or effect. Reload: Agent ownership, permission, status, and
   Run evidence remain persisted.
5. Select **Release Guardian**, establish the trusted staging history, then try the broader production
   configuration change. The exact write permission is `ALLOW`, but downstream
   customer-data impact plus historical novelty returns `BLOCK`; the durable
   configuration remains unchanged.
6. Open **What happened**, reload, and inspect the same ordered identity,
   authorization, risk, breaker, and effect evidence.

The checked-in browser regression runs this flow with `npm run test:e2e`.

## Fast judge setup (no model credential required)

The selected Track B proof is deterministic and does not call Ark or Codex.
From the repository root:

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>, create an Agent, and use its two required Track B
controls. Then select **Release Guardian** for the four-step graph/learning
extension. The managed read/write path,
authorization decisions, graph impact, SQLite effect, timeline, and learning
loop are all real backend behavior. Model-backed chat remains unavailable
until Ark is configured.

To run the same proof as an isolated production-build browser test:

```bash
npx playwright install chromium
npm run test:e2e
```

## Current middleware status and next work

The repository now contains two complementary enforcement seams:

1. A coarse pre-run graph policy can pause or deny Codex before it starts.
2. A stronger action-level `ResourceGateway` mediates managed resource effects.
   It resolves the persisted Run identity, checks RBAC and exact capability,
   calculates downstream impact, compares trusted historical behavior, records
   an explainable `ALLOW`, `WARN`, or `BLOCK`, and creates a one-time execution
   claim before the managed adapter can run.

The selected-track gate is the Alice/Bob backend authorization boundary. The
central differentiation is deliberately beyond RBAC: after trusted staging
changes, Release Guardian has direct permission to change the shared deployment
configuration, but learned novelty plus sensitive downstream graph impact trips
the safety stop. The adapter remains unclaimed, the resource is unchanged, and
the ordered evidence survives reload and restart.

Track B's required disable/update control is also enforced outside the UI:
operators or administrators may stop an Agent, after which protected actions
return before an execution claim or resource effect; only an administrator may
delete Agents or change graph permission/ownership facts. Every role check uses
the current durable principal record, so an earlier process-local role cannot
outlive a downgrade.

The highest-value remaining work is:

1. Route additional real tools through explicit protected adapters, or enforce
   equivalent mediation in the Codex execution sandbox. Do not imply that
   ordinary shell, filesystem, and network calls already use the gateway.
2. Replace the configured demo principal and shared bearer token with real
   login/session identity, reviewer separation of duty, tenant boundaries,
   rate limits, and CSRF protection.
3. Add a transactional outbox and idempotent reconciliation for external
   adapters so post-effect audit failures can be recovered across systems.
4. Extend Playwright coverage beyond the checked-in judge flow to approval
   interaction, deeper keyboard behavior, and additional responsive layouts.
5. Move Runs and messages into SQLite so timeline, policy, identity, and Run
   lifecycle records have strong database-level referential integrity.

See [current weaknesses and priorities](docs/CURRENT_WEAKNESSES.md) for the
release backlog. The [full audit](docs/FULL_HACKATHON_CODEBASE_AUDIT.md) and
[session report](docs/SESSION_IMPLEMENTATION_REPORT.md) are historical
before-state evidence and contain limitations that have since been remediated.

## Requirements

- Node.js 22+
- npm 10+
- Docker, Colima, or Podman for model-backed local Agent turns
- A Volcengine Ark API key and Responses-capable endpoint for model-backed chat

Neither a container engine nor Ark is required for the guided Track B
middleware proof. Codex CLI is included in the Runtime image and is not
required on the host.

## Local browser SOP

### 1. Check the local tools

Install Node.js 22+ and one supported container engine, then verify them:

```bash
node --version
npm --version
docker --version        # Docker Desktop, Docker Engine, or Colima
podman --version        # Use this instead when running Podman
```

Only one container engine is required. Codex CLI is already included in the
Runtime image.

### 2. Clone the repository

```bash
git clone <repository-url> volc-agent-launchpad
cd volc-agent-launchpad
```

Skip this step when already working from the repository root.

### 3. Start the POC

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

The first run installs Node.js dependencies and builds the Runtime image. The
script automatically selects Docker, Colima, or Podman.

### 4. Open the browser

Visit <http://localhost:3000>, or open it from the terminal:

```bash
open http://localhost:3000       # macOS
xdg-open http://localhost:3000   # Linux desktop
```

In the Web UI:

1. Select **Create Agent**.
2. Enter a name, description, and workspace instructions.
3. Select **Create Agent** again.
4. Enter a task in the Playground, for example:

   ```text
   Create a TypeScript hello-world CLI, add a test, and run it.
   ```

The Agent can write files, run commands, and continue the same Codex session in
later messages.

### 5. Stop and resume

Press `Ctrl+C` in the startup terminal. The script removes temporary Runtime
containers but keeps Agent workspaces and conversations.

- macOS state: `~/.volc-agent-launchpad/`
- Linux state: `.local/`
- Custom location: set `LOCAL_POC_DATA_ROOT`

Run the same `npm run poc` command to continue later.

### Select a specific container engine

Force Podman when multiple engines are installed:

```bash
CONTAINER_ENGINE=podman \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI.

For a clean Linux host, follow the
[rootless Podman setup](docs/LOCAL_POC.md#rootless-podman-on-linux).

## Docker Compose

Create and edit the configuration:

```bash
./scripts/bootstrap-local.sh
```

Required values in `.env`:

```dotenv
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=replace-with-at-least-24-random-characters
```

Start the application:

```bash
docker compose up --build
```

Open <http://localhost:3000>. Stop it without deleting Agent data:

```bash
docker compose down
```

## Development

```bash
npm install
cp .env.example .env
npm install --global @openai/codex@0.111.0
npm run dev
```

- Web UI: <http://localhost:5173>
- API: <http://localhost:3000>

Use local paths in `.env` when running outside Docker:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
```

## Deployment

- [Existing Linux ECS with Docker](docs/DEPLOYMENT.md#existing-linux-ecs)
- [Complete Volcengine environment with Terraform](docs/DEPLOYMENT.md#terraform-deployment)
- [Local Docker, Colima, and Podman details](docs/LOCAL_POC.md)

The existing-ECS script deploys from the current source tree:

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

The Terraform path provisions VPC, subnet, security group, ECS, and EIP:

```bash
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARK_API_KEY` | Required | Ark model API key. |
| `ARK_MODEL` | Required | Responses-capable endpoint or model ID. |
| `ARK_BASE_URL` | Beijing v3 endpoint | Ark OpenAI-compatible API URL. |
| `APP_AUTH_TOKEN` | Empty on loopback | Shared demo token; use 24+ random characters remotely. |
| `APP_PRINCIPAL_ID`, `APP_PRINCIPAL_NAME`, `APP_PRINCIPAL_ROLE` | Alice/admin | Server-attested demo origin used by protected Runs; never taken from request JSON. |
| `SEED_DEMO_DATA` | `true` in hackathon profiles | Deterministic Track B and graph-safety fixtures; set `false` for an empty installation. |
| `RUNTIME_PROVIDER` | `local-process` | `container` for disposable local Runtime containers. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn. |
| `APP_DATA_DIR` | `.data` | Parent directory for `launchpad.json` and `middleware.db`. |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | Local metadata, workspace, and session directory. |

See [.env.example](.env.example) for all Runtime and resource-limit options.

## How it works

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify control plane"]
    API --> Store["JSON: Agents, Runs, and Messages"]
    API --> Graph["Knowledge Graph APIs and services"]
    Graph --> Middleware["SQLite middleware.db"]
    API --> Runtime{"Runtime provider"}
    Runtime -->|Local POC| Container["Disposable Docker / Colima / Podman container"]
    Runtime -->|ECS profile| Codex["Codex CLI in application container"]
    Container --> Ark["Volcengine Ark Responses API"]
    Codex --> Ark
```

The first turn uses `codex exec`; later turns resume the stored Codex thread.
Deleting an Agent archives its workspace under `workspaces/.deleted/` and
removes its messages, while retaining terminal Run metadata and ordered
middleware events as queryable audit evidence.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component and extension
boundaries.

## SQLite middleware database

`middleware.db` is the source of truth for middleware-owned state. The server
opens it through `MiddlewareDatabase` during startup, applies versioned
migrations, and then constructs `SqliteGraphStore`. SQLite keeps the single-node
demo self-contained and requires no hosted database, network connection, or
additional API keys.

Existing platform data and Agent-created files remain separate:

| Location | Responsibility |
| --- | --- |
| `APP_DATA_DIR/launchpad.json` | Agents, Runs, and Messages; legacy graph arrays may remain but are no longer authoritative |
| `APP_DATA_DIR/middleware.db` | Graph, timeline, identity, delegation, baseline, risk, breaker, managed effect, approval, and claim evidence |
| `AGENT_WORKSPACE_ROOT/{agent-id}/` | Files created in each Agent workspace |

The generated database file is local runtime state and must not be committed.
Commit migrations, seed definitions, store code, and tests so every teammate
can recreate the same schema and demo data. `.gitignore` also excludes SQLite
database, journal, WAL, and shared-memory files.

### Database location by run mode

Always construct the path from `config.dataDirectory`; do not hard-code one of
these locations in application code.

| Run mode | Default host location |
| --- | --- |
| Local `npm run dev` with relative `APP_DATA_DIR=.data` | `apps/server/.data/middleware.db` |
| `npm run poc` on macOS | `~/.volc-agent-launchpad/data/middleware.db` |
| `npm run poc` on Linux | `.local/data/middleware.db` |
| Docker Compose | `data/middleware.db` on the host, mounted as `/app/data/middleware.db` |
| Custom | `$APP_DATA_DIR/middleware.db` |

On a fresh state root, the database file may not exist. SQLite creates it when
the application opens it, and idempotent migrations create or upgrade its
tables.

The optional SQLite CLI can inspect the live database read-only after a local
development start; it is not installed by this project:

```bash
sqlite3 -readonly apps/server/.data/middleware.db
.tables
SELECT id, type, label FROM graph_nodes ORDER BY created_at, id;
.quit
```

Applied migrations are immutable. Never edit, delete, or reorder one: its
checksum intentionally prevents startup if history changes. Add a new migration
with the next higher version instead.

### Persistence boundary

One `MiddlewareDatabase` owns the connection, migrations, transactions, and
shutdown. Focused adapters can share that connection; services and routes must
not query SQLite directly.

```text
KnowledgeGraphService                      PolicyService / Resource Gateway
GraphConfigurationService                         |
          |                                       |
      GraphStore                          GovernanceStore
          |                                       |
  SqliteGraphStore            SqliteGovernanceStore (implemented/tested)
          `-------------------.-------------------'
                              |
                     MiddlewareDatabase
                              |
               APP_DATA_DIR/middleware.db
```

`SqliteGraphStore` implements the existing `GraphStore` contract without
changing `KnowledgeGraphService`, `GraphConfigurationService`, Agent lifecycle,
route shapes, or Playground behavior. `JsonGraphStore` remains only as a legacy
reference adapter. Non-demo graph facts from an old `launchpad.json` are not
automatically imported. Existing Agent identities are reconciled during
startup; the two demo topologies are reconciled only when their demo Agents
exist (development seeds them by default, or set `SEED_DEMO_DATA=true`).

The Impact Map in the Web UI loads the selected Agent's graph and Blast Radius
from the SQLite-backed graph APIs. It redraws when the selected Agent changes,
when that Agent's settings are saved, or when the user selects the refresh
control. Its guided configuration asks for an existing or new asset, the
classification of a new asset, and the Agent's direct access. Risk defaults are
inferred from classification, while reachable assets, downstream paths, and
Blast Radius are inferred from the shared topology. The Network Graph tab reads
`GET /api/graph` and shows all stored nodes and relationships together.
The Impact Map automatically focuses the deterministic shortest evidence route
to the highest-weight protected asset. Its footer explains why that path
was chosen, displays every node and relationship in the route, and lets the
user focus a different scored asset without changing the aggregate score.

The server also learns non-authoritative relationships from explicit statements
in user prompts and completed Agent replies. Learned edges retain their source
Run, evidence excerpt, confidence, and review state. They are drawn as dashed
relationships in the Network Graph and appear in the Impact Map's inline
review queue. Observed or confirmed relationships can conservatively increase
downstream risk; rejected relationships are ignored. This learning path cannot
create `CAN_READ`, `CAN_WRITE`, `CAN_CALL`, or `CAN_USE`, so it can never grant
an Agent access.

The current schema is deliberately split by responsibility:

| Tables | Owner and purpose |
| --- | --- |
| `schema_migrations` | Applied migration versions and immutable checksums |
| `graph_nodes`, `graph_edges` | `SqliteGraphStore`: identities, assets, permissions, impact, and audit facts |
| `graph_observations` | Learned resource relationships with confidence, evidence, Run provenance, and review state |
| `policy_decisions` | `SqliteGovernanceStore`: immutable `ALLOW`, `DENY`, or `REVIEW_REQUIRED` evaluations |
| `approval_requests`, `approval_events` | Pending review state plus append-only approval history |
| `policy_action_claims` | Atomic, single-use permission to execute an already allowed or approved action |
| `run_event_sequences`, `run_events` | Structured Run facts with transactional Run-local ordering |
| `identity_principals`, `delegations` | Server-known principals and scope-preserving Agent delegation |
| `authorization_decisions`, `risk_decisions` | Separate RBAC/capability and behavioral/graph outcomes |
| `behavioral_baselines`, `circuit_breakers` | Trusted historical context and persistent safety-stop state |
| `managed_resource_state` | Durable sentinel proving whether a protected adapter changed a resource |
| `managed_resource_action_receipts` | Idempotent read/write receipts bound to the exact claimed decision, Run, Agent, resource, capability, and payload |

Initialization enables foreign keys, WAL, a five-second busy timeout, migration
checksum verification, refusal of unknown newer schemas, and a foreign-key
integrity check. The adapters use parameterized statements, recursively reject
secret-looking JSON fields, apply strict relation/status/type validation, and
return deterministic query order. Blast Radius counts each reachable asset once
even when multiple capabilities reach the same target.

The server pins `better-sqlite3` as a runtime dependency; keep it under
`dependencies` because production images prune development packages.
Database tests use temporary file-backed databases, never a developer's real
`APP_DATA_DIR/middleware.db`.

See the
[Knowledge Graph MVP specification](docs/KNOWLEDGE_GRAPH_MVP_SPEC.md#sqlite-persistence-foundation)
for the graph contract and reasoning model.

### Authorization and approval boundary

Within the graph, only an exact, direct, authorized `CAN_*` edge from an Agent
to an asset represents a capability. It is necessary but not sufficient for a
future protected action: the gateway must also verify the platform Agent is
live and eligible, the Run belongs to it, and the authenticated actor may make
the request. Ownership, graph reachability, risk scores, previous activity, and
approval history do not create permissions.

The governance store already enforces these persistence rules:

- A stable operation ID is idempotent and is bound to the Run, Agent, action,
  target, and SHA-256 request hash.
- Recording `REVIEW_REQUIRED` atomically creates a pending approval request with
  an expiry; `ALLOW` and `DENY` cannot create one.
- A pending request may become approved, rejected, or expired. For
  `REVIEW_REQUIRED`, only an approved, unexpired review can be claimed;
  `ALLOW` decisions can be claimed directly and `DENY` decisions never can.
- A claim is atomic and single-use. Claiming an approved review also marks its
  request consumed and appends the corresponding approval event. The claim
  must repeat the same operation ID and request hash, preventing an approval
  from being reused for different parameters.
- Transaction callbacks are synchronous and short; they never remain open
  while waiting for a human or an external action.

The `PolicyService` canonicalizes the protected request and computes
its lowercase SHA-256 hash consistently; the store validates and binds that
caller-supplied digest but does not calculate it. It must also verify live-Agent
eligibility and Run ownership before recording a decision. Resolution and claim
times come from the governance store's server-side clock, not request JSON.
There is no expiry worker yet: a caller must record the `expired` transition,
while a late execution claim independently fails closed.

The target protected-action flow is:

```text
ATTEMPTED
  |-- ALLOW --------------------------> execute --------> TOUCHED
  |-- DENY ---------------------------------------------> DENIED
  `-- REVIEW_REQUIRED --> pending human approval
                              |-- approved --> execute -> TOUCHED
                              `-- rejected/expired -----> DENIED
```

> [!IMPORTANT]
> The server wires policy decisions, approvals, a pre-run gate, and a managed
> Resource Gateway with durable effect evidence. Arbitrary Codex shell,
> filesystem, and network operations are still not intercepted per tool call;
> only actions routed through the gateway receive the action-level guarantee.

The current shared `APP_AUTH_TOKEN` selects one server-configured demo
principal. Request bodies and identity headers cannot forge a different actor,
but this is not an external identity provider or multi-user session model.

An Agent or LLM must never write directly to the database or approve its own
request. It may suggest configuration, but only a trusted backend path writes
facts and decisions. Hosts and credential references may be represented as
`asset` nodes, but actual passwords, tokens, API keys, protected payloads, and
other secret values must never be stored in middleware JSON fields.

Deleting an Agent removes it from the live platform but intentionally retains
its graph facts as historical evidence. Graph and relationship API routes first
require the live Agent, so retained facts cannot be queried or extended through
those normal lifecycle endpoints.

## Validation

```bash
npm run check
npm run test:e2e
terraform fmt -check -recursive deploy/volcengine
docker compose config --quiet
```

Install the Chromium test browser once with `npx playwright install chromium`.
If Terraform is unavailable, report that check as unverified rather than
silently treating it as passed.

## Documentation

- [Session implementation report](docs/SESSION_IMPLEMENTATION_REPORT.md)
- [Full hackathon codebase audit and remediation status](docs/FULL_HACKATHON_CODEBASE_AUDIT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Local POC](docs/LOCAL_POC.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Knowledge Graph MVP specification](docs/KNOWLEDGE_GRAPH_MVP_SPEC.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
