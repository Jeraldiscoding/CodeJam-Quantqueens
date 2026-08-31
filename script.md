# QuantQueens: Context, Pitch, and Demo Script

> Presenter-ready guide for the verified repository state on 2026-08-31.
> Use this document to explain what was built, run the live judge flow, answer
> technical questions, and distinguish current capabilities from future plans.

## How to use this file

- Need one sentence: use [The message to remember](#the-message-to-remember).
- Need a quick pitch: use the [30-second elevator pitch](#30-second-elevator-pitch).
- Need the fastest live proof: use the [90-second demonstration](#90-second-lightning-demonstration).
- Presenting to judges: use the [three-to-four-minute script](#three-to-four-minute-judge-script).
- Presenting to engineers: use the [technical script](#seven-to-ten-minute-technical-script).
- Discussing the roadmap: use the [capability map](#capability-map-now-next-and-long-term),
  [short-term story](#short-term-product-story), and [long-term vision](#long-term-vision).
- Preparing for questions: rehearse [judge Q&A](#questions-judges-are-likely-to-ask)
  and the [presenter safety rails](#presenter-safety-rails).

## The message to remember

> **Permissions tell us what an Agent may do. QuantQueens also understands what
> the Agent normally does, what its action could affect, and when an otherwise
> permitted action should be stopped before anything changes.**

QuantQueens is runtime middleware between an Agent request and a protected
resource effect. It is not primarily a dashboard, a visual permission table,
or an after-the-fact logging system.

```text
Agent request
  -> server-attested human, Run, and Agent identity
  -> exact authorization and ownership check
  -> graph impact and dependency traversal
  -> trusted-history comparison
  -> risk and circuit-breaker decision
  -> one-time execution claim
  -> real controlled resource effect
  -> ordered persistent evidence
  -> updated behavioral baseline
  -> updated context for the next Run
```

The shortest product description is:

> **QuantQueens turns authorization from a static permission check into an
> adaptive, explainable safety decision.**

## Context: what has been built

The selected hackathon track is **Track B — The Bouncer**. The repository now
proves a complete, deliberately narrow middleware loop:

- A newly created Agent receives a distinct server-side Agent identity and a
  persisted ownership relationship to Alice.
- Creating an Agent grants no implicit resource access. An administrator must
  create an exact capability such as `CAN_READ` for one resource.
- Alice's managed record is read through a real SQLite-backed resource adapter.
- The same Agent is denied Bob's record even when the request claims to be Bob.
  Caller-controlled identity cannot replace the server-attested Run origin.
- A denial returns before an execution claim or adapter effect.
- Backend graph traversal answers forward and reverse reachability questions,
  calculates downstream impact, and returns explainable dependency paths.
- Trusted successful Runs build a versioned behavioral baseline. The current
  window inspects the latest 20 completed Runs; only eligible trusted Runs in
  that window contribute to normal behavior.
- A later action can remain explicitly authorized yet be blocked because it is
  novel, broader than normal, and connected to sensitive downstream resources.
- A persistent circuit breaker stops the effect before the adapter changes the
  resource.
- Every meaningful transition is recorded as a structured, immutable,
  sequence-ordered Run event.
- Reload and restart preserve identity, permissions, Runs, graph facts,
  decisions, baseline revisions, breaker state, effects, and receipts.
- Delegation preserves the origin and complete chain, intersects authority,
  and rechecks every ancestor before the effect. It cannot silently expand
  privilege.
- Stop closes protected-action admission and drains admitted work before it
  reports the Agent as stopped.
- Claim acquisition is atomic and single-use; the managed effect and its
  idempotent receipt are committed atomically. Concurrent protected requests
  for the same Agent admit one active Run, and a claimed Run/operation can
  execute only once.

The most important proof is not that the UI says **Blocked**. It is that the
backend creates no execution claim, the adapter is not invoked, the durable
resource remains unchanged, and the evidence explains why.

### Verified release evidence

- `npm run check`: 24 test files and 162 tests passed, followed by both
  workspace typechecks and both production builds.
- `npm run test:e2e`: the production-build Chromium judge flow passed.
- Full and production npm audits: zero reported vulnerabilities.
- Docker image build, Compose validation, container health, and live health
  endpoint: passed.
- Independent integration and critic reviews: **PASS** against every required
  acceptance criterion.

## Before the presentation

### Start from deterministic fresh state

The core middleware proof does not need an Ark key, Codex, or an external model
call. From the repository root:

```bash
DEMO_ROOT="$(mktemp -d)"

APP_DATA_DIR="$DEMO_ROOT/data" \
AGENT_WORKSPACE_ROOT="$DEMO_ROOT/workspaces" \
CODEX_HOME="$DEMO_ROOT/codex-home" \
HOST=127.0.0.1 \
PORT=3000 \
APP_AUTH_TOKEN="" \
APP_PRINCIPAL_ID=human:alice \
APP_PRINCIPAL_NAME=Alice \
APP_PRINCIPAL_ROLE=admin \
ARK_API_KEY="" \
ARK_MODEL="" \
NODE_ENV=development \
SEED_DEMO_DATA=true \
POLICY_ENFORCEMENT=on \
POLICY_REVIEW_THRESHOLD=20 \
POLICY_DENY_THRESHOLD=40 \
npm run dev
```

Open <http://127.0.0.1:5173>.

This uses isolated temporary state, so previous baselines or breaker state
cannot alter the presentation. Press `Ctrl+C` when finished. The temporary
directory is not deleted automatically.

### Optional confidence check before judges arrive

```bash
npm run check
# One-time only if Playwright's browser is not installed:
npx playwright install chromium
npm run test:e2e
```

Expected evidence:

- 24 test files and 162 tests pass.
- Both TypeScript workspaces typecheck.
- Both production bundles build.
- One Playwright judge scenario passes.

### If presenting from existing state

- Create a fresh Agent for the Alice/Bob proof; do not reuse a previously
  authorized Agent.
- If **Release Guardian** is stopped, select it and click **Start**.
- If **Release Guardian** shows **Safety stop: active**, select **Reset safety
  stop** before beginning its extended scenario.
- If Release Guardian has a pending review/approval Run, resolve or reject that
  Run before presenting. Using fresh state is safer than repairing ambiguous
  demo state live.
- If **3. Normal staging learned** is already visible, the trusted baseline is
  ready; continue to the production action.
- If the page was reloaded, run **2. Prove Alice/Bob boundary** again so the
  local guided sequence enables its next step.

## One-sentence pitch

> **QuantQueens is an adaptive enforcement layer that verifies who an Agent is,
> understands what its action could affect, learns what normal execution looks
> like, and stops unsafe effects before they happen.**

## 30-second elevator pitch

Say:

> “Most Agent-safety products either define static permissions or explain
> failures after the fact. QuantQueens sits directly in the protected action
> path. It verifies the human, Agent, Run, and delegation chain; checks exact
> permission; traverses the dependency graph; compares the request with trusted
> previous Runs; and then allows, pauses, or blocks the real effect.
>
> Every decision is persisted and explainable. A valid read executes, a forged
> cross-user read never reaches the resource, and even a permitted production
> change can be stopped when it is unusual and could reach customer data.”

## 90-second lightning demonstration

Use this version when time is extremely limited.

1. Click **Create Agent**, name it **Alice Boundary Judge**, and create it.
2. Open **Playground** and point to **Alice → Alice Boundary Judge** and **No
   resource permission has been granted yet**.
3. Click **1. Grant Alice-only read**, then **2. Prove Alice/Bob boundary**.
4. Point to:
   - **Alice's private records — Read completed through the protected adapter**
   - **Bob's private records — Permission denied; caller-supplied identity
     ignored**
   - **Permission: Denied · Safety: Not needed · Resource: Prevented**
5. Select **Release Guardian**, open **Playground**, click **2. Prove Alice/Bob
   boundary**, click **3. Teach normal staging work**, then **4. Try broader
   production change**.
6. Point to:
   - **Permission: Allowed · Safety: Blocked · Resource: Prevented**
   - **Safety stop: active**
   - **Impact 5 resources · Effect never claimed**

Say:

> “The first result proves exact identity and ownership enforcement. The
> second proves this is more than RBAC: permission still says yes, while
> trusted history and downstream customer-data impact make the middleware say
> no. In both cases the decision happens before the controlled effect.”

## Three-to-four-minute judge script

### 0:00–0:20 — Establish the problem

Say:

> “Giving an Agent permission is not the same as making its behavior safe.
> Traditional RBAC can tell us that an Agent may change a configuration. It
> cannot tell us whether this request is unusual, what depends on that
> configuration, or whether this particular effect should be stopped now.
>
> QuantQueens adds that missing runtime decision layer. This is middleware,
> not a dashboard: every result I will show comes from the backend execution
> path and persisted state.”

### 0:20–0:45 — Create a fresh Agent

Do:

1. Click **Create Agent**.
2. Enter:
   - Name: **Alice Boundary Judge**
   - Description: **Created live for the official Track B proof**
   - Instructions: **Use only explicitly granted resources.**
3. Click **Create Agent**.
4. Open **Playground**.

Point to:

- **Guided safety proof is ready**
- **Alice → Alice Boundary Judge**
- **No resource permission has been granted yet**

Say:

> “This Agent did not exist before the demo. The server persists a distinct
> Agent identity and records that Alice owns it. Creation grants no implicit
> resource permission. The model credential is not needed because these
> controls exercise the protected backend path directly.”

### 0:45–1:20 — Prove identity and exact authorization

Do:

1. Click **1. Grant Alice-only read**.
2. Point out **One exact Alice-data permission is active**.
3. Click **2. Prove Alice/Bob boundary**.

Point to:

- **Alice's private records — Read completed through the protected adapter**
- **Bob's private records — Permission denied; caller-supplied identity
  ignored**
- **Permission: Denied**
- **Safety: Not needed**
- **Resource: Prevented**

Say:

> “The first button created one exact `CAN_READ` capability—never wildcard
> access. The second button sent two protected requests. Alice's record reached
> the real managed SQLite adapter.
>
> The Bob request deliberately claimed that the caller was Bob. The server
> ignored that caller-controlled identity, reconstructed Alice from the Run,
> checked Agent and resource ownership, and denied the action. Authorization
> failed before risk evaluation, so there was no execution claim and no Bob
> resource effect.”

### 1:20–1:45 — Show the flight recorder and Stop boundary

Do:

1. Click **Inspect denied Run**.
2. Point to **Persistent run record**, **What happened**, and the numbered
   events.
3. Click **Stop** in the Agent header.
4. Reload the page.
5. Reselect **Alice Boundary Judge** if necessary and open **Playground**.

Say:

> “This is not a browser-assembled log. It is a sequence-ordered, persisted Run
> record showing who attempted what, against which resource, why it was denied,
> and whether anything changed.
>
> Stop is also a backend barrier, not a cosmetic toggle. It closes admission,
> drains protected work already in flight, and rejects future protected actions
> before a claim or effect. Reload confirms that status, permission, ownership,
> and evidence are durable.”

Presenter note: the checked-in browser test makes the post-Stop protected
request and verifies backend `409`. The normal UI shows the stopped state and
disables the controls; do not say `409` is visibly shown unless DevTools is
open.

### 1:45–2:40 — Prove this is more than RBAC

Do:

1. Select **Release Guardian**.
2. Open **Playground**.
3. Click **2. Prove Alice/Bob boundary**.
4. Click **3. Teach normal staging work**.

Point to:

- **3. Normal staging learned**
- **A staging pattern is ready for comparison**
- **Permission: Allowed · Safety: Allowed · Resource: Completed**

Say:

> “Now I will answer the harder question: isn't this just RBAC with a graph?
>
> One click performs three successful staging writes through the same gateway.
> Only safely completed, mediated Runs enter the bounded behavioral baseline.
> Denied, blocked, failed, or prompt-only attempts cannot teach the system that
> dangerous behavior is normal.
>
> Most importantly, I am not changing RBAC. Release Guardian remains explicitly
> allowed to write both staging and production configuration.”

Do:

5. Click **4. Try broader production change**.

Point to:

- **Permission: Allowed**
- **Safety: Blocked**
- **Resource: Prevented**
- **Safety stop: active**
- **What could be affected**, including Production service and Customer dataset
- **Impact 5 resources · Effect never claimed**

Say:

> “Permission says yes. The middleware says no.
>
> The backend graph finds five resources that could be affected, including the
> path from Deployment configuration to Production service to Customer
> dataset. Trusted history says this target is novel and its impact is larger
> than the normal three-resource staging pattern.
>
> Those facts trip the persistent circuit breaker before the adapter can change
> production. These are resources that *would have been affected*—they were not
> touched.”

### 2:40–3:20 — Connect enforcement, evidence, and learning

Do:

1. Click **View persistent Run timeline**.
2. Point out the separate allowed authorization, blocked safety decision,
   breaker transition, and prevented effect.
3. Reload, reselect **Release Guardian** if necessary, open **Playground**, and
   show the same ordered evidence and **Safety stop: active**.
4. If time permits, open **Impact map**, select **Customer dataset**, and show
   the highlighted dependency path.

Say:

> “We preserve both decisions because ‘unauthorized’ and ‘authorized but
> unsafe’ are fundamentally different. The timeline explains who acted, what
> they requested, why risk changed, and whether an effect occurred.
>
> The breaker and evidence survive reload. The Impact map displays the same
> backend graph facts that policy queried before the decision; it does not
> calculate the result in the browser.
>
> Eligible completed Runs update the bounded historical context available to
> future decisions. Unsafe attempts remain evidence, but never become trusted
> normal behavior.”

Close with:

> **“QuantQueens does not merely show us what an Agent did. It determines what
> the Agent may do next—and proves that an unsafe effect never happened.”**

## Seven-to-ten-minute technical script

Use the judge flow above, but pause at the following five ideas.

### 1. Preserve three different truths

Say:

> “The middleware asks three separate questions:
>
> 1. Is the exact action permitted?
> 2. Is it safe in this runtime context?
> 3. Did the resource effect actually happen?
>
> Most products collapse these into one status. QuantQueens persists them as
> separate, correlated facts: **Permission**, **Safety**, and **Resource**.”

Explain that an authorization `DENY` cannot be overridden by graph proximity,
history, ownership, or delegation. An authorization `ALLOW` is only permission
to enter contextual risk evaluation; it is not an instruction to execute.

### 2. Explain the real pre-effect boundary

Say:

> “Even an accepted policy result is not enough to execute. The middleware
> creates a request-bound, one-time claim. At effect time, the SQLite boundary
> rechecks the claim, payload, correlated decisions, current role, exact
> capability, ownership, full delegation chain, adapter binding, and breaker
> version in the same transaction as the managed read or write.”

Then add:

> “The durable receipt makes retries idempotent. In the independent concurrency
> test, two simultaneous requests produced exactly one success, one conflict,
> one claim, one receipt, and one resource revision.”

### 3. Show how the graph changes behavior

Open **Impact map** after the production block and focus **Customer dataset**.

Say:

> “Only a direct, explicit `CAN_*` edge grants authority. The graph never grants
> access through proximity. Its job is operational context: what the requested
> resource depends on, what depends on it, which Agents or Runs could affect
> it, and which sensitive systems lie downstream.
>
> This same backend traversal produced the five-resource impact and customer-
> data path used by policy before the effect. The UI is rendering that decision
> evidence, not inventing a decorative graph.”

### 4. Explain the adaptive feedback loop

Say:

> “The baseline is deterministic, versioned, and persisted. It inspects the
> latest 20 completed Runs, then allows only eligible trusted Runs in that
> bounded window to contribute to normal behavior. It records the exact source
> Run IDs and window used by each decision.
>
> Failed, denied, blocked, incomplete, and unconfirmed prompt-only behavior
> cannot enter normal history. Repeating an attack cannot train the middleware
> to accept it. A later decision cites the frozen baseline revision that
> influenced its outcome.”

Use this loop:

```text
MODEL     identity + authority + dependencies + trusted history
DECIDE    authorization first, contextual risk second
ENFORCE   approval + breaker + one-time claim
EXECUTE   authoritative managed adapter
OBSERVE   ordered Run events + graph audit evidence
LEARN     only accepted completed Runs enter the baseline
UPDATE    the next decision uses the new historical context
```

### 5. Explain delegation, Stop, and reconstruction

Say:

> “Delegation is attributable execution context, not new authority. The system
> persists the origin user, parent, child, Run, requested scope, effective
> intersection, depth, expiry, and revocation state. Parent and child authority
> is rechecked during evaluation, claim, and atomically at effect time.”

> “Stop first closes admission and drains active protected leases. Once Stop
> returns, an already admitted action cannot create a late claim or effect.”

> “The timeline is honest reconstruction: order, actors, decisions, resources,
> delegation, failures, and outcomes. It is not deterministic re-execution of
> arbitrary external systems.”

## Capability map: now, next, and long term

| Area | Verified today | Short-term expansion | Long-term direction |
| --- | --- | --- | --- |
| Identity | Server-attested human, Agent, Run, and delegation attribution; spoofed request identity is ignored | OIDC sessions, tenant identity, requester/approver separation | Federated identity across Agent frameworks and organizations |
| Authorization | Exact capabilities, RBAC, Agent ownership, and resource ownership | Policy-as-code and managed permission workflows | Cross-platform authorization fabric |
| Graph intelligence | Forward/reverse reachability, dependency paths, affected Agents/Runs, and bounded blast radius | Import infrastructure, credential, service, and data-lineage facts | A continuously updated operational world model |
| Adaptive safety | Versioned bounded trusted-Run baseline; novelty and impact affect later decisions | Recency-aware statistics and configurable deterministic policies | Organization-wide behavioral intelligence with explainable anomaly models |
| Enforcement | Pre-effect gateway, approval, breaker, one-time claim, real SQLite effect | Protected adapters for deployment, file, secret, database, and SaaS operations | Universal Agent-tool mediation through SDK, proxy, or sandbox enforcement |
| Delegation | Durable lineage, scope intersection, expiry/revocation, depth limits, and ancestor revalidation | Delegation review workflows and operator visualization | Safe multi-Agent orchestration across teams and vendors |
| Audit | Immutable ordered Run timeline and persisted safety evidence | Retention, search, export, compliance packages, and richer filters | Cross-system forensic reconstruction and continuous assurance |
| Reliability | Atomic local effect/receipt, idempotency, stop/drain, and concurrency protection | Transactional outbox and remote-effect reconciliation | Distributed execution guarantees and replicated policy state |
| UX | Plain-language permission, safety, impact, effect, and timeline views | Approval workflows and broader accessibility/responsive coverage | Role-specific operator, auditor, developer, and executive experiences |

## Short-term product story

QuantQueens can be introduced first around the Agent actions where one mistake
would be most expensive:

- production configuration and deployment changes;
- customer-data reads and writes;
- credential and secret use;
- shared database mutations;
- high-impact infrastructure or SaaS calls.

A credible initial rollout is:

1. Select five to ten high-consequence actions.
2. Implement each as an explicit protected adapter.
3. Import only the ownership and dependency facts needed to explain impact.
4. Observe trusted executions to establish a bounded baseline.
5. Begin unusual actions in approval mode.
6. Promote deterministic high-confidence patterns to automatic blocking.
7. Use completed Run evidence to refine topology and policy safely.

This creates practical value without pretending every Agent tool is mediated on
day one.

## Long-term vision

QuantQueens can become the runtime nervous system for autonomous organizations.

Before any Agent changes anything, the platform should be able to answer:

- Who initiated this?
- Which Agent is acting, through what delegation chain?
- Is the exact action authorized?
- Is it normal for this Agent in this environment?
- Which systems, data, Agents, or customers could be affected?
- Which policy or reviewer must approve it?
- Can the effect execute idempotently and recover safely?
- What evidence must be retained?
- What should future decisions learn from the outcome?

The long-term architecture is not a larger dashboard. It is a distributed,
vendor-neutral enforcement fabric connected to Agent frameworks, tool
protocols, identity providers, service gateways, infrastructure graphs, data
catalogs, deployment systems, and observability platforms.

The durable graph and Run history become an institutional safety memory across
the Agent fleet: dependency-aware intervention, controlled delegation,
explainable anomaly detection, policy simulation, and evidence for human and
regulatory oversight.

## Questions judges are likely to ask

### “Isn't this just RBAC?”

No. RBAC makes the first decision. In the production demonstration, exact
authorization remains `ALLOW`. Graph impact, historical novelty, and breaker
state independently produce `BLOCK`, preventing the effect without changing
the permission.

### “Is the graph only a visualization?”

No. Policy calls backend graph traversal before the effect. The returned
five-resource impact and customer-data path are persisted in the risk decision
and help cause the block. The Impact map displays backend truth.

### “Is the action mocked?”

No. The protected read and write use durable SQLite managed state. Successful
effects create idempotent receipts and update or read real state. Blocked
actions receive no execution claim and leave the resource unchanged. The data
is a deterministic hackathon fixture; the middleware operation is real.

### “Is the learning just a changing number?”

No. The baseline is rebuilt from persisted, completed, safely mediated Run
events. It records its revision, source Runs, history bounds, normal
action/resource scope, and impact statistics. A future decision consumes that
frozen revision.

### “Can repeated attacks teach the system that the attack is normal?”

No. Denied, blocked, failed, incomplete, and prompt-only actions cannot enter
the trusted-normal baseline.

### “Can a caller pretend to be another user?”

No. Protected requests use the server-attested origin stored with the Run.
Caller-supplied identity fields and identity-like headers are ignored. The
current POC uses one configured human session; full OIDC-backed multi-user
identity is future work.

### “Can a delegated Agent gain more privilege?”

Not through the protected managed-action path. Delegated authority is an
intersection, never a union. Origin, every parent, requested scope, child
capability, ownership, expiry, revocation, and depth are checked. The full
chain is revalidated before the managed effect. Ordinary unmediated Codex tools
remain outside this guarantee.

### “Does Stop really stop execution?”

Yes for the protected action path. Stop closes admission and drains active
leases before storing the stopped state. Subsequent protected actions return
`409` before a claim or effect. Only explicit Start reopens admission.

### “Can the same approved Run/operation execute twice?”

The request-bound claim is single use and the effect receipt is idempotent.
The same claimed Run/operation cannot mutate twice. Separately admitted,
sequential requests are distinct operations and may each execute if policy
allows them.

### “Can you replay a Run?”

The system provides durable execution reconstruction: ordered actors,
decisions, resources, delegation, failures, and outcomes. It does not claim
deterministic re-execution of arbitrary external effects.

### “Does every Codex action use the gateway?”

No. The current strongest guarantee covers the declared managed SQLite adapter.
Ordinary Codex shell, filesystem, connector, and network operations are outside
that action-level boundary. Adding protected adapters and sandbox mediation is
the primary expansion path.

### “Why does the demo not call an LLM?”

The judge flow deliberately invokes the protected action path deterministically
so identity, policy, graph impact, effect prevention, learning, and persistence
can be proven without model or network variability. Model-backed chat remains
available when Ark is configured.

### “Can this safely control remote systems today?”

The decision protocol is suitable for remote adapters, but the strongest
atomic guarantee today is local SQLite. Remote effects need a transactional
outbox, stable operation IDs, delivery acknowledgements, and reconciliation.

## Presenter safety rails

Do not say:

- “Bob logs into the application.”
- “This is already a production multi-tenant identity system.”
- “Every Codex or Agent tool passes through the gateway.”
- “The graph grants permission through transitive reachability.”
- “The five production resources were touched.”
- “Replay deterministically reruns arbitrary effects.”
- “The system uses sophisticated machine learning.”
- “Remote effects have the same atomicity as SQLite.”
- “The UI is the security boundary.”

Say instead:

- “Bob is a deterministic second resource owner used to prove backend
  enforcement and identity-spoof resistance.”
- “The current POC has one server-configured authenticated human.”
- “The managed adapter is the fully proven protected-action boundary.”
- “Only explicit direct capabilities grant authority; the graph supplies
  operational impact.”
- “The five resources are what would have been affected; the effect was
  prevented.”
- “The timeline provides durable, ordered reconstruction.”
- “The system uses deterministic, explainable behavioral adaptation.”
- “Remote adapters are the next reliability expansion.”
- “The UI renders decisions made and persisted by the backend.”

## Memorable closing

> **“Agent systems should not be trusted merely because we can see what they
> did. They should be trusted because we can prove unsafe actions were stopped
> before they happened—and because trusted execution history becomes bounded,
> explainable context for the next decision.”**

## Source-of-truth references

- [README](README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Current weaknesses](docs/CURRENT_WEAKNESSES.md)
- [Demo scenarios](.ai/specs/demo-scenarios.md)
- [Acceptance criteria](.ai/specs/acceptance-criteria.md)
- [Playwright judge flow](tests/e2e/judge-flow.spec.ts)
