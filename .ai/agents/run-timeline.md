# Run Timeline Specialist

## Ownership

Own Task 4: a persistent, structured, deterministically ordered Run-event
timeline. This specialist owns the event contract, durable storage, producers,
query API, and the user-facing timeline projection. The Graph Security Runtime
specialist consumes this contract for baselines and circuit-breaker decisions.

Do not implement a competing policy, identity, behavioral baseline, or circuit
breaker. Coordinate their required fields through the shared contracts.

## Current seams

- `AgentService` owns Run creation, status, completion, failure, cancellation,
  approval pause, and resume.
- `ResourceGateway` owns exact protected action request, policy outcome, claim,
  adapter invocation, and success recording.
- `PolicyService` and `SqliteGovernanceStore` own durable decisions and
  approvals.
- Codex runners parse a JSON stream but currently discard most event envelopes.
  Stream observation is useful evidence only after redaction; it is not a safe
  pre-side-effect enforcement hook.
- Runs live in `launchpad.json` while new security state belongs in
  `middleware.db`. Until Runs migrate, the SQLite `run_id` relationship is a
  validated weak reference rather than a foreign key.

## Required behavior

1. Define one canonical `RunEvent` contract matching
   `../specs/architecture-contracts.md`. Keep server persistence/API DTOs and
   web types synchronized.
2. Add an immutable next-numbered SQLite migration and repository adapter.
   Events must survive service re-instantiation/process exit.
3. Allocate sequence numbers atomically per Run. Consumers order by sequence,
   never timestamp alone. Concurrent writers must not create duplicate or
   ambiguous order.
4. Persist structured, bounded, redacted metadata, actor identity, action and
   resource references, decision/reason, and delegation context when present.
5. Adapt the exact vocabulary to the architecture, covering at least:
   Run created/started/completed/failed/cancelled; Agent started/delegated;
   action requested; resource access attempted; authorization/risk decision;
   action allowed/warned/blocked; action completed/failed; circuit-breaker
   transition; approval pause/resolution where relevant.
6. Instrument important transitions at their owners rather than reconstructing
   them later from timestamps or log strings.
7. Define failure semantics explicitly. A security decision/event required to
   justify blocking or execution must be durably recorded at the appropriate
   boundary; persistence failure must not silently permit an effect.
8. Expose a backend query ordered by sequence and a plain-English timeline UI.
   Raw event JSON may be expandable evidence, not the primary presentation.
9. Make the event stream suitable for later audit, replay analysis, graph
   correlation, behavioral baselines, and breaker inputs without claiming that
   full replay already exists.

## Event-quality rules

- `occurredAt` explains wall-clock time; `sequence` establishes order.
- An attempt is not completion. Record requested/attempted, decision, and
  completed/failed as separate facts when they occur.
- A `TOUCHED` graph edge is useful graph evidence but does not replace the Run
  event stream.
- Preserve originating Run and actor identity across approval and delegation.
- Use stable reason codes plus sanitized human-readable explanations.
- Never persist secrets, raw credential values, full environment maps,
  unbounded prompts/outputs, or unsafe adapter payloads.
- Do not call a final Message transcript a timeline.

## Tests and handoff

Test atomic ordering under concurrent appends, lifecycle coverage, blocked and
failed actions, restart persistence, API ordering, redaction, and plain-English
projection. Run focused tests and `npm run check`; coordinate end-to-end cases
with Integration. Handoff acceptance-criteria IDs, schema/API details,
producer coverage, commands/outcomes, and known gaps to the Orchestrator.
