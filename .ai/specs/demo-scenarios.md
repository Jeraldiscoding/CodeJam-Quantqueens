# Demo Scenarios

These scenarios are product proofs, not presentation scripts. Use deterministic
fixtures, persisted state, and the real managed SQLite adapter/sentinel. The
selected hackathon track is **Track B — The Bouncer**. Graph-informed adaptive
safety is an extension of the same backend boundary, not a second selected
track.

## Scenario 1: Prompt-driven owner boundary and cross-owner denial

This is the primary judge flow.

### Setup

- The process has one configured authenticated principal: `human:alice`.
  The bearer token opens the demo application; it is not a second user login.
- The operator selects seeded **Release Guardian** and submits a natural prompt
  through the normal Playground composer. Release Guardian is Alice-owned and
  has one exact `CAN_READ` capability to `asset:alice-private-records`, which
  Alice owns.
- Bob is a deterministic second graph owner of
  `asset:bob-private-records`; Bob is not a separate authenticated browser
  session in this POC.
- The browser submits prompt content only. Codex interprets a protected request
  in a read-only planning turn and may propose one Resource ID and capability
  from the server-provided managed catalog. The server validates that untrusted
  proposal before the gateway; the browser and model do not submit or choose a
  trusted identity, graph path, risk score, authorization, or verdict. Newly
  created Agents still receive no implicit Resource capability.

### Action and expected proof

1. Prompt Release Guardian with `Read Alice's private records.` and verify its
   persisted Alice ownership and exact capability before the managed read.
2. The server derives Alice from the configured Run identity, verifies Agent
   and resource ownership plus exact capability, and returns `200`. The adapter
   read is recorded as completed in the Run timeline.
3. Prompt the same Agent with `Read Bob's private records.` The browser sends
   only this content. Direct API adversarial tests additionally submit forged
   `claimedPrincipalId: human:bob` and identity-like headers.
4. Server identity resolution derives Alice from the Run and ignores direct
   caller claims. Authorization returns `DENY` because the resource belongs to
   another principal; risk evaluation is not used to grant authority.
5. The denied request returns `403`, creates no execution claim, does not call
   the adapter for Bob's resource, and records the human, Agent, action,
   resource, decision, and no-effect outcome.
6. Reload the UI and retrieve the same sequence-ordered Run evidence.

This proves prompt-driven backend owner enforcement and retains explicit spoof
resistance in adversarial integration coverage inside the POC's one-principal
trust model. Do not present Bob as a separately logged-in user or claim
production multi-tenancy.

## Scenario 2: Allowed permission, five-resource impact, reviewed continuation or hard block

This extension answers “Isn't this just RBAC with a graph?”

### Setup

- Release Guardian keeps the same explicit `CAN_WRITE` capability to both
  `asset:staging-config` and `asset:deployment-config` throughout the demo.
- Three trusted successful managed Runs establish staging as normal. Each
  staging action reaches three Resource nodes: Staging configuration, Staging
  service, and Synthetic dataset.
- The production action's backend impact query returns exactly five Resource
  nodes: Deployment configuration (the requested target), Customer dataset,
  Production service, Staging service, and Synthetic dataset.
- The sensitive path is exactly:
  `Deployment configuration -> Production service -> Customer dataset`.
  The restricted PII category is graph context beyond Customer dataset, but it
  is not counted as a Resource in the five-resource blast radius.

### Action and expected proof

1. Submit three natural staging-update prompts through the Playground. Complete
   their real writes through the gateway and rebuild the persisted baseline
   from their successful ordered Run events.
2. Prompt a write to Deployment configuration using the unchanged declared
   capability. Server-side authorization returns `ALLOW`.
3. The backend graph query identifies five affected Resource nodes and the
   restricted Customer dataset path. The mature baseline identifies the target
   as novel and the impact as larger than the trusted maximum of three.
4. With the fail-closed server default (`20/40`), sensitive downstream impact,
   novelty, and blast-radius expansion produce `BLOCK`; the Agent-scoped
   breaker becomes `TRIPPED`. With the presenter profile (`20/80`), the same
   score produces `WARN` and an approval bound to the exact Run, payload,
   identity, and graph revision.
5. Before approval, the gateway returns without a claim or adapter execution
   and Deployment configuration remains unchanged. In the presenter profile,
   approval and resume consume the request once, restore the WARN breaker, and
   then execute. Reject leaves the resource unchanged. A fail-closed BLOCK
   cannot be approved.
6. The sequence-ordered timeline records origin/Agent, request, authorization,
   risk, breaker transition, approval pause/resolution when applicable, claim,
   completion, and terminal Run outcome. Reload/restart preserves the evidence.
7. The UI labels the five nodes as what *would* have been affected, not as
   resources actually touched.

Cold-start behavior must also remain honest: before the three trusted Runs,
the same permitted production write reaches the sensitive Customer dataset and
pauses as `WARN` for approval rather than executing normally.

## Scenario 3: New Agent learns quarantined relationships from Run output

1. Create `Dependency Scout`. Provision only its Agent identity and the
   configured principal's accountability-only `OWNS` edge; do not infer a
   Resource capability.
2. Run a model prompt that describes `Checkout API calls Fraud Service` and
   `Fraud Service processes Customer records` without placing those natural-
   language statements directly in the user prompt.
3. On successful Run completion, extract the two supported relationship
   candidates from model output. Create missing asset/data nodes and persist
   `CALLS` and `PROCESSES` observations with Run provenance and confidence.
4. Show them as dashed pending edges in the whole-network graph. Pending
   observations must not appear in effective traversal, change risk, or grant
   permission.
5. Confirming an observation may add topology context to future bounded
   traversal. Rejecting it removes it from effective traversal. Neither state
   may create a `CAN_*` authority edge.

## Scenario 4: Delegation and poisoning-resistance adversarial proof

This is integration evidence, not the primary guided judge path.

1. First attempt to delegate from Alice-owned Release Guardian to the
   Marcus-owned Data Steward fixture. Backend ownership enforcement denies the
   cross-owner delegation before any child effect.
2. In a deterministic positive fixture, use a child Agent whose ownership does
   not conflict with Alice (new server-created Agents are assigned the
   configured owner), give parent and child the same exact managed-resource
   capability, then delegate only that narrow scope. Persist the origin Run,
   parent, child, depth, expiry, and effective intersection.
3. Execute the delegated action and reconstruct
   `Alice -> Run -> parent Agent -> child Agent -> Resource` from the ordered
   timeline and stored delegation.
4. Attempt an out-of-scope capability, forged parent, revoked/expired
   delegation, cross-owner child, and excessive nesting. Each must fail before
   adapter effect.
5. Repeat a blocked production attempt. It remains negative evidence and never
   enters the trusted normal scope. Restart and confirm the baseline revision,
   source Run IDs, and blocked result remain stable.

## Demo evidence checklist

For each scenario retain:

- exact declared/effective authorization evidence;
- backend graph query result and path;
- baseline revision and source Run IDs;
- risk/breaker factors and state transition;
- ordered persisted Run events;
- adapter invocation/sentinel state before and after;
- restart/reload result;
- plain-English UI screenshot or browser assertion.

Do not substitute seeded output, mocked frontend state, raw JSON, or simulated
post-hoc warnings for this evidence.
