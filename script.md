# QuantQueens Presenter Runbook

This file is arranged in presentation order. Use **Part 1** once before the
recording, then start the timer at **Part 2** and move straight down the page.
Everything after Part 2 is backup or reference material; it is not part of the
three-minute narration.

## At a glance

1. **Part 1: Prepare:** start Docker Compose, check the real model, and build
   the trusted staging history.
2. **Part 2: Present:** the exact three-minute sequence, with what to click,
   type, say, and expect.
3. **Part 3: Recover:** a shorter backup flow and fixes for common problems.
4. **Part 4: Answer questions:** graph details, honest boundaries, roadmap,
   and judge Q&A.

---

# Part 1: Prepare before recording

## Start here: run Docker Compose before the demo

Run the application through Docker Compose. This gives the Agents the real
Codex runtime in the application container.

From the repository root:

```bash
./scripts/bootstrap-local.sh
```

Open `.env` and set:

```dotenv
ARK_API_KEY=your-real-ark-api-key
ARK_MODEL=your-responses-capable-endpoint-id
APP_AUTH_TOKEN=a-private-demo-token-with-at-least-24-characters
POLICY_REVIEW_THRESHOLD=20
POLICY_DENY_THRESHOLD=80
```

The presenter thresholds mean:

- risk below 20 may execute normally;
- risk from 20 to 79 pauses for a person;
- risk of 80 or more is a hard stop that cannot be approved;
- missing permission is always denied and cannot be approved.

Start with isolated data so earlier Runs cannot change the result:

```bash
DEMO_ROOT="$(mktemp -d)"
mkdir -p "$DEMO_ROOT/data" "$DEMO_ROOT/workspaces" "$DEMO_ROOT/codex-home"

export APP_DATA_HOST_DIR="$DEMO_ROOT/data"
export AGENT_WORKSPACE_HOST_DIR="$DEMO_ROOT/workspaces"
export CODEX_HOME_HOST_DIR="$DEMO_ROOT/codex-home"

docker compose up --build -d
docker compose ps
docker compose exec -T launchpad printenv POLICY_REVIEW_THRESHOLD POLICY_DENY_THRESHOLD
```

Wait until `launchpad` is **healthy**, then open
<http://127.0.0.1:3000>. Enter the same `APP_AUTH_TOKEN` from `.env`.
The final command must print `20` and then `80`. If it prints `20` and `40`,
the later production action will hard-stop and cannot be approved; correct
`.env` and recreate the container before continuing.

## Preflight checklist

Do not start recording until every item below passes.

- [ ] The page opens at `http://127.0.0.1:3000`.
- [ ] The Runtime card says **Codex CLI in application container**.
- [ ] The Runtime card shows the Ark model configured in `.env`.
- [ ] **Release Guardian** exists and is **Ready**.
- [ ] **Dependency Scout** does not already exist.
- [ ] A simple greeting such as `hi` returns ordinary Agent conversation. It
      must not show an approval card.
- [ ] The browser is at a comfortable zoom and the sidebar, tabs, prompt box,
      and right-side **Run activity** panel fit on screen.

## Build the trusted staging history

This creates the real historical baseline used later. Do this before recording.

**Where:** Select **Release Guardian** → click **Playground**.

**Type each prompt separately and press Enter. Wait for `Resource: Completed`
before sending the next prompt.**

```text
Update the staging configuration to release 2.3.1.
```

```text
Update the staging configuration to release 2.3.2.
```

```text
Update the staging configuration to release 2.3.3.
```

**Expected after the third request:**

- **Permission: Allowed**
- **Safety: Allowed**
- **Resource: Completed**
- the proof line reports an effect claim;
- the history step says three trusted Runs form the baseline.

**Final reset before recording:** close any open audit trail, leave **Release
Guardian** selected, and scroll this document to the start of Part 2.

---

<a id="exact-three-minute-live-demo"></a>

# Part 2: Exact three-minute presentation

Start the timer here. Follow the seven segments in order. Each segment always has
the same four fields: **Screen**, **Click / type**, **Say**, and **Expect**.

**Live timing rule:** a real Codex turn normally takes about 8 to 15 seconds,
but allow up to 30 seconds depending on the model endpoint. Use that wait to
explain the problem being solved. Do not send another prompt or change tabs
until the current Run reaches its stated **Expect** result.

## 0:00 to 0:18 | Create a new Agent identity

**Screen**

The main application with **Release Guardian** selected.

**Click / type**

1. Click **Create Agent** in the sidebar.
2. Enter the following values:

```text
Name: Dependency Scout
Description: Maps service dependencies from Agent work
Instructions: Describe technical relationships precisely. Never infer permission from topology.
```

3. Click **Create Agent** in the form.

**Say**

> “QuantQueens is runtime middleware between autonomous Agents and protected
> resources. A new Agent receives an attributable identity and Alice ownership,
> but no resource permission.”

**Expect**

- **Dependency Scout** appears in the sidebar and is selected.
- Its status is **Ready**.
- No resource access has been granted by creating it.

## 0:18 to 1:00 | Discover new relationships from real Agent output

**Screen**

**Dependency Scout** → **Playground**.

**Click / type**

Type this exact prompt and press Enter:

```text
Map these dependencies in two plain sentences: Checkout API -> Fraud Service -> Customer records. Use the verbs calls and processes.
```

Then follow this sequence:

1. Keep **Run activity** open while the model works.
2. Wait for both the Agent response and the **New relationships found** card.
   This normally takes 8 to 15 seconds; allow up to 30 seconds.
3. Do not open a graph as soon as the text response appears. The middleware
   persists observations immediately before the Run completes, and the card
   appears after the UI reads that persisted evidence.
4. Click **Show in network graph** on the discovery card. Relationship approval
   is **not required** to display newly learned nodes and dashed edges.
5. Wait for the graph toolbar to say **Updated** with a timestamp.
6. If the three new nodes are still missing after about three seconds, click
   **Refresh network** once. Wait for the **Updated** timestamp to change before
   doing anything else. Do not repeatedly click refresh.

**Say**

While Codex is working, say:

> “Most permission systems only know the direct rule: Agent A may call Service
> B. They miss downstream customer-data impact. Diagrams become stale, while
> logs usually explain the chain after the event.”

When the response appears, say:

> “This is a real Agent Run. The model turns the request into relationship
> statements. The middleware creates missing nodes and records edges with
> confidence and Run provenance: Checkout API calls Fraud Service, which
> processes Customer records.”

When the network appears, point to the two dashed edges and say:

> “This living map answers what a system can reach and, in reverse, which
> Agents or Runs could affect customer records. Dashed observations are visible
> without approval but quarantined from policy until confirmed. Topology may
> increase risk; it never creates permission.”

**Expect**

- The conversation contains a real model response.
- A **New relationships found** card reports two observations.
- The network graph shows **Dependency Scout**, **Checkout API**, **Fraud
  Service**, and **Customer records**.
- The new `CALLS` and `PROCESSES` relationships are dashed or marked pending.
- The graph header reports two relationships pending review.
- No relationship confirmation is required for this timed presentation.

**Important distinction for the presenter:**

```text
Observed relationship  -> visible immediately as dashed evidence
Confirmed relationship -> eligible to inform future topology and risk
CAN_* permission        -> explicit authority created only by an administrator
```

Do not confirm the two relationships during the three-minute presentation.
Confirmation is deliberately separate because “map this” is a request to
discover topology, not proof that every statement returned by a model is true.
If you want to demonstrate confirmation after the timer, return to
**Dependency Scout** → **Playground** → **Review relationships** → **Review
below**, then click **Confirm relationship** on each observation.

## 1:00 to 1:20 | Allow a familiar, limited action

**Screen**

Select **Release Guardian** → click **Playground**.

**Click / type**

Type this exact prompt and press Enter:

```text
Update the staging configuration to release 2.4.1.
```

If the side panel is closed, click **Run activity**.

**Say**

> “Codex plans one bounded action read-only. The server checks Alice, exact
> permission, graph impact, and trusted history. Staging is familiar with a
> limited path, so the gateway issues one claim and performs the update.”

**Expect**

- **Permission: Allowed**
- **Safety: Allowed**
- **Resource: Completed**
- **Effect claim issued**
- The final journey step says **Gateway completed the effect**.

## 1:20 to 1:42 | Deny an action with no authority

**Screen**

Stay in **Release Guardian** → **Playground**.

**Click / type**

Type this exact prompt and press Enter:

```text
Read Bob's private records.
```

Then click **View audit trail**.

**Say**

> “Bob owns this resource, and Release Guardian has no effective permission
> under Alice's identity. Graph proximity and history cannot manufacture
> authority, so there is no approval and the adapter is never reached. The
> audit preserves who asked, the Agent, Run, resource, reason, and no-effect
> outcome.”

**Expect**

- **Permission: Denied**
- **Safety: Not needed**
- **Resource: Prevented**
- **Effect never claimed**
- No **Approve and continue** button appears.
- The audit events are sequence ordered and end without a resource write.

## 1:42 to 2:12 | Pause an authorized but unusually broad action

**Screen**

Stay in **Release Guardian** → **Playground**. Click **Hide audit trail** if it
obscures the request journey.

**Click / type**

Type this exact prompt and press Enter:

```text
Update the production deployment configuration to release 2.5.0.
```

Do not approve it yet. In the right-side panel, click **Open impact map**.

**Say**

> “The exact permission is valid, but trusted behavior contains staging while
> this targets production. The graph expands through five potentially affected
> resources to restricted customer data. Risk is above review but below the
> hard stop, so the gateway pauses before a claim. Production remains
> unchanged.”

**Expect**

- **Permission: Allowed**: the Agent has the exact capability.
- **Safety: Needs review**: history and graph impact increase risk.
- **Resource: Paused**: nothing has changed yet.
- **Effect never claimed**
- **Approve and continue** and **Reject** are visible in the Playground.
- **Production service** and **Customer dataset** appear under **Potentially
  affected**.

The difference between the three outcomes is:

```text
Staging       exact authority + familiar, limited impact  -> execute
Bob's records missing effective authority                 -> deny
Production    exact authority + unusual, broad impact     -> pause for review
```

## 2:12 to 2:42 | Show why the graph changes the decision

**Screen**

The **Impact map** for **Release Guardian**.

**Click / type**

1. Click **Customer dataset** in the blast-radius equation or on the map.
2. If needed, click **Focus highest risk** so the relevant route is emphasized.
3. Point along this path:

```text
Alice --OWNS--> Release Guardian
Release Guardian --CAN_WRITE--> Deployment configuration
Deployment configuration --DEPLOYS_TO--> Production service
Production service --PROCESSES--> Customer dataset
Customer dataset --CONTAINS--> PII
```

**Say**

> “These edges have separate jobs. `OWNS` gives accountability and `CAN_WRITE`
> is exact authority. A traditional check would stop there and allow the
> change. QuantQueens follows `DEPLOYS_TO`, `PROCESSES`, and `CONTAINS` to reveal
> restricted data before execution, so the gateway pauses. Reverse traversal
> identifies which permissions, Agents, Runs, and upstream systems could affect
> a dataset, improving change review and incident investigation.”

**Expect**

- The selected node is **Customer dataset**.
- The permission-to-impact route is highlighted.
- The map explains that the production request can reach five resource nodes.
- The restricted data path is visible.

Do not say that five resources changed. They are what **could** be affected if
the approved action executes.

## 2:42 to 3:00 | Approve safely and close the loop

**Screen**

Click **Playground** to return to the paused request.

**Click / type**

Click **Approve and continue** once.

**Say**

> “Approval is bound to this Run, payload, identity, and graph revision, then
> consumed once. The gateway rechecks everything before completing the update.
> QuantQueens closes the loop: propose, decide, enforce, execute, observe,
> learn, and improve the next decision.”

**Expect**

- **Approved and completed**
- **Permission: Allowed**
- **Safety: Needs review** with **Human review approved** in the journey.
- **Resource: Completed**
- **Effect claim issued**
- The approval buttons disappear and cannot be reused.

---

# Part 3: Backup and recovery

## 90-second backup presentation

Use this only if the time slot is shortened. Prepare the staging history first.

### 0:00 to 0:15

**Click / type:** Select **Release Guardian** → **Playground**. Send:

```text
Update the staging configuration to release 2.4.1.
```

**Say:** “A familiar, exactly permitted staging action crosses the gateway and
completes with a one-time effect claim.”

**Expect:** **Allowed / Allowed / Completed**.

### 0:15 to 0:35

**Click / type:** Send:

```text
Read Bob's private records.
```

**Say:** “Bob owns this resource. The Agent has no exact authority, so the
request is denied before risk or execution can rescue it.”

**Expect:** **Denied / Not needed / Prevented**.

### 0:35 to 1:05

**Click / type:** Send:

```text
Update the production deployment configuration to release 2.5.0.
```

Click **Open impact map** and select **Customer dataset**.

**Say:** “The production write is permitted, but it is unusual relative to
trusted staging history and the graph reaches five resources, including
restricted customer data. The middleware pauses the effect for review.”

**Expect:** **Allowed / Needs review / Paused**, with the graph path visible.

### 1:05 to 1:30

**Click / type:** Return to **Playground** and click **Approve and continue**.

**Say:** “The exact, single-use approval is revalidated before the gateway
changes durable managed state. Every decision and effect remains in the Run
timeline.”

**Expect:** **Approved and completed** and **Effect claim issued**.

## Troubleshooting

| Symptom | Likely cause | Fix before recording |
| --- | --- | --- |
| `hi` shows a review card | An old image is still running | Run `docker compose down`, then `docker compose up --build -d`, and hard-refresh the browser. |
| Clicking approve or reject shows `Conflict` | The browser or container has stale approval code/state | Rebuild the Compose stack, use a fresh `DEMO_ROOT`, and hard-refresh. |
| Production says **Blocked** and has no approval button | `POLICY_DENY_THRESHOLD` is still the secure default of 40 | Set the presenter profile to review 20 / deny 80, then restart with fresh data. |
| Production executes without review | Thresholds or seeded graph data are not the expected presenter profile | Confirm `.env`, restart with fresh data, and repeat the three staging history Runs. |
| The Agent says it is stopped | The selected Agent was stopped manually | Click **Start**, wait for **Ready**, then resend the prompt. |
| No model answer appears | Ark credentials/model are invalid or the runtime is unavailable | Check the Runtime card and `docker compose logs launchpad`; correct `.env` and restart. |
| The Agent returned the two dependency sentences but no **New relationships found** card appears | The browser reused an older frontend or stale observation response | Rebuild Compose, hard-refresh, then reselect Dependency Scout. Persisted observations are restored from the completed Run. |
| The Impact map shows only Dependency Scout after learning | Nothing is wrong: pending observations are deliberately excluded from effective policy | Use **Show pending network** to see the new nodes and dashed edges, or **Review below** to confirm them. |
| New graph edges are dashed | Nothing is wrong | Dashed means **pending and quarantined**. They cannot affect permission or risk until confirmed. |
| Old Agents or Runs change the results | Persistent data from a previous session was reused | Stop Compose and start again with a new temporary `DEMO_ROOT`. |
| Buttons or text do not match this runbook | The browser has stale frontend assets | Rebuild Compose and perform a hard refresh. |

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 launchpad
```

---

# Part 4: Presenter reference and judge questions

This section is not part of the timed narration.

## The one-sentence product explanation

> “QuantQueens is runtime middleware that attributes an Agent action, checks
> exact authority, expands its impact through a relationship graph, compares
> it with trusted Run history, and then executes, pauses, or prevents the real
> managed effect through a Resource Gateway.”

## Why each request gets a different outcome

| Request | Permission | Runtime context | Consequence |
| --- | --- | --- | --- |
| Staging update | Exact `CAN_WRITE` exists | Familiar target; limited three-resource impact | Executes normally |
| Bob's records | No effective `CAN_READ`; wrong owner | Risk is irrelevant after authorization fails | Denied; cannot be approved |
| Production update | Exact `CAN_WRITE` exists | Novel target; five-resource impact; restricted data path | Pauses for single-use human approval |
| Score at or above 80 | Permission may exist | Critical combined risk | Hard stop; change conditions and re-evaluate |

This is why the product is more than RBAC. Permission answers **may this Agent
request the action?** The graph and history answer **is this permitted action
normal and safe enough to execute now?**

## How the relationship graph works

### The operational problem it solves

AI Agents act across APIs, services, data stores, credentials, and other
Agents. Direct permissions show the first hop, but the real damage or customer
impact often sits several hops away. Static diagrams also become outdated as
Agents discover or create new integrations.

| Common problem | What a static permission or log misses | QuantQueens benefit |
| --- | --- | --- |
| A permitted configuration change reaches sensitive data indirectly | RBAC sees the direct write, not the downstream service and dataset | Forward traversal calculates blast radius before execution |
| A critical dataset is involved in an incident | Logs are scattered by tool and usually start from the action, not the protected resource | Reverse queries identify upstream resources, Agents, users, and related Runs |
| Teams rely on manually maintained architecture diagrams | Dependencies change faster than documentation | Completed Runs propose new nodes and edges with evidence, confidence, and provenance |
| Model output is wrong, compromised, or overconfident | Automatically trusting extracted text would poison the safety model | New observations are visible immediately but quarantined until confirmed |
| A technically permitted action is unusual for one Agent | Static access rules have no behavioral memory | Trusted Run history and graph impact can pause or block an otherwise permitted effect |

The result is not merely a more detailed diagram. The graph changes a real
gateway decision, explains the path behind it, and becomes more useful as
additional Runs produce trustworthy evidence.

### Nodes

The current graph uses operational entities that the middleware can reason
about:

- humans, such as Alice and Bob;
- Agents, such as Release Guardian and Dependency Scout;
- resources, such as configurations, services, APIs, and datasets;
- data categories, such as PII;
- Runs, which preserve execution provenance.

### Edges

Edges have deliberately different security meanings:

- **Authority:** `CAN_READ`, `CAN_WRITE`, `CAN_CALL`, `CAN_USE`
- **Accountability:** `OWNS`
- **Topology and impact:** `DEPLOYS_TO`, `CALLS`, `PROCESSES`, `CONTAINS`
- **Runtime evidence:** `ATTEMPTED`, `TOUCHED`, `DENIED`

Only an explicit `CAN_*` edge can contribute resource authority. Ownership,
topology, Run history, proximity, or model output cannot grant permission.

### How new relationships are discovered safely

```text
Agent Run completes
  -> bounded statements are extracted from the model response
  -> missing nodes and observed edges are stored with Run provenance
  -> observations remain pending and quarantined
  -> a person confirms or rejects them
  -> confirmed topology may inform later graph impact and risk
  -> no observation can create a CAN_* permission
```

This is bounded, evidence-backed relationship discovery rather than an
uncontrolled self-modifying permission system. The graph becomes more useful
as Runs reveal dependencies, while authority remains explicit.

### Operational questions the graph can answer

- What can this Agent reach directly and indirectly?
- Which downstream resources could this action affect?
- Which Agent, Run, or human could affect this resource?
- Why was the action allowed, paused, or denied?
- Which path reaches a sensitive dataset?
- Which Runs attempted or touched this resource?

The queries run in backend services and feed policy. The UI visualizes the same
results; it does not calculate the security verdict.

## The complete middleware loop

```text
MODEL proposes a bounded action
  -> IDENTITY attributes user, Agent, Run, and delegation
  -> AUTHORIZATION checks ownership and exact capability
  -> GRAPH computes downstream reach and sensitive paths
  -> HISTORY compares the action with trusted prior Runs
  -> POLICY allows, pauses, or blocks
  -> GATEWAY issues a one-time claim only when permitted
  -> ADAPTER performs the durable managed action
  -> TIMELINE records ordered evidence
  -> CONFIRMED OBSERVATIONS may update graph context
  -> ELIGIBLE SUCCESSFUL RUN EVENTS update the trusted behavioral baseline
  -> the next decision uses the updated model
```

## Current capabilities, near term, and long term

### Working now

- real Codex planning for named managed-resource requests;
- server-attested human, Agent, and Run identity;
- exact capability and owner enforcement;
- backend forward and reverse graph traversal;
- graph-informed blast radius with runtime consequences;
- trusted-history behavioral baselines with poisoning resistance;
- allow, review, hard-stop, approval, rejection, and breaker paths;
- one-time execution claims and a durable SQLite managed-resource effect;
- persisted, sequence-ordered Run timelines;
- quarantined relationship discovery from Agent output;
- bounded delegation with effective-permission intersection.

### Short term

- add more authoritative resource adapters behind the same gateway contract;
- add production identity-provider and reviewer separation of duty;
- add richer observation confirmation, ownership, and expiry workflows;
- show reverse-impact questions directly in the non-technical UI;
- use transactional outboxes for external APIs whose effects and audit records
  cannot share one database transaction.

### Long term

- make QuantQueens the policy and evidence plane across multi-Agent estates;
- learn organization-specific normal behavior without allowing poisoned Runs
  to normalize danger;
- combine service catalogs, credentials, data lineage, and Agent delegation in
  one operational impact model;
- simulate proposed plans against the graph before execution;
- support incident reconstruction, recovery workflows, and cross-system policy
  enforcement across many adapter types.

## Honest implementation boundary

- The proven controlled effect is the managed SQLite resource adapter.
- Protected prompts are interpreted by Codex in a read-only planning turn, then
  validated by the server before the gateway.
- Ordinary Codex filesystem, shell, connector, and network tools are not all
  intercepted by this gateway yet.
- The application currently has one configured authenticated principal for the
  session. Alice and Bob demonstrate ownership enforcement; they are not two
  separate logged-in browser users.
- Pending model-derived observations do not affect effective policy.
- The persisted timeline reconstructs the ordered facts of a Run; it does not
  provide deterministic replay or re-execution of arbitrary external effects.

## Judge Q&A

### “Is this just RBAC?”

No. RBAC is the first gate. The production request has valid permission but is
still paused because trusted history and the backend impact graph make it
unusually risky.

### “Is the graph only a visualization?”

No. The backend traversal returns the five-resource blast radius and restricted
customer-data path before execution. Those facts contribute to the recorded
risk decision that pauses the gateway.

### “Are the prompts hard-coded in the browser?”

No. The browser submits natural language. Codex proposes at most one bounded
managed action in a read-only planning turn; the server validates the proposal
against its resource catalog. The model cannot submit a trusted identity,
permission, graph path, risk score, or verdict.

### “Is the resource action real?”

Yes, within the documented managed-resource boundary. After policy and claim
checks, the SQLite adapter changes durable state. Denied and unapproved actions
return before a claim and before that effect.

### “Can discovered relationships grant access?”

No. Model-derived relationships start quarantined. Confirmation can add
topology context to future impact calculations, but only explicit `CAN_*`
authority can permit an action.

### “Why can production continue after it was stopped?”

It is paused at the review threshold, not hard blocked. The person approves the
exact request, and the gateway revalidates identity, payload, graph revision,
policy, and one-time claim before execution. Critical risk and missing
permission remain non-overridable.

### “Can repeated dangerous attempts teach the system that danger is normal?”

No. Only eligible completed and accepted Runs enter the trusted normal
baseline. Denied, blocked, failed, and quarantined behavior remains evidence
but cannot normalize its target.

### “Can delegation increase privilege?”

No. A delegated Agent receives only the intersection of origin authority,
parent authority, delegated scope, and the child Agent's own exact capability.
The origin and chain remain attributable to the Run.

### “Can an approval be reused?”

No. It is bound to the exact Run, payload, identity, and graph revision, then
consumed by a one-time execution claim.

### “Can you replay a Run?”

The flight recorder reconstructs execution order, identities, decisions,
resources, approval, and outcome from persisted events. It is honest audit
reconstruction, not deterministic re-execution of arbitrary side effects.

## Submission checklist

### Three-minute live presentation

- [ ] One real Agent Run uses the normal Playground.
- [ ] A familiar action succeeds through the gateway.
- [ ] An unauthorized action is denied without an effect.
- [ ] An authorized but risky action pauses, shows graph impact, and continues
      only after bounded approval.
- [ ] The relationship graph shows newly observed nodes and edges.
- [ ] The audit trail shows persisted decision and outcome evidence.

### One-page architecture diagram

Show the model, server identity boundary, authorization, graph/history policy,
Resource Gateway, real adapter, event timeline, observation loop, trust
boundary, and the point where execution can be stopped.

### Repository

Confirm setup instructions, problem and rationale, design summary, automated
tests, demo steps, limitations, and secret-handling guidance are present.

## Final closing line

> “QuantQueens does not merely report what an Agent did; it understands who is
> acting, what the action can affect, whether the behavior is normal, and
> intervenes before the protected effect occurs.”
