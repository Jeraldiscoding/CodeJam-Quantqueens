import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { KnowledgeGraphService } from "./knowledge-graph.js";
import type { RunTimeline } from "./run-timeline.js";
import type { SecurityStore } from "./security-store.js";
import type {
  DelegationRecord,
  DelegationScope,
  ExecutionIdentity,
  PrincipalRole,
} from "./security-types.js";
import type { CapabilityRelation } from "./policy-store.js";

const scopeKey = (scope: DelegationScope) => `${scope.capability}\0${scope.targetNodeId}`;

export class DelegationService {
  constructor(
    private readonly security: SecurityStore,
    private readonly graph: KnowledgeGraphService,
    private readonly timeline: RunTimeline,
    private readonly maxDepth = 2,
  ) {}

  async delegate(input: {
    identity: ExecutionIdentity;
    childAgentId: string;
    requestedScope: DelegationScope[];
    expiresAt: string;
    reason?: string;
  }): Promise<DelegationRecord> {
    if (input.childAgentId === input.identity.actorAgentId) {
      throw new HttpError(400, "An Agent cannot delegate to itself");
    }
    await Promise.all([
      this.assertOwnedByOrigin(input.identity.actorAgentId, input.identity.principal.id),
      this.assertOwnedByOrigin(input.childAgentId, input.identity.principal.id),
    ]);
    const depth = input.identity.delegationChain.length + 1;
    if (depth > this.maxDepth) throw new HttpError(403, `Delegation depth cannot exceed ${this.maxDepth}`);
    const expiresAt = new Date(input.expiresAt).toISOString();
    if (expiresAt <= new Date().toISOString()) throw new HttpError(400, "Delegation must expire in the future");

    const allowedByRole = new Set(roleCapabilities(input.identity.principal.role));
    const parentScope = input.identity.delegation
      ? new Set(input.identity.delegation.effectiveScope.map(scopeKey))
      : null;
    const parentCapabilities = new Set(
      (await this.graph.listCapabilities(input.identity.actorAgentId))
        .map((edge) => `${edge.relation}\0${edge.targetId}`),
    );
    const childCapabilities = new Set(
      (await this.graph.listCapabilities(input.childAgentId))
        .map((edge) => `${edge.relation}\0${edge.targetId}`),
    );
    const unique = [...new Map(input.requestedScope.map((scope) => [scopeKey(scope), scope])).values()]
      .sort((left, right) => scopeKey(left).localeCompare(scopeKey(right)));
    if (unique.length === 0) throw new HttpError(400, "Delegation needs at least one exact resource capability");
    const outside = unique.find((scope) =>
      !allowedByRole.has(scope.capability) ||
      !parentCapabilities.has(scopeKey(scope)) ||
      !childCapabilities.has(scopeKey(scope)) ||
      (parentScope !== null && !parentScope.has(scopeKey(scope))),
    );
    if (outside) {
      throw new HttpError(
        403,
        `Delegation would exceed effective authority for ${outside.capability} on ${outside.targetNodeId}`,
      );
    }

    const createdAt = new Date().toISOString();
    const record: DelegationRecord = {
      id: `delegation:${randomUUID()}`,
      runId: input.identity.runId,
      originPrincipalId: input.identity.principal.id,
      parentAgentId: input.identity.actorAgentId,
      childAgentId: input.childAgentId,
      ...(input.identity.delegation ? { parentDelegationId: input.identity.delegation.id } : {}),
      depth,
      requestedScope: unique,
      effectiveScope: unique,
      status: "active",
      expiresAt,
      createdAt,
      reason: input.reason?.trim() ?? "",
    };
    await this.security.createDelegation(record);
    try {
      await this.timeline.append({
        runId: record.runId,
        type: "AGENT_DELEGATED",
        actor: actorFor(input.identity),
        agentId: record.childAgentId,
        delegation: eventDelegation(record),
        outcome: "allowed",
        reasonCode: "DELEGATION_SCOPE_INTERSECTION",
        reason: `Delegated ${record.effectiveScope.length} exact resource action${record.effectiveScope.length === 1 ? "" : "s"} without widening authority.`,
        metadata: { effectiveScope: record.effectiveScope },
      });
    } catch (error) {
      // A delegation without its required audit event must never remain usable.
      await this.security.revokeDelegation(
        record.id,
        "Automatically revoked because delegation event persistence failed",
        new Date().toISOString(),
      );
      throw error;
    }
    return record;
  }

  private async assertOwnedByOrigin(agentId: string, principalId: string): Promise<void> {
    const ownerIds = (await this.graph.ownersOfAgent(agentId)).map((owner) => owner.id);
    if (ownerIds.length > 0 && !ownerIds.includes(principalId)) {
      throw new HttpError(
        403,
        "Delegation cannot select an Agent owned by another authenticated person",
      );
    }
  }

  async revoke(identity: ExecutionIdentity, delegationId: string, reason: string): Promise<DelegationRecord> {
    const existing = await this.security.getDelegation(delegationId);
    if (!existing || existing.runId !== identity.runId || existing.originPrincipalId !== identity.principal.id) {
      throw new HttpError(403, "Delegation does not belong to this identity and Run");
    }
    if (existing.parentAgentId !== identity.actorAgentId && identity.principal.role !== "admin") {
      throw new HttpError(403, "Only the delegating Agent's origin or an administrator may revoke this delegation");
    }
    const record = await this.security.revokeDelegation(delegationId, reason, new Date().toISOString());
    await this.timeline.append({
      runId: record.runId,
      type: "DELEGATION_REVOKED",
      actor: actorFor(identity),
      agentId: record.childAgentId,
      delegation: eventDelegation(record),
      outcome: "cancelled",
      reasonCode: "DELEGATION_REVOKED",
      reason,
    });
    return record;
  }
}

export function roleCapabilities(role: ExecutionIdentity["principal"]["role"]): string[] {
  if (role === "viewer") return ["CAN_READ"];
  if (role === "approver") return [];
  return ["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"];
}

export function rolesForCapability(capability: CapabilityRelation): PrincipalRole[] {
  return (["viewer", "operator", "approver", "admin"] as const).filter((role) =>
    roleCapabilities(role).includes(capability),
  );
}
function actorFor(identity: ExecutionIdentity) {
  return {
    principalId: `agent:${identity.actorAgentId}`,
    kind: identity.delegation ? "delegated_agent" as const : "agent" as const,
    ...(identity.actorAgentDisplayName
      ? { displayName: identity.actorAgentDisplayName }
      : {}),
    originPrincipalId: identity.principal.id,
    originDisplayName: identity.principal.displayName,
    agentId: identity.actorAgentId,
    ...(identity.delegation
      ? { parentAgentId: identity.delegation.parentAgentId }
      : {}),
  };
}
function eventDelegation(record: DelegationRecord) {
  return { delegationId: record.id, parentAgentId: record.parentAgentId, childAgentId: record.childAgentId, depth: record.depth, effectiveCapabilities: record.effectiveScope.map((scope) => `${scope.capability}:${scope.targetNodeId}`) };
}
