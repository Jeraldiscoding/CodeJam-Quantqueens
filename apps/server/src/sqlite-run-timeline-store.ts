import { isDeepStrictEqual } from "node:util";
import type { MiddlewareDatabase } from "./middleware-database.js";
import {
  assertIsoTimestamp,
  assertNonEmptyText,
  assertOneOf,
  MiddlewareStoreError,
  parseJsonObject,
  rethrowSqliteConstraint,
  serializeSafeJsonObject,
} from "./middleware-validation.js";
import {
  newRunEventId,
  runEventTypes,
  type AppendRunEvent,
  type RunEvent,
  type RunEventAction,
  type RunEventActor,
  type RunEventDecision,
  type RunEventDelegation,
  type RunEventOutcome,
  type RunEventResource,
  type RunTimeline,
  type RequiredRunEvent,
} from "./run-timeline.js";

const outcomes = ["pending", "allowed", "warned", "blocked", "succeeded", "failed", "cancelled"] as const;
const actorKinds = ["human", "agent", "delegated_agent", "system"] as const;
const decisionLayers = ["authorization", "risk", "circuit_breaker", "approval"] as const;
const MAX_METADATA_BYTES = 8_192;
const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_KEYS = 40;
const MAX_ARRAY_ITEMS = 30;
const MAX_STRING_LENGTH = 500;
const SECRET_KEY = /(?:password|passphrase|secret|client.?secret|api.?key|access.?key|authorization|cookie|jwt|session.?id|token|private.?key|credential)s?$/i;

interface RunEventRow {
  id: string;
  schema_version: number;
  run_id: string;
  sequence: number;
  event_type: string;
  occurred_at: string;
  actor_json: string;
  agent_id: string | null;
  action_json: string | null;
  resource_json: string | null;
  decision_json: string | null;
  delegation_json: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  outcome: string;
  reason_code: string;
  reason: string;
  metadata_json: string;
}

export class SqliteRunTimelineStore implements RunTimeline {
  constructor(
    private readonly database: MiddlewareDatabase,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async append(input: AppendRunEvent): Promise<RunEvent> {
    const prepared = prepareInput(input, this.clock);
    try {
      return this.database.transaction(() => this.insertPrepared(prepared));
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Run event ${prepared.id} already exists`,
        "Run event violates the timeline schema",
      );
    }
  }

  async appendRequired(input: RequiredRunEvent): Promise<RunEvent> {
    const prepared = prepareInput(input, this.clock);
    try {
      return this.database.transaction(() => {
        const existing = this.database.connection
          .prepare("SELECT * FROM run_events WHERE id = ?")
          .get(prepared.id) as RunEventRow | undefined;
        if (!existing) return this.insertPrepared(prepared);

        const stored = toRunEvent(existing);
        const expected = eventFromPrepared(prepared, existing.sequence);
        if (!isDeepStrictEqual(withoutAllocatedFields(stored), withoutAllocatedFields(expected))) {
          throw new MiddlewareStoreError(
            "CONFLICT",
            `Required Run event ${prepared.id} exists with different audit evidence`,
          );
        }
        return stored;
      });
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Required Run event ${prepared.id} already exists with different evidence`,
        "Required Run event violates the timeline schema",
      );
    }
  }

  async get(runId: string, eventId: string): Promise<RunEvent | null> {
    assertNonEmptyText(runId, "Run ID");
    assertNonEmptyText(eventId, "Run event ID");
    const row = this.database.connection
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND id = ?")
      .get(runId, eventId) as RunEventRow | undefined;
    return row ? toRunEvent(row) : null;
  }

  async list(runId: string): Promise<RunEvent[]> {
    assertNonEmptyText(runId, "Run ID");
    const rows = this.database.connection
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as RunEventRow[];
    return rows.map(toRunEvent);
  }

  private insertPrepared(prepared: PreparedRunEvent): RunEvent {
    const allocated = this.database.connection
      .prepare(`
        INSERT INTO run_event_sequences (run_id, last_sequence)
        VALUES (?, 1)
        ON CONFLICT(run_id) DO UPDATE
          SET last_sequence = run_event_sequences.last_sequence + 1
        RETURNING last_sequence AS sequence
      `)
      .get(prepared.runId) as { sequence: number };

    this.database.connection
      .prepare(`
        INSERT INTO run_events (
          id, schema_version, run_id, sequence, event_type, occurred_at,
          actor_json, agent_id, action_json, resource_json, decision_json,
          delegation_json, correlation_id, causation_id, outcome,
          reason_code, reason, metadata_json
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        prepared.id,
        prepared.runId,
        allocated.sequence,
        prepared.type,
        prepared.occurredAt,
        prepared.actorJson,
        prepared.agentId,
        prepared.actionJson,
        prepared.resourceJson,
        prepared.decisionJson,
        prepared.delegationJson,
        prepared.correlationId,
        prepared.causationId,
        prepared.outcome,
        prepared.reasonCode,
        prepared.reason,
        prepared.metadataJson,
      );
    return eventFromPrepared(prepared, allocated.sequence);
  }
}

function prepareInput(input: AppendRunEvent, clock: () => string) {
  const id = input.id ?? newRunEventId();
  const occurredAt = input.occurredAt ?? clock();
  assertSafeReference(id, "Run event ID");
  assertSafeReference(input.runId, "Run ID");
  assertOneOf(input.type, runEventTypes, "Run event type");
  assertIsoTimestamp(occurredAt, "Run event occurrence time");
  assertOneOf(input.outcome, outcomes, "Run event outcome");
  assertSafeReference(input.reasonCode, "Run event reason code", 120);
  assertNonEmptyText(input.reason, "Run event reason", 1_000);
  const reason = redactText(input.reason).slice(0, 1_000);
  const actor = sanitizeActor(input.actor);
  if (input.agentId !== undefined) assertSafeReference(input.agentId, "Agent ID");
  const action = sanitizeAction(input.action);
  const resource = sanitizeResource(input.resource);
  const decision = sanitizeDecision(input.decision);
  const delegation = sanitizeDelegation(input.delegation);
  if (input.correlationId !== undefined) assertSafeReference(input.correlationId, "Correlation ID");
  if (input.causationId !== undefined) assertSafeReference(input.causationId, "Causation ID");

  const metadata = sanitizeMetadata(input.metadata ?? {});
  const metadataJson = serializeSafeJsonObject(metadata, "Run event metadata");
  if (Buffer.byteLength(metadataJson, "utf8") > MAX_METADATA_BYTES) {
    throw new Error(`Run event metadata must be no larger than ${MAX_METADATA_BYTES} bytes`);
  }

  return {
    id,
    runId: input.runId,
    type: input.type,
    occurredAt,
    actorJson: serializeSafeJsonObject(actor as unknown as Record<string, unknown>, "Run event actor"),
    agentId: input.agentId ?? actor.agentId ?? null,
    actionJson: action ? serializeSafeJsonObject(action as unknown as Record<string, unknown>, "Run event action") : null,
    resourceJson: resource ? serializeSafeJsonObject(resource as unknown as Record<string, unknown>, "Run event resource") : null,
    decisionJson: decision ? serializeSafeJsonObject(decision as unknown as Record<string, unknown>, "Run event decision") : null,
    delegationJson: delegation ? serializeSafeJsonObject(delegation as unknown as Record<string, unknown>, "Run event delegation") : null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    reason,
    metadataJson,
  };
}

type PreparedRunEvent = ReturnType<typeof prepareInput>;

function sanitizeActor(actor: RunEventActor): RunEventActor {
  assertSafeReference(actor.principalId, "Actor principal ID");
  assertOneOf(actor.kind, actorKinds, "Actor kind");
  if (actor.originPrincipalId !== undefined) assertSafeReference(actor.originPrincipalId, "Origin principal ID");
  if (actor.agentId !== undefined) assertSafeReference(actor.agentId, "Actor Agent ID");
  if (actor.parentAgentId !== undefined) assertSafeReference(actor.parentAgentId, "Parent Agent ID");
  return {
    principalId: actor.principalId,
    kind: actor.kind,
    ...(actor.displayName !== undefined
      ? { displayName: sanitizeDisplayText(actor.displayName, "Actor display name", 120) }
      : {}),
    ...(actor.originPrincipalId !== undefined ? { originPrincipalId: actor.originPrincipalId } : {}),
    ...(actor.originDisplayName !== undefined
      ? { originDisplayName: sanitizeDisplayText(actor.originDisplayName, "Origin display name", 120) }
      : {}),
    ...(actor.agentId !== undefined ? { agentId: actor.agentId } : {}),
    ...(actor.parentAgentId !== undefined ? { parentAgentId: actor.parentAgentId } : {}),
  };
}

function sanitizeAction(action?: RunEventAction): RunEventAction | undefined {
  if (!action) return undefined;
  assertSafeReference(action.operation, "Action operation", 120);
  if (action.capability !== undefined) assertSafeReference(action.capability, "Action capability", 120);
  return {
    operation: action.operation,
    ...(action.capability !== undefined ? { capability: action.capability } : {}),
    ...(action.toolName !== undefined
      ? { toolName: sanitizeDisplayText(action.toolName, "Action tool name", 120) }
      : {}),
  };
}

function sanitizeResource(resource?: RunEventResource): RunEventResource | undefined {
  if (!resource) return undefined;
  assertSafeReference(resource.resourceId, "Resource ID");
  if (resource.kind !== undefined) assertSafeReference(resource.kind, "Resource kind", 80);
  return {
    resourceId: resource.resourceId,
    ...(resource.label !== undefined
      ? { label: sanitizeDisplayText(resource.label, "Resource label", 180) }
      : {}),
    ...(resource.kind !== undefined ? { kind: resource.kind } : {}),
  };
}

function sanitizeDecision(decision?: RunEventDecision): RunEventDecision | undefined {
  if (!decision) return undefined;
  assertOneOf(decision.layer, decisionLayers, "Decision layer");
  assertSafeReference(decision.result, "Decision result", 80);
  if (decision.decisionId !== undefined) assertSafeReference(decision.decisionId, "Decision ID");
  if (decision.reasonCode !== undefined) assertSafeReference(decision.reasonCode, "Decision reason code", 120);
  return { ...decision };
}

function sanitizeDelegation(delegation?: RunEventDelegation): RunEventDelegation | undefined {
  if (!delegation) return undefined;
  assertSafeReference(delegation.delegationId, "Delegation ID");
  assertSafeReference(delegation.parentAgentId, "Delegation parent Agent ID");
  assertSafeReference(delegation.childAgentId, "Delegation child Agent ID");
  if (!Number.isSafeInteger(delegation.depth) || delegation.depth < 1 || delegation.depth > 16) {
    throw new Error("Delegation depth must be between 1 and 16");
  }
  if (delegation.effectiveCapabilities.length > 30) {
    throw new Error("Delegation capability list is too large");
  }
  for (const capability of delegation.effectiveCapabilities) {
    assertSafeReference(capability, "Delegated capability", 120);
  }
  return { ...delegation, effectiveCapabilities: [...delegation.effectiveCapabilities] };
}

function sanitizeDisplayText(value: string, field: string, maxLength: number): string {
  assertNonEmptyText(value, field, maxLength);
  return redactText(value).slice(0, maxLength);
}

function assertSafeReference(value: string, field: string, maxLength = 180): void {
  assertNonEmptyText(value, field, maxLength);
  if (redactText(value) !== value) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      `${field} must not contain secret-like text because it is a stable reference`,
    );
  }
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(value, 0);
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= MAX_METADATA_DEPTH) return { truncated: "[maximum depth reached]" };
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_METADATA_KEYS)) {
    const secretBearing = SECRET_KEY.test(key);
    const safeKey = secretBearing ? `${key.slice(0, 105)}Redacted` : key.slice(0, 120);
    sanitized[safeKey] = secretBearing ? "[REDACTED]" : sanitizeValue(item, depth + 1);
  }
  if (Object.keys(value).length > MAX_METADATA_KEYS) sanitized.truncated = "[additional fields omitted]";
  return sanitized;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_METADATA_DEPTH) return "[maximum depth reached]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value).slice(0, MAX_STRING_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return sanitizeObject(value as Record<string, unknown>, depth);
    }
  }
  return `[unsupported ${typeof value}]`;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function eventFromPrepared(prepared: PreparedRunEvent, sequence: number): RunEvent {
  return toRunEvent({
    id: prepared.id,
    schema_version: 1,
    run_id: prepared.runId,
    sequence,
    event_type: prepared.type,
    occurred_at: prepared.occurredAt,
    actor_json: prepared.actorJson,
    agent_id: prepared.agentId,
    action_json: prepared.actionJson,
    resource_json: prepared.resourceJson,
    decision_json: prepared.decisionJson,
    delegation_json: prepared.delegationJson,
    correlation_id: prepared.correlationId,
    causation_id: prepared.causationId,
    outcome: prepared.outcome,
    reason_code: prepared.reasonCode,
    reason: prepared.reason,
    metadata_json: prepared.metadataJson,
  });
}

function withoutAllocatedFields(event: RunEvent): Omit<RunEvent, "schemaVersion" | "sequence"> {
  const { schemaVersion: _schemaVersion, sequence: _sequence, ...rest } = event;
  return rest;
}

function toRunEvent(row: RunEventRow): RunEvent {
  assertOneOf(row.event_type, runEventTypes, "Stored Run event type");
  assertOneOf(row.outcome, outcomes, "Stored Run event outcome");
  const actor = parseJsonObject(row.actor_json, "Run event actor") as unknown as RunEventActor;
  const event: RunEvent = {
    id: row.id,
    schemaVersion: 1,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.event_type,
    occurredAt: row.occurred_at,
    actor,
    outcome: row.outcome as RunEventOutcome,
    reasonCode: row.reason_code,
    reason: row.reason,
    metadata: parseJsonObject(row.metadata_json, "Run event metadata"),
  };
  if (row.agent_id !== null) event.agentId = row.agent_id;
  if (row.action_json !== null) event.action = parseJsonObject(row.action_json, "Run event action") as unknown as RunEventAction;
  if (row.resource_json !== null) event.resource = parseJsonObject(row.resource_json, "Run event resource") as unknown as RunEventResource;
  if (row.decision_json !== null) event.decision = parseJsonObject(row.decision_json, "Run event decision") as unknown as RunEventDecision;
  if (row.delegation_json !== null) event.delegation = parseJsonObject(row.delegation_json, "Run event delegation") as unknown as RunEventDelegation;
  if (row.correlation_id !== null) event.correlationId = row.correlation_id;
  if (row.causation_id !== null) event.causationId = row.causation_id;
  return event;
}
