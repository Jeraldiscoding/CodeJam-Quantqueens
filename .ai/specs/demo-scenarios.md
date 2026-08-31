# Demo Scenarios

These scenarios are product proofs, not presentation scripts. Use deterministic
fixtures, persisted state, and the real managed SQLite adapter/sentinel. The
selected hackathon track is **Track B — The Bouncer**. Graph-informed adaptive
safety is an extension of the same backend boundary, not a second selected
track.

## Scenario 1: Track B owner boundary and identity-spoof denial

This is the primary judge flow.

### Setup

- The process has one configured authenticated principal: `human:alice`.
  The bearer token opens the demo application; it is not a second user login.
- Alice creates a fresh Agent through the normal API/UI path; creation persists
  `human:alice -> OWNS -> agent:<new ID>`.
- An administrator grants that new Agent one exact `CAN_READ` capability to
  `asset:alice-private-records`, which Alice owns.
- Bob is a deterministic second graph owner of
  `asset:bob-private-records`; Bob is not a separate authenticated browser
  session in this POC.
- The new Agent has no implicit resource capability before that grant. The
  managed resource adapter then performs a real durable SQLite read.

### Action and expected proof

1. Create the Agent, verify its persisted Alice ownership, apply the exact
   Alice-record grant, and trigger that Agent's managed read.
2. The server derives Alice from the configured Run identity, verifies Agent
   and resource ownership plus exact capability, and returns `200`. The adapter
   read is recorded as completed in the Run timeline.
3. Trigger the same Agent's managed read against Bob's record while sending a forged
   `claimedPrincipalId: human:bob` field and/or identity-like request header.
4. Request parsing and server identity resolution ignore those caller claims.
   Authorization returns `DENY` because the resource belongs to another
   principal; risk evaluation is not used to grant authority.
5. The denied request returns `403`, creates no execution claim, does not call
   the adapter for Bob's resource, and records the human, Agent, action,
   resource, decision, and no-effect outcome.
6. Reload the UI and retrieve the same sequence-ordered Run evidence.

This proves backend owner enforcement and spoof resistance inside the POC's
one-principal trust model. Do not present Bob as a separately logged-in user or
claim production multi-tenancy.

## Scenario 2: Allowed permission, five-resource impact, real block

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

1. Complete the three normal staging writes through the gateway and rebuild the
   persisted baseline from their successful ordered Run events.
2. Request a write to Deployment configuration using the unchanged declared
   capability. Server-side authorization returns `ALLOW`.
3. The backend graph query identifies five affected Resource nodes and the
   restricted Customer dataset path. The mature baseline identifies the target
   as novel and the impact as larger than the trusted maximum of three.
4. With default thresholds, sensitive downstream impact, novelty, and blast-
   radius expansion produce a risk `BLOCK`; the Agent-scoped breaker becomes
   `TRIPPED`.
5. The gateway returns before claim/adapter execution. Deployment
   configuration remains unchanged.
6. The sequence-ordered timeline records origin/Agent, request, authorization
   allow, risk block, breaker transition, blocked action, and terminal Run
   outcome. Reload/restart preserves the evidence, baseline, and breaker.
7. The UI labels the five nodes as what *would* have been affected, not as
   resources actually touched.

Cold-start behavior must also remain honest: before the three trusted Runs,
the same permitted production write reaches the sensitive Customer dataset and
pauses as `WARN` for approval rather than executing normally.

## Scenario 3: Delegation and poisoning-resistance adversarial proof

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
