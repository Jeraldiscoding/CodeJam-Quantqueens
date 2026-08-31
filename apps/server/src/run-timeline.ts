import { randomUUID } from "node:crypto";

export const runEventTypes = [
  "RUN_CREATED",
  "RUN_STARTED",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "RUN_CANCELLED",
  "AGENT_STARTED",
  "AGENT_DELEGATED",
  "DELEGATION_REVOKED",
  "ACTION_REQUESTED",
  "RESOURCE_ACCESS_ATTEMPTED",
  "AUTHORIZATION_DECIDED",
  "RISK_DECIDED",
  "ACTION_ALLOWED",
  "ACTION_WARNED",
  "ACTION_BLOCKED",
  "ACTION_COMPLETED",
  "ACTION_FAILED",
  "CIRCUIT_BREAKER_TRANSITIONED",
  "APPROVAL_PAUSED",
  "APPROVAL_RESOLVED",
] as const;

export type RunEventType = (typeof runEventTypes)[number];
export type RunEventOutcome =
  | "pending"
  | "allowed"
  | "warned"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunEventActor {
  principalId: string;
  kind: "human" | "agent" | "delegated_agent" | "system";
  displayName?: string;
  originPrincipalId?: string;
  originDisplayName?: string;
  agentId?: string;
  parentAgentId?: string;
}

export interface RunEventAction {
  operation: string;
  capability?: string;
  toolName?: string;
}

export interface RunEventResource {
  resourceId: string;
  label?: string;
  kind?: string;
}

export interface RunEventDecision {
  decisionId?: string;
  layer: "authorization" | "risk" | "circuit_breaker" | "approval";
  result: string;
  reasonCode?: string;
}

export interface RunEventDelegation {
  delegationId: string;
  parentAgentId: string;
  childAgentId: string;
  depth: number;
  effectiveCapabilities: string[];
}

export interface RunEvent {
  id: string;
  schemaVersion: 1;
  runId: string;
  sequence: number;
  type: RunEventType;
  occurredAt: string;
  actor: RunEventActor;
  agentId?: string;
  action?: RunEventAction;
  resource?: RunEventResource;
  decision?: RunEventDecision;
  delegation?: RunEventDelegation;
  correlationId?: string;
  causationId?: string;
  outcome: RunEventOutcome;
  reasonCode: string;
  reason: string;
  metadata: Record<string, unknown>;
}

export interface AppendRunEvent {
  id?: string;
  runId: string;
  type: RunEventType;
  occurredAt?: string;
  actor: RunEventActor;
  agentId?: string;
  action?: RunEventAction;
  resource?: RunEventResource;
  decision?: RunEventDecision;
  delegation?: RunEventDelegation;
  correlationId?: string;
  causationId?: string;
  outcome: RunEventOutcome;
  reasonCode: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * A required event has a deterministic identity and occurrence time so its
 * producer can safely repair an interrupted audit write without creating a
 * second fact or silently changing the original one.
 */
export type RequiredRunEvent = AppendRunEvent & {
  id: string;
  occurredAt: string;
};

export interface RunTimeline {
  append(input: AppendRunEvent): Promise<RunEvent>;
  /** Atomically inserts this fact once, or returns the identical existing fact. */
  appendRequired?(input: RequiredRunEvent): Promise<RunEvent>;
  /** Optional indexed lookup used by claim-time audit-readiness checks. */
  get?(runId: string, eventId: string): Promise<RunEvent | null>;
  list(runId: string): Promise<RunEvent[]>;
}

export interface RunTimelineItem extends RunEvent {
  summary: string;
}

export function newRunEventId(): string {
  return randomUUID();
}

export class RequiredRunEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequiredRunEventError";
  }
}

export interface RunEventRequirement {
  runId: string;
  eventId: string;
  type: RunEventType;
  decisionId?: string;
  correlationId?: string;
  outcome?: RunEventOutcome;
}

/**
 * Persist a security-relevant event idempotently. The SQLite adapter performs
 * this atomically. The fallback keeps test/custom adapters fail-closed and
 * verifies a racing writer rather than treating any conflict as success.
 */
export async function appendRequiredRunEvent(
  timeline: RunTimeline,
  input: RequiredRunEvent,
): Promise<RunEvent> {
  if (timeline.appendRequired) return timeline.appendRequired(input);
  const existing = await findRunEvent(timeline, input.runId, input.id);
  if (existing) return assertRequiredEvent(existing, input);
  try {
    return assertRequiredEvent(await timeline.append(input), input);
  } catch (error) {
    const raced = await findRunEvent(timeline, input.runId, input.id);
    if (raced) return assertRequiredEvent(raced, input);
    throw error;
  }
}

/** Fails closed unless the exact required audit fact is durably queryable. */
export async function requireRunEvent(
  timeline: RunTimeline,
  input: RequiredRunEvent,
): Promise<RunEvent> {
  const existing = await findRunEvent(timeline, input.runId, input.id);
  if (!existing) {
    throw new RequiredRunEventError(
      `Required Run event ${input.id} is unavailable; execution remains blocked`,
    );
  }
  return assertRequiredEvent(existing, input);
}

/**
 * Lightweight claim-time check for a required immutable fact. The caller
 * supplies stable correlation fields from authoritative decision records;
 * absence or a mismatched event blocks execution.
 */
export async function requireRunEventEvidence(
  timeline: RunTimeline,
  requirement: RunEventRequirement,
): Promise<RunEvent> {
  const event = await findRunEvent(timeline, requirement.runId, requirement.eventId);
  if (!event) {
    throw new RequiredRunEventError(
      `Required Run event ${requirement.eventId} is unavailable; execution remains blocked`,
    );
  }
  if (
    event.type !== requirement.type ||
    (requirement.decisionId !== undefined &&
      event.decision?.decisionId !== requirement.decisionId) ||
    (requirement.correlationId !== undefined &&
      event.correlationId !== requirement.correlationId) ||
    (requirement.outcome !== undefined && event.outcome !== requirement.outcome)
  ) {
    throw new RequiredRunEventError(
      `Required Run event ${requirement.eventId} does not match its decision evidence`,
    );
  }
  return event;
}

async function findRunEvent(
  timeline: RunTimeline,
  runId: string,
  eventId: string,
): Promise<RunEvent | null> {
  if (timeline.get) return timeline.get(runId, eventId);
  return (await timeline.list(runId)).find((event) => event.id === eventId) ?? null;
}

function assertRequiredEvent(existing: RunEvent, expected: RequiredRunEvent): RunEvent {
  const comparableExisting = withoutAllocatedFields(existing);
  const comparableExpected = normalizeRequiredInput(expected);
  if (canonicalJson(comparableExisting) !== canonicalJson(comparableExpected)) {
    throw new RequiredRunEventError(
      `Required Run event ${expected.id} exists with different audit evidence`,
    );
  }
  return existing;
}

function withoutAllocatedFields(event: RunEvent): Record<string, unknown> {
  const { sequence: _sequence, schemaVersion: _schemaVersion, ...rest } = event;
  return rest;
}

function normalizeRequiredInput(input: RequiredRunEvent): Record<string, unknown> {
  return {
    id: input.id,
    runId: input.runId,
    type: input.type,
    occurredAt: input.occurredAt,
    actor: input.actor,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(input.resource !== undefined ? { resource: input.resource } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(input.delegation !== undefined ? { delegation: input.delegation } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    outcome: input.outcome,
    reasonCode: input.reasonCode,
    reason: input.reason,
    metadata: input.metadata ?? {},
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return value === undefined ? '"[undefined]"' : JSON.stringify(value);
}

/**
 * The primary UI projection intentionally explains effect status in ordinary
 * language. Structured fields remain available for audit details.
 */
export function projectRunEvent(event: RunEvent): RunTimelineItem {
  const actor = event.actor.displayName ?? readableId(event.actor.agentId ?? event.actor.principalId);
  const resource = event.resource?.label ?? event.resource?.resourceId;
  const action = describeAction(event.action, resource);
  const explicitReason = event.reason.trim();

  let summary: string;
  switch (event.type) {
    case "RUN_CREATED":
      summary = `${actor} created this run.`;
      break;
    case "RUN_STARTED":
    case "AGENT_STARTED":
      summary = `${actor} started working on this run.`;
      break;
    case "RUN_COMPLETED":
      summary = `${actor} completed the run successfully.`;
      break;
    case "RUN_CANCELLED":
      summary = `${actor}'s run was cancelled before it completed.`;
      break;
    case "RUN_FAILED":
      summary = `${actor}'s run did not complete${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "AGENT_DELEGATED":
      summary = `${actor} delegated part of this run to ${readableId(event.delegation?.childAgentId ?? "another Agent")}.`;
      break;
    case "DELEGATION_REVOKED":
      summary = `${actor} ended the delegation to ${readableId(event.delegation?.childAgentId ?? "another Agent")}${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "ACTION_REQUESTED":
    case "RESOURCE_ACCESS_ATTEMPTED":
      summary = `${actor} tried to ${action}.`;
      break;
    case "AUTHORIZATION_DECIDED":
      summary = event.outcome === "allowed"
        ? `${actor} was allowed to ${action}.`
        : `${actor} was not permitted to ${action}${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "RISK_DECIDED":
      summary = `The safety check ${event.outcome === "blocked" ? "blocked" : event.outcome === "warned" ? "flagged" : "cleared"} ${actor}'s action${explicitReason ? ` because ${lowerFirst(explicitReason)}` : "."}`;
      break;
    case "ACTION_ALLOWED":
      summary = `${actor}'s request to ${action} was allowed to proceed.`;
      break;
    case "ACTION_WARNED":
      summary = `${actor}'s request to ${action} needs attention${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "ACTION_BLOCKED":
      summary = `${actor}'s request to ${action} was blocked before anything changed or the protected action ran${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "ACTION_COMPLETED":
      summary = `${actor} completed the request to ${action}; ${completedEffect(event.action?.capability)}`;
      break;
    case "ACTION_FAILED":
      summary = `${actor}'s attempt to ${action} failed${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "CIRCUIT_BREAKER_TRANSITIONED":
      summary = `The safety stop changed to ${event.decision?.result ?? event.outcome}${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "APPROVAL_PAUSED":
      summary = `The run paused for a person's approval${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
    case "APPROVAL_RESOLVED":
      summary = `A person ${event.outcome === "allowed" ? "approved" : "rejected"} the request${explicitReason ? `: ${explicitReason}` : "."}`;
      break;
  }
  return { ...event, summary };
}

function readableId(value: string): string {
  const suffix = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
  return suffix.replaceAll(/[-_]/g, " ");
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

function describeAction(action: RunEventAction | undefined, resource?: string): string {
  const target = resource ? ` ${resource}` : " this resource";
  switch (action?.capability) {
    case "CAN_READ":
      return `read${target}`;
    case "CAN_WRITE":
      return `change${target}`;
    case "CAN_CALL":
      return `call${target}`;
    case "CAN_USE":
      return `use${target}`;
  }
  const operation = action?.operation;
  if (operation && !looksLikeOperationId(operation)) {
    return `${operation.replaceAll(/[_-]+/g, " ")}${resource ? ` on ${resource}` : ""}`;
  }
  return resource ? `perform a protected action on ${resource}` : "perform a protected action";
}

function looksLikeOperationId(value: string): boolean {
  return value.includes(":") || /[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(value);
}

function completedEffect(capability?: string): string {
  if (capability === "CAN_READ") return "the protected read completed.";
  if (capability === "CAN_CALL") return "the protected call completed.";
  if (capability === "CAN_USE") return "the scoped access was issued.";
  if (capability === "CAN_WRITE") return "the managed change took effect.";
  return "the protected action completed.";
}
