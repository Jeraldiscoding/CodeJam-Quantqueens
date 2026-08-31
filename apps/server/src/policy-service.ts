import { randomUUID } from "node:crypto";
import type { GraphEdge, GraphNode, GraphStore } from "./graph-types.js";
import { HttpError } from "./errors.js";
import type { ActionImpact, KnowledgeGraphService, ResourceImpact } from "./knowledge-graph.js";
import type { BehavioralRiskService } from "./behavioral-security.js";
import { MiddlewareStoreError } from "./middleware-validation.js";
import { computeRequestHash, digestOf } from "./policy-hash.js";
import type {
  ApprovalEventRecord,
  ApprovalRequestRecord,
  CapabilityRelation,
  GovernanceStore,
  PolicyDecisionRecord,
  PolicyResult,
} from "./policy-store.js";
import {
  appendRequiredRunEvent,
  requireRunEventEvidence,
  type RequiredRunEvent,
  type RunTimeline,
} from "./run-timeline.js";
import type { SecurityStore } from "./security-store.js";
import type {
  AuthorizationDecision,
  CircuitBreakerRecord,
  DelegationRecord,
  ExecutionIdentity,
  RiskDecision,
} from "./security-types.js";
import { roleCapabilities, rolesForCapability } from "./delegation-service.js";

export const POLICY_VERSION = "kg-policy-1";
const INTEGRATED_POLICY_VERSION = `${POLICY_VERSION}+behavior-v1`;

export interface PolicyThresholds {
  /** Above this score an action pauses for a human approval. */
  reviewThreshold: number;
  /** Above this score an action is refused outright and cannot be approved. */
  denyThreshold: number;
  approvalTtlMs: number;
}

export interface ProtectedActionRequest {
  operationId: string;
  runId: string;
  agentId: string;
  capability: CapabilityRelation;
  targetNodeId: string;
  payload?: Record<string, unknown> | undefined;
  actorPrincipalId?: string;
  identity?: ExecutionIdentity;
}

export interface PolicyEvaluation {
  decision: PolicyDecisionRecord;
  approvalRequest?: ApprovalRequestRecord;
  graphRevision: string;
  impact: ActionImpact | null;
  authorization?: AuthorizationDecision;
  risk?: RiskDecision;
}

export interface IntegratedPolicyRuntime {
  security: SecurityStore;
  risk: BehavioralRiskService;
  timeline: RunTimeline;
}

export interface DecisionDetail {
  decision: PolicyDecisionRecord;
  approvalRequest: ApprovalRequestRecord | null;
  events: ApprovalEventRecord[];
  claimed: boolean;
  authorization?: AuthorizationDecision;
  risk?: RiskDecision;
}

const now = () => new Date().toISOString();
const MAX_TIMELINE_SOURCE_RUN_IDS = 20;

interface DelegationAuthorityHopEvidence {
  delegationId: string;
  parentAgentId: string;
  childAgentId: string;
  scopeAllowed: boolean;
  parentCapabilityEdgeId: string | null;
  childCapabilityEdgeId: string | null;
  parentOwnerIds: string[];
  childOwnerIds: string[];
  parentOwnershipAllowed: boolean;
  childOwnershipAllowed: boolean;
}

interface DelegationAuthorityEvidence {
  scopeAllowed: boolean;
  capabilityAllowed: boolean;
  ownershipAllowed: boolean;
  hops: DelegationAuthorityHopEvidence[];
}

/**
 * The only component allowed to decide whether a protected action may run.
 *
 * It never trusts a caller-supplied score, capability, or approval. Every
 * decision is recomputed from stored graph facts, persisted, and correlated
 * with graph evidence before the Resource Gateway is permitted to act.
 */
export class PolicyService {
  constructor(
    private readonly graph: KnowledgeGraphService,
    private readonly graphStore: GraphStore,
    private readonly governance: GovernanceStore,
    private readonly thresholds: PolicyThresholds,
    private readonly integrated?: IntegratedPolicyRuntime,
  ) {
    if (thresholds.denyThreshold < thresholds.reviewThreshold) {
      throw new Error("The deny threshold must not be lower than the review threshold");
    }
  }

  get policyThresholds(): PolicyThresholds {
    return { ...this.thresholds };
  }

  /**
   * Evaluates one protected action and records the outcome. Callers must treat
   * anything other than ALLOW as a refusal to execute.
   */
  async evaluate(
    request: ProtectedActionRequest,
    options: { forceReviewReason?: string } = {},
  ): Promise<PolicyEvaluation> {
    if (request.identity && this.integrated) {
      return this.evaluateIntegrated(request, request.identity);
    }
    const agentNodeId = `agent:${request.agentId}`;
    const target = await this.requireAssetNode(request.targetNodeId);
    const graphRevision = await this.graph.getAgentGraphRevision(request.agentId);
    const payloadDigest = digestOf(request.payload ?? null);
    const requestHash = computeRequestHash({
      policyVersion: POLICY_VERSION,
      runId: request.runId,
      agentNodeId,
      capability: request.capability,
      targetNodeId: target.id,
      graphRevision,
      payloadDigest,
    });

    const impact = await this.graph.calculateActionImpact(
      request.agentId,
      request.capability,
      target.id,
    );

    const outcome = this.decide(impact, options.forceReviewReason);
    const createdAt = now();
    const decision: PolicyDecisionRecord = {
      id: `decision:${randomUUID()}`,
      operationId: request.operationId,
      runId: request.runId,
      agentNodeId,
      capabilityRelation: request.capability,
      targetNodeId: target.id,
      result: outcome.result,
      reasonCode: outcome.reasonCode,
      ...(impact ? { matchedCapabilityId: impact.capabilityEdge.id } : {}),
      riskScore: impact?.score ?? 0,
      riskThreshold: this.thresholds.reviewThreshold,
      policyVersion: POLICY_VERSION,
      requestHash,
      evidence: {
        graphRevision,
        payloadDigest,
        denyThreshold: this.thresholds.denyThreshold,
        actorPrincipalId: request.actorPrincipalId ?? "principal:unknown",
        scoredTargets:
          impact?.targets.map((item) => ({
            id: item.node.id,
            label: item.node.label,
            riskWeight: item.node.riskWeight,
            classification: item.node.classification,
            path: item.path.nodeIds,
          })) ?? [],
      },
      ...(outcome.result === "REVIEW_REQUIRED"
        ? { expiresAt: new Date(Date.parse(createdAt) + this.thresholds.approvalTtlMs).toISOString() }
        : {}),
      createdAt,
    };

    const recorded = await this.governance.recordEvaluation({
      decision,
      ...(outcome.result === "REVIEW_REQUIRED"
        ? { approvalRequestId: `approval:${randomUUID()}` }
        : {}),
    });

    await this.recordAttempt(recorded.decision);
    if (recorded.decision.result === "DENY") {
      await this.recordDenial(recorded.decision);
    }

    return {
      decision: recorded.decision,
      ...(recorded.approvalRequest ? { approvalRequest: recorded.approvalRequest } : {}),
      graphRevision,
      impact,
    };
  }

  private async evaluateIntegrated(
    request: ProtectedActionRequest,
    identity: ExecutionIdentity,
  ): Promise<PolicyEvaluation> {
    const integrated = this.integrated;
    if (!integrated) throw new HttpError(503, "Integrated policy runtime is unavailable");
    if (request.runId !== identity.runId || request.agentId !== identity.actorAgentId) {
      throw new HttpError(403, "The protected action does not match the resolved execution identity");
    }
    const agentNodeId = identity.actorAgentNodeId;
    const target = await this.requireAssetNode(request.targetNodeId);
    const graphRevision = await this.graph.getAgentGraphRevision(identity.actorAgentId);
    const payloadDigest = digestOf(request.payload ?? null);
    const requestHash = computeRequestHash({
      policyVersion: INTEGRATED_POLICY_VERSION,
      runId: request.runId,
      agentNodeId,
      capability: request.capability,
      targetNodeId: target.id,
      graphRevision,
      payloadDigest,
    });
    const capabilityEdge = (await this.graph.listCapabilities(identity.actorAgentId)).find(
      (edge) => edge.relation === request.capability && edge.targetId === target.id,
    );
    const [agentOwners, resourceOwners] = await Promise.all([
      this.graph.ownersOfAgent(identity.actorAgentId),
      this.graph.ownersOfResource(target.id),
    ]);
    const agentOwnerIds = agentOwners.map((owner) => owner.id).sort();
    const resourceOwnerIds = resourceOwners.map((owner) => owner.id).sort();
    const roleAllowed = roleCapabilities(identity.principal.role).includes(request.capability);
    const agentOwnershipAllowed =
      agentOwnerIds.length === 0 || agentOwnerIds.includes(identity.principal.id);
    const resourceOwnershipAllowed =
      resourceOwnerIds.length === 0 || resourceOwnerIds.includes(identity.principal.id);
    const delegationAuthority = await this.inspectDelegationAuthority(
      identity.delegationChain,
      identity.principal.id,
      request.capability,
      target.id,
    );
    const delegationAllowed =
      delegationAuthority.scopeAllowed &&
      delegationAuthority.capabilityAllowed &&
      delegationAuthority.ownershipAllowed;
    const authorizationResult =
      roleAllowed && agentOwnershipAllowed && resourceOwnershipAllowed && delegationAllowed && capabilityEdge
        ? "ALLOW"
        : "DENY";
    const authorizationReason = !roleAllowed
      ? "ROLE_DOES_NOT_ALLOW_ACTION"
      : !agentOwnershipAllowed
        ? "AGENT_OWNED_BY_ANOTHER_PRINCIPAL"
        : !resourceOwnershipAllowed
          ? "RESOURCE_OWNED_BY_ANOTHER_PRINCIPAL"
          : !delegationAllowed
            ? !delegationAuthority.scopeAllowed
              ? "OUTSIDE_DELEGATED_SCOPE"
              : !delegationAuthority.capabilityAllowed
                ? "DELEGATION_SOURCE_CAPABILITY_REVOKED"
                : "DELEGATION_AGENT_OWNERSHIP_CHANGED"
            : !capabilityEdge
              ? "NO_DIRECT_CAPABILITY"
              : "ROLE_AND_EXACT_CAPABILITY_ALLOW";
    const createdAt = now();
    const policyDecisionId = `decision:${randomUUID()}`;
    const authorization: AuthorizationDecision = {
      id: `authz:${randomUUID()}`,
      policyDecisionId,
      runId: request.runId,
      originPrincipalId: identity.principal.id,
      actorAgentId: identity.actorAgentId,
      ...(identity.delegation ? { delegationId: identity.delegation.id } : {}),
      role: identity.principal.role,
      capability: request.capability,
      targetNodeId: target.id,
      result: authorizationResult,
      reasonCode: authorizationReason,
      ...(capabilityEdge ? { matchedCapabilityId: capabilityEdge.id } : {}),
      evidence: {
        authenticationSource: identity.principal.authenticationSource,
        originDisplayName: identity.principal.displayName,
        actorAgentDisplayName: identity.actorAgentDisplayName ?? null,
        roleAllowed,
        agentOwnerIds,
        agentOwnershipAllowed,
        resourceOwnerIds,
        resourceOwnershipAllowed,
        directCapability: capabilityEdge?.id ?? null,
        delegationAllowed,
        delegationScopeAllowed: delegationAuthority.scopeAllowed,
        delegationSourceCapabilitiesAllowed: delegationAuthority.capabilityAllowed,
        delegationAgentOwnershipAllowed: delegationAuthority.ownershipAllowed,
        delegationAuthorityHops: delegationAuthority.hops,
        delegationDepth: identity.delegationChain.length,
        rootAgentId: identity.rootAgentId,
      },
      createdAt,
    };

    let impact: ActionImpact | null = null;
    let riskDraft: Awaited<ReturnType<BehavioralRiskService["assess"]>> | null = null;
    let resourceImpact: ResourceImpact | null = null;
    if (authorizationResult === "ALLOW") {
      impact = await this.graph.calculateActionImpact(identity.actorAgentId, request.capability, target.id);
      if (!impact) throw new HttpError(503, "Authorized capability disappeared during evaluation");
      resourceImpact = await this.graph.downstreamDependents(target.id);
      riskDraft = await integrated.risk.assess({
        policyDecisionId,
        authorization,
        identity,
        target,
        impact: resourceImpact,
        graphRevision,
        createdAt,
      });
    }
    const result: PolicyResult = authorizationResult === "DENY"
      ? "DENY"
      : riskDraft!.decision.result === "ALLOW"
        ? "ALLOW"
        : riskDraft!.decision.result === "WARN"
          ? "REVIEW_REQUIRED"
          : "DENY";
    const reasonCode = authorizationResult === "DENY"
      ? authorizationReason
      : riskDraft!.decision.reasonCode;
    const decision: PolicyDecisionRecord = {
      id: policyDecisionId,
      operationId: request.operationId,
      runId: request.runId,
      agentNodeId,
      capabilityRelation: request.capability,
      targetNodeId: target.id,
      result,
      reasonCode,
      ...(capabilityEdge ? { matchedCapabilityId: capabilityEdge.id } : {}),
      riskScore: riskDraft?.decision.score ?? 0,
      riskThreshold: this.thresholds.reviewThreshold,
      policyVersion: INTEGRATED_POLICY_VERSION,
      requestHash,
      evidence: {
        graphRevision,
        payloadDigest,
        originPrincipalId: identity.principal.id,
        authorizationDecisionId: authorization.id,
        authorizationResult,
        blastRadius: resourceImpact?.blastRadius ?? 0,
        ...(riskDraft ? {
          riskDecisionId: riskDraft.decision.id,
          riskResult: riskDraft.decision.result,
          baselineId: riskDraft.decision.baselineId,
          baselineRevision: riskDraft.decision.baselineRevision,
          factors: riskDraft.decision.factors,
        } : {}),
        // This is the exact backend reverse-impact projection used by the
        // integrated risk decision. Keep `scoredTargets` as a compatibility
        // alias for existing API consumers, but do not mix it with the legacy
        // forward traversal (which may contain unconfirmed observations).
        impactTargets: resourceImpact?.targets.map((item) => ({
          id: item.node.id,
          label: item.node.label,
          riskWeight: item.node.riskWeight,
          classification: item.node.classification,
          path: item.path.nodeIds,
        })) ?? [],
        sensitiveTargetIds: resourceImpact?.sensitiveTargets.map((item) => item.id) ?? [],
        scoredTargets: resourceImpact?.targets.map((item) => ({
          id: item.node.id,
          label: item.node.label,
          riskWeight: item.node.riskWeight,
          classification: item.node.classification,
          path: item.path.nodeIds,
        })) ?? [],
      },
      ...(result === "REVIEW_REQUIRED" ? {
        expiresAt: new Date(Date.parse(createdAt) + this.thresholds.approvalTtlMs).toISOString(),
      } : {}),
      createdAt,
    };
    const recorded = await this.governance.recordEvaluation({
      decision,
      ...(result === "REVIEW_REQUIRED" ? { approvalRequestId: `approval:${randomUUID()}` } : {}),
    });
    // The governance store makes operation IDs idempotent. If this exact
    // request was already evaluated, reuse its correlated security evidence;
    // attempting to persist a second authorization/risk row would both violate
    // the one-decision invariant and obscure the eventual one-time claim error.
    if (recorded.decision.id !== decision.id) {
      const existingAuthorization = await integrated.security.getAuthorizationForPolicy(recorded.decision.id);
      const existingRisk = await integrated.security.getRiskForPolicy(recorded.decision.id);
      if (!existingAuthorization) {
        throw new HttpError(
          503,
          "Persisted policy state is missing its authorization evidence; execution remains blocked",
        );
      }
      if (
        existingAuthorization.originPrincipalId !== identity.principal.id ||
        existingAuthorization.actorAgentId !== identity.actorAgentId
      ) {
        throw new HttpError(403, "This operation belongs to a different execution identity");
      }
      if (existingAuthorization.result === "ALLOW" && !existingRisk) {
        throw new HttpError(
          503,
          "Persisted policy state is missing its risk evidence; execution remains blocked",
        );
      }
      await this.ensureIntegratedDecisionEvents(
        identity,
        target,
        request,
        existingAuthorization,
        existingRisk,
        recorded.approvalRequest?.id,
      );
      await this.recordAttempt(recorded.decision);
      if (recorded.decision.result === "DENY") await this.recordDenial(recorded.decision);
      return {
        decision: recorded.decision,
        ...(recorded.approvalRequest ? { approvalRequest: recorded.approvalRequest } : {}),
        graphRevision,
        impact,
        ...(existingAuthorization ? { authorization: existingAuthorization } : {}),
        ...(existingRisk ? { risk: existingRisk } : {}),
      };
    }
    await integrated.security.recordAuthorization(authorization);
    const storedRisk = riskDraft
      ? await integrated.security.recordRiskAndTransition(
          riskDraft.decision,
          riskDraft.requestedState,
        )
      : null;

    await this.ensureIntegratedDecisionEvents(
      identity,
      target,
      request,
      authorization,
      storedRisk?.risk ?? null,
      recorded.approvalRequest?.id,
      storedRisk?.previousState,
    );
    await this.recordAttempt(recorded.decision);
    if (recorded.decision.result === "DENY") await this.recordDenial(recorded.decision);
    return {
      decision: recorded.decision,
      ...(recorded.approvalRequest ? { approvalRequest: recorded.approvalRequest } : {}),
      graphRevision,
      impact,
      authorization,
      ...(storedRisk ? { risk: storedRisk.risk } : {}),
    };
  }

  private async ensureIntegratedDecisionEvents(
    identity: ExecutionIdentity,
    target: GraphNode,
    request: ProtectedActionRequest,
    authorization: AuthorizationDecision,
    risk: RiskDecision | null,
    approvalRequestId?: string,
    knownPreviousState?: "NORMAL" | "WARN" | "TRIPPED",
  ): Promise<void> {
    await this.appendAuthorizationEvent(identity, target, request, authorization);
    if (risk) {
      await this.appendRiskEvents(
        identity,
        target,
        request,
        authorization,
        risk,
        knownPreviousState ?? inferPreviousBreakerState(risk),
        approvalRequestId,
      );
      return;
    }
    if (authorization.result !== "DENY") {
      throw new HttpError(503, "Allowed authorization is missing its required risk evidence");
    }
    await appendRequiredRunEvent(this.integrated!.timeline, {
      id: authorizationActionEventId(authorization.id),
      runId: request.runId,
      type: "ACTION_BLOCKED",
      occurredAt: authorization.createdAt,
      actor: timelineActor(identity, authorization),
      agentId: identity.actorAgentId,
      action: { operation: request.operationId, capability: request.capability },
      resource: timelineResource(target),
      decision: {
        decisionId: authorization.id,
        layer: "authorization",
        result: "DENY",
        reasonCode: authorization.reasonCode,
      },
      ...timelineDelegationField(identity),
      outcome: "blocked",
      reasonCode: authorization.reasonCode,
      reason: authorizationBlockReason(authorization.reasonCode),
    });
  }

  private async appendAuthorizationEvent(
    identity: ExecutionIdentity,
    target: GraphNode,
    request: ProtectedActionRequest,
    authorization: AuthorizationDecision,
  ): Promise<void> {
    await appendRequiredRunEvent(this.integrated!.timeline, {
      id: authorizationDecisionEventId(authorization.id),
      runId: request.runId,
      type: "AUTHORIZATION_DECIDED",
      occurredAt: authorization.createdAt,
      actor: timelineActor(identity, authorization),
      agentId: identity.actorAgentId,
      action: { operation: request.operationId, capability: request.capability },
      resource: timelineResource(target),
      decision: { decisionId: authorization.id, layer: "authorization", result: authorization.result, reasonCode: authorization.reasonCode },
      ...timelineDelegationField(identity),
      outcome: authorization.result === "ALLOW" ? "allowed" : "blocked",
      reasonCode: authorization.reasonCode,
      reason: authorization.result === "ALLOW"
        ? "The person's role and this Agent's exact resource permission allow this kind of action."
        : authorizationBlockReason(authorization.reasonCode),
      metadata: authorization.evidence,
    });
  }

  private async appendRiskEvents(
    identity: ExecutionIdentity,
    target: GraphNode,
    request: ProtectedActionRequest,
    authorization: AuthorizationDecision,
    risk: RiskDecision,
    previousState: "NORMAL" | "WARN" | "TRIPPED",
    approvalRequestId?: string,
  ): Promise<void> {
    const outcome = risk.result === "ALLOW" ? "allowed" : risk.result === "WARN" ? "warned" : "blocked";
    const immutableEvidence = await this.riskTimelineEvidence(risk);
    const common = {
      runId: request.runId,
      actor: timelineActor(identity, authorization),
      agentId: identity.actorAgentId,
      action: { operation: request.operationId, capability: request.capability },
      resource: timelineResource(target),
      ...timelineDelegationField(identity),
    } as const;
    await appendRequiredRunEvent(this.integrated!.timeline, {
      ...common,
      id: riskDecisionEventId(risk.id),
      type: "RISK_DECIDED",
      occurredAt: risk.createdAt,
      decision: { decisionId: risk.id, layer: "risk", result: risk.result, reasonCode: risk.reasonCode },
      outcome,
      reasonCode: risk.reasonCode,
      reason: risk.explanation,
      metadata: immutableEvidence,
    });
    if (previousState !== risk.breakerState) {
      await appendRequiredRunEvent(this.integrated!.timeline, {
        ...common,
        id: riskBreakerEventId(risk.id, risk.breakerVersion),
        type: "CIRCUIT_BREAKER_TRANSITIONED",
        occurredAt: risk.createdAt,
        decision: { layer: "circuit_breaker", result: risk.breakerState, reasonCode: risk.reasonCode },
        outcome,
        reasonCode: risk.reasonCode,
        reason: risk.explanation,
        metadata: {
          ...immutableEvidence,
          previousState,
          previousVersion: Math.max(0, risk.breakerVersion - 1),
          breakerState: risk.breakerState,
          breakerVersion: risk.breakerVersion,
        },
      });
    }
    await appendRequiredRunEvent(this.integrated!.timeline, {
      ...common,
      id: riskActionEventId(risk.id),
      type: risk.result === "ALLOW" ? "ACTION_ALLOWED" : risk.result === "WARN" ? "ACTION_WARNED" : "ACTION_BLOCKED",
      occurredAt: risk.createdAt,
      decision: { decisionId: risk.id, layer: "risk", result: risk.result, reasonCode: risk.reasonCode },
      outcome,
      reasonCode: risk.reasonCode,
      reason: risk.explanation,
    });
    if (risk.result === "WARN") {
      if (!approvalRequestId) {
        throw new HttpError(503, "Approval correlation is unavailable for this unusual action");
      }
      await appendRequiredRunEvent(this.integrated!.timeline, {
        ...common,
        id: approvalPausedEventId(approvalRequestId),
        type: "APPROVAL_PAUSED",
        occurredAt: risk.createdAt,
        correlationId: approvalRequestId,
        causationId: risk.id,
        decision: {
          decisionId: risk.policyDecisionId,
          layer: "approval",
          result: "pending",
          reasonCode: risk.reasonCode,
        },
        outcome: "warned",
        reasonCode: risk.reasonCode,
        reason: "The unusual action is paused for a person to review before anything can change.",
        metadata: { approvalRequestId },
      });
    }
  }

  /**
   * Freezes the exact breaker and bounded learning window beside the decision.
   * Reconstructing a Run must never depend on whatever baseline/breaker happens
   * to be current when an operator opens the timeline later.
   */
  private async riskTimelineEvidence(risk: RiskDecision): Promise<Record<string, unknown>> {
    const baseline = risk.baselineId
      ? await this.integrated!.security.getBaseline(risk.baselineId)
      : null;
    if (
      risk.baselineId &&
      (!baseline || baseline.revision !== risk.baselineRevision)
    ) {
      throw new HttpError(
        503,
        `Risk decision ${risk.id} references unavailable behavioral history`,
      );
    }
    const sourceRunIds = baseline?.sourceRunIds.slice(-MAX_TIMELINE_SOURCE_RUN_IDS) ?? [];
    return {
      score: risk.score,
      warnThreshold: risk.warnThreshold,
      blockThreshold: risk.blockThreshold,
      breakerState: risk.breakerState,
      breakerVersion: risk.breakerVersion,
      baselineId: risk.baselineId ?? null,
      baselineRevision: risk.baselineRevision ?? null,
      graphRevision: risk.graphRevision,
      historyWindow: baseline
        ? {
            startAt: baseline.historyWindowStartAt,
            endAt: baseline.historyWindowEndAt,
            runLimit: baseline.historyWindowRunLimit,
            inspectedRunCount: baseline.historyWindowRunCount,
            eligibleRunCount: baseline.eligibleRunCount,
            sourceRunCount: baseline.sourceRunIds.length,
            sourceRunIds,
            sourceRunIdsTruncated: baseline.sourceRunIds.length > sourceRunIds.length,
            minimumHistory: baseline.minimumHistory,
            inclusionPolicy: baseline.inclusionPolicy,
            calculatedAt: baseline.calculatedAt,
          }
        : null,
      factors: risk.factors,
    };
  }

  /**
   * Consumes a decision for exactly one execution. Re-derives the request hash
   * from the live graph, so an approval granted against an older topology or a
   * different payload can no longer be spent.
   */
  async claimForExecution(input: {
    decisionId: string;
    agentId: string;
    actorPrincipalId: string;
    actorRole?: ExecutionIdentity["principal"]["role"];
    delegationChainIds?: string[];
    payload?: Record<string, unknown> | undefined;
  }): Promise<PolicyDecisionRecord> {
    const decision = await this.governance.getDecision(input.decisionId);
    if (!decision) throw new HttpError(404, "Policy decision not found");
    if (decision.result === "DENY") {
      throw new HttpError(403, `Policy denied this action: ${decision.reasonCode}`);
    }
    if (decision.agentNodeId !== `agent:${input.agentId}`) {
      throw new HttpError(403, "Policy decision belongs to a different acting Agent");
    }
    const storedRiskBeforeClaim = await this.integrated?.security.getRiskForPolicy(decision.id);
    let authorizationBeforeClaim: AuthorizationDecision | null = null;
    if (this.integrated) {
      const authorization = await this.integrated.security.getAuthorizationForPolicy(decision.id);
      if (!authorization) throw new HttpError(503, "Authorization evidence is unavailable");
      authorizationBeforeClaim = authorization;
      if (
        authorization.originPrincipalId !== input.actorPrincipalId ||
        authorization.actorAgentId !== input.agentId
      ) {
        throw new HttpError(403, "This decision belongs to a different execution identity");
      }
      if (!input.actorRole || !roleCapabilities(input.actorRole).includes(decision.capabilityRelation)) {
        throw new HttpError(403, "The identity's current role no longer allows this action");
      }
      await this.assertClaimDelegation(
        decision,
        authorization.delegationId,
        input.delegationChainIds ?? [],
        input.actorPrincipalId,
        input.agentId,
        typeof authorization.evidence.rootAgentId === "string"
          ? authorization.evidence.rootAgentId
          : undefined,
      );
      const breaker = await this.integrated.security.getBreaker(input.agentId);
      if (breaker.state === "TRIPPED") {
        throw new HttpError(403, "The safety stop is tripped, so this action cannot execute");
      }
      if (breaker.state === "WARN" && storedRiskBeforeClaim?.result !== "WARN") {
        throw new HttpError(403, "Another unusual action is still waiting for review");
      }
    }

    const graphRevision = await this.graph.getAgentGraphRevision(input.agentId);
    const requestHash = computeRequestHash({
      policyVersion: decision.policyVersion,
      runId: decision.runId,
      agentNodeId: decision.agentNodeId,
      capability: decision.capabilityRelation,
      targetNodeId: decision.targetNodeId,
      graphRevision,
      payloadDigest: digestOf(input.payload ?? null),
    });
    if (requestHash !== decision.requestHash) {
      throw new HttpError(
        409,
        "This decision no longer matches the Agent graph or the request it was granted for",
      );
    }

    let approvalEventId: string | undefined;
    let approvalBeforeClaim: ApprovalRequestRecord | null = null;
    if (decision.result === "REVIEW_REQUIRED") {
      const approval = await this.refreshExpiry(
        await this.governance.getApprovalForDecision(decision.id),
      );
      if (!approval || approval.status !== "approved") {
        throw new HttpError(
          403,
          `This action is waiting on an approval that is ${approval?.status ?? "missing"}`,
        );
      }
      approvalBeforeClaim = approval;
      approvalEventId = `event:${randomUUID()}`;
    }

    if (this.integrated) {
      if (!authorizationBeforeClaim || !storedRiskBeforeClaim) {
        throw new HttpError(
          503,
          "Required authorization or risk evidence is unavailable; execution remains blocked",
        );
      }
      await this.requireClaimAuditReadiness(
        decision,
        authorizationBeforeClaim,
        storedRiskBeforeClaim,
        approvalBeforeClaim,
      );
    }

    await this.governance.claimForExecution({
      decisionId: decision.id,
      operationId: decision.operationId,
      requestHash: decision.requestHash,
      ...(approvalEventId ? { approvalEventId } : {}),
      actorPrincipalId: input.actorPrincipalId,
      ...(this.integrated
        ? {
            allowedPrincipalRoles: rolesForCapability(decision.capabilityRelation),
            ...(storedRiskBeforeClaim
              ? {
                  breakerGuard: {
                    scopeId: input.agentId,
                    expectedState: storedRiskBeforeClaim.breakerState,
                    expectedVersion: storedRiskBeforeClaim.breakerVersion,
                  },
                }
              : {}),
          }
        : {}),
    });
    const risk = storedRiskBeforeClaim;
    if (risk?.result === "WARN") {
      const before = await this.integrated!.security.getBreaker(input.agentId);
      const immutableEvidence = await this.riskTimelineEvidence(risk);
      let after: CircuitBreakerRecord | undefined;
      try {
        after = await this.integrated!.security.acknowledgeWarn(
          input.agentId,
          "A human approved this exact unusual action and its one-time claim was consumed.",
          now(),
        );
        await appendRequiredRunEvent(this.integrated!.timeline, {
          id: breakerRecoveryEventId(decision.id, after.version),
          runId: decision.runId,
          type: "CIRCUIT_BREAKER_TRANSITIONED",
          occurredAt: after.updatedAt,
          actor: { principalId: input.actorPrincipalId, kind: "human", originPrincipalId: input.actorPrincipalId },
          agentId: input.agentId,
          action: { operation: decision.operationId, capability: decision.capabilityRelation },
          resource: { resourceId: decision.targetNodeId },
          decision: { layer: "circuit_breaker", result: after.state, reasonCode: after.reasonCode },
          outcome: "allowed",
          reasonCode: after.reasonCode,
          reason: after.explanation,
          metadata: {
            ...immutableEvidence,
            previousState: before.state,
            previousVersion: before.version,
            breakerState: after.state,
            breakerVersion: after.version,
          },
        });
      } catch (error) {
        if (after) await this.integrated!.security.restoreBreaker(before, after.version);
        await this.governance.rollbackExecutionClaim(decision.id, approvalEventId);
        throw error;
      }
    }
    return decision;
  }

  private async requireClaimAuditReadiness(
    decision: PolicyDecisionRecord,
    authorization: AuthorizationDecision,
    risk: RiskDecision,
    approval: ApprovalRequestRecord | null,
  ): Promise<void> {
    if (
      authorization.policyDecisionId !== decision.id ||
      authorization.result !== "ALLOW" ||
      risk.policyDecisionId !== decision.id ||
      risk.authorizationDecisionId !== authorization.id
    ) {
      throw new HttpError(
        503,
        "Persisted security evidence is not correlated to this policy decision; execution remains blocked",
      );
    }

    const outcome = risk.result === "ALLOW"
      ? "allowed" as const
      : risk.result === "WARN"
        ? "warned" as const
        : "blocked" as const;
    const actionType = risk.result === "ALLOW"
      ? "ACTION_ALLOWED" as const
      : risk.result === "WARN"
        ? "ACTION_WARNED" as const
        : "ACTION_BLOCKED" as const;

    try {
      await requireRunEventEvidence(this.integrated!.timeline, {
        runId: decision.runId,
        eventId: authorizationDecisionEventId(authorization.id),
        type: "AUTHORIZATION_DECIDED",
        decisionId: authorization.id,
        outcome: "allowed",
      });
      await requireRunEventEvidence(this.integrated!.timeline, {
        runId: decision.runId,
        eventId: riskDecisionEventId(risk.id),
        type: "RISK_DECIDED",
        decisionId: risk.id,
        outcome,
      });
      const previousState = inferPreviousBreakerState(risk);
      if (previousState !== risk.breakerState) {
        await requireRunEventEvidence(this.integrated!.timeline, {
          runId: decision.runId,
          eventId: riskBreakerEventId(risk.id, risk.breakerVersion),
          type: "CIRCUIT_BREAKER_TRANSITIONED",
          outcome,
        });
      }
      await requireRunEventEvidence(this.integrated!.timeline, {
        runId: decision.runId,
        eventId: riskActionEventId(risk.id),
        type: actionType,
        decisionId: risk.id,
        outcome,
      });

      if (risk.result === "WARN") {
        if (!approval) {
          throw new Error("The reviewed action is missing its approval request");
        }
        await requireRunEventEvidence(this.integrated!.timeline, {
          runId: decision.runId,
          eventId: approvalPausedEventId(approval.id),
          type: "APPROVAL_PAUSED",
          decisionId: decision.id,
          correlationId: approval.id,
          outcome: "warned",
        });
      }

      if (decision.result === "REVIEW_REQUIRED") {
        if (!approval || approval.status !== "approved") {
          throw new Error("The reviewed action does not have a durable approval");
        }
        const approvalEvent = (await this.governance.getApprovalEvents(approval.id))
          .find((event) => event.eventType === "approved");
        if (!approvalEvent) {
          throw new Error("The approved action is missing its durable approval event");
        }
        await requireRunEventEvidence(this.integrated!.timeline, {
          runId: decision.runId,
          eventId: approvalResolvedEventId(approvalEvent.id),
          type: "APPROVAL_RESOLVED",
          decisionId: decision.id,
          correlationId: approval.id,
          outcome: "allowed",
        });
      }
    } catch (error) {
      throw new HttpError(
        503,
        error instanceof Error
          ? error.message
          : "Required Run evidence is unavailable; execution remains blocked",
      );
    }
  }

  private async assertClaimDelegation(
    decision: PolicyDecisionRecord,
    expectedDelegationId: string | undefined,
    receivedChainIds: string[],
    actorPrincipalId: string,
    agentId: string,
    rootAgentId: string | undefined,
  ): Promise<void> {
    if (!expectedDelegationId) {
      if (receivedChainIds.length > 0) {
        throw new HttpError(403, "This decision was not reviewed for a delegated Agent");
      }
      return;
    }
    if (receivedChainIds.at(-1) !== expectedDelegationId) {
      throw new HttpError(403, "This decision is bound to a different delegation");
    }
    if (!rootAgentId || new Set(receivedChainIds).size !== receivedChainIds.length) {
      throw new HttpError(403, "The reviewed delegation chain identity is invalid");
    }
    const timestamp = now();
    let previous: Awaited<ReturnType<SecurityStore["getDelegation"]>> = null;
    const currentChain: DelegationRecord[] = [];
    for (const delegationId of receivedChainIds) {
      const current = await this.integrated!.security.getDelegation(delegationId);
      if (!current || current.status !== "active" || current.expiresAt <= timestamp) {
        throw new HttpError(403, "The reviewed delegation is revoked or expired");
      }
      if (
        current.runId !== decision.runId ||
        current.originPrincipalId !== actorPrincipalId ||
        (!previous && (current.depth !== 1 || current.parentAgentId !== rootAgentId)) ||
        (previous && (
          current.parentDelegationId !== previous.id ||
          current.parentAgentId !== previous.childAgentId ||
          current.depth !== previous.depth + 1
        ))
      ) {
        throw new HttpError(403, "The reviewed delegation chain is no longer valid");
      }
      currentChain.push(current);
      previous = current;
    }
    if (
      !previous ||
      previous.id !== expectedDelegationId ||
      previous.childAgentId !== agentId ||
      previous.depth !== receivedChainIds.length
    ) {
      throw new HttpError(403, "The reviewed delegation chain is no longer valid");
    }
    const authority = await this.inspectDelegationAuthority(
      currentChain,
      actorPrincipalId,
      decision.capabilityRelation,
      decision.targetNodeId,
    );
    if (!authority.scopeAllowed) {
      throw new HttpError(403, "The reviewed action is outside the current delegated scope");
    }
    if (!authority.capabilityAllowed) {
      throw new HttpError(
        403,
        "A source Agent capability in the reviewed delegation chain no longer authorizes this action",
      );
    }
    if (!authority.ownershipAllowed) {
      throw new HttpError(
        403,
        "Agent ownership in the reviewed delegation chain changed after authorization",
      );
    }
  }

  private async inspectDelegationAuthority(
    chain: DelegationRecord[],
    originPrincipalId: string,
    capability: CapabilityRelation,
    targetNodeId: string,
  ): Promise<DelegationAuthorityEvidence> {
    const hops = await Promise.all(chain.map(async (delegation) => {
      const [parentCapabilities, childCapabilities, parentOwners, childOwners] = await Promise.all([
        this.graph.listCapabilities(delegation.parentAgentId),
        this.graph.listCapabilities(delegation.childAgentId),
        this.graph.ownersOfAgent(delegation.parentAgentId),
        this.graph.ownersOfAgent(delegation.childAgentId),
      ]);
      const parentCapability = parentCapabilities.find(
        (edge) => edge.relation === capability && edge.targetId === targetNodeId,
      );
      const childCapability = childCapabilities.find(
        (edge) => edge.relation === capability && edge.targetId === targetNodeId,
      );
      const parentOwnerIds = parentOwners.map((owner) => owner.id).sort();
      const childOwnerIds = childOwners.map((owner) => owner.id).sort();
      return {
        delegationId: delegation.id,
        parentAgentId: delegation.parentAgentId,
        childAgentId: delegation.childAgentId,
        scopeAllowed: delegation.effectiveScope.some(
          (scope) => scope.capability === capability && scope.targetNodeId === targetNodeId,
        ),
        parentCapabilityEdgeId: parentCapability?.id ?? null,
        childCapabilityEdgeId: childCapability?.id ?? null,
        parentOwnerIds,
        childOwnerIds,
        parentOwnershipAllowed:
          parentOwnerIds.length === 0 || parentOwnerIds.includes(originPrincipalId),
        childOwnershipAllowed:
          childOwnerIds.length === 0 || childOwnerIds.includes(originPrincipalId),
      } satisfies DelegationAuthorityHopEvidence;
    }));
    return {
      scopeAllowed: hops.every((hop) => hop.scopeAllowed),
      capabilityAllowed: hops.every(
        (hop) => hop.parentCapabilityEdgeId !== null && hop.childCapabilityEdgeId !== null,
      ),
      ownershipAllowed: hops.every(
        (hop) => hop.parentOwnershipAllowed && hop.childOwnershipAllowed,
      ),
      hops,
    };
  }

  async getAuthorizationForDecision(decisionId: string): Promise<AuthorizationDecision | null> {
    return this.integrated?.security.getAuthorizationForPolicy(decisionId) ?? null;
  }

  async getRiskForDecision(decisionId: string): Promise<RiskDecision | null> {
    return this.integrated?.security.getRiskForPolicy(decisionId) ?? null;
  }

  async resolveApproval(input: {
    approvalRequestId: string;
    resolution: "approved" | "rejected";
    actorPrincipalId: string;
    actorHumanNodeId?: string | undefined;
    reason?: string | undefined;
  }): Promise<{ approvalRequest: ApprovalRequestRecord; event: ApprovalEventRecord }> {
    const existing = await this.refreshExpiry(
      await this.governance.getApprovalRequest(input.approvalRequestId),
    );
    if (!existing) throw new HttpError(404, "Approval request not found");
    if (existing.status === input.resolution) {
      const event = (await this.governance.getApprovalEvents(existing.id))
        .find((item) => item.eventType === input.resolution);
      if (!event) {
        throw new HttpError(
          503,
          `The ${input.resolution} approval is missing its durable resolution event`,
        );
      }
      await this.appendApprovalResolutionEvent(existing, event);
      return { approvalRequest: existing, event };
    }
    if (existing.status !== "pending") {
      throw new HttpError(409, `This approval request is already ${existing.status}`);
    }
    const event = await this.governance.resolveReview({
      eventId: `event:${randomUUID()}`,
      approvalRequestId: input.approvalRequestId,
      resolution: input.resolution,
      actorPrincipalId: input.actorPrincipalId,
      ...(input.actorHumanNodeId ? { actorHumanNodeId: input.actorHumanNodeId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    });
    const approvalRequest = await this.governance.getApprovalRequest(input.approvalRequestId);
    if (!approvalRequest) throw new HttpError(503, "Approval state disappeared after resolution");
    await this.appendApprovalResolutionEvent(approvalRequest, event);
    return { approvalRequest: approvalRequest!, event };
  }

  private async appendApprovalResolutionEvent(
    approvalRequest: ApprovalRequestRecord,
    event: ApprovalEventRecord,
  ): Promise<void> {
    if (!this.integrated) return;
    const decision = await this.governance.getDecision(approvalRequest.decisionId);
    const authorization = decision
      ? await this.integrated.security.getAuthorizationForPolicy(decision.id)
      : null;
    if (!decision || !authorization) {
      throw new HttpError(
        503,
        "Approval resolution cannot be correlated to its authorization evidence",
      );
    }
    const resolution = event.eventType;
    if (resolution !== "approved" && resolution !== "rejected") {
      throw new HttpError(503, `Unsupported human approval resolution ${resolution}`);
    }
    const reasonCode = `APPROVAL_${resolution.toUpperCase()}`;
    const storedOriginDisplayName = authorization.evidence.originDisplayName;
    const required: RequiredRunEvent = {
      id: approvalResolvedEventId(event.id),
      runId: decision.runId,
      type: "APPROVAL_RESOLVED",
      occurredAt: event.createdAt,
      actor: {
        principalId: event.actorPrincipalId,
        kind: "human",
        originPrincipalId: authorization.originPrincipalId,
        ...(event.actorPrincipalId === authorization.originPrincipalId &&
        typeof storedOriginDisplayName === "string"
          ? { displayName: storedOriginDisplayName, originDisplayName: storedOriginDisplayName }
          : {}),
        agentId: authorization.actorAgentId,
      },
      agentId: authorization.actorAgentId,
      action: {
        operation: decision.operationId,
        capability: decision.capabilityRelation,
      },
      resource: { resourceId: decision.targetNodeId },
      correlationId: approvalRequest.id,
      causationId: authorization.id,
      decision: {
        decisionId: decision.id,
        layer: "approval",
        result: resolution,
        reasonCode,
      },
      outcome: resolution === "approved" ? "allowed" : "blocked",
      reasonCode,
      reason: event.reason || `The unusual action was ${resolution}.`,
    };
    await appendRequiredRunEvent(this.integrated.timeline, required);
  }

  async getDecision(decisionId: string): Promise<DecisionDetail> {
    const decision = await this.governance.getDecision(decisionId);
    if (!decision) throw new HttpError(404, "Policy decision not found");
    return this.describe(decision);
  }

  async getDecisionByOperation(operationId: string): Promise<DecisionDetail | null> {
    const decision = await this.governance.getDecisionByOperation(operationId);
    return decision ? this.describe(decision) : null;
  }

  async getDecisionsForRun(runId: string): Promise<DecisionDetail[]> {
    const decisions = await this.governance.getDecisionsForRun(runId);
    const detailed: DecisionDetail[] = [];
    for (const decision of decisions) {
      detailed.push(await this.describe(decision));
    }
    return detailed;
  }

  async listApprovals(status?: ApprovalRequestRecord["status"]): Promise<
    Array<{ approvalRequest: ApprovalRequestRecord; decision: PolicyDecisionRecord }>
  > {
    const requests = await this.governance.listApprovals(status);
    const result: Array<{
      approvalRequest: ApprovalRequestRecord;
      decision: PolicyDecisionRecord;
    }> = [];
    for (const request of requests) {
      const refreshed = (await this.refreshExpiry(request))!;
      if (status && refreshed.status !== status) continue;
      const decision = await this.governance.getDecision(refreshed.decisionId);
      if (decision) result.push({ approvalRequest: refreshed, decision });
    }
    return result;
  }

  /** Writes the TOUCHED evidence that an authorized action really happened. */
  async recordSuccess(decision: PolicyDecisionRecord): Promise<void> {
    await this.upsertAuditEdge(decision, "TOUCHED", "actual", "touched", now());
  }

  private async describe(decision: PolicyDecisionRecord): Promise<DecisionDetail> {
    const approvalRequest = await this.refreshExpiry(
      await this.governance.getApprovalForDecision(decision.id),
    );
    const events = approvalRequest
      ? await this.governance.getApprovalEvents(approvalRequest.id)
      : [];
    const claim = await this.governance.getActionClaim(decision.id);
    const authorization = await this.integrated?.security.getAuthorizationForPolicy(decision.id);
    const risk = await this.integrated?.security.getRiskForPolicy(decision.id);
    return {
      decision,
      approvalRequest,
      events,
      claimed: claim !== null,
      ...(authorization ? { authorization } : {}),
      ...(risk ? { risk } : {}),
    };
  }

  /**
   * Expiry is enforced on the server clock at read time so a pending approval
   * cannot be approved after its window has closed.
   */
  private async refreshExpiry(
    approval: ApprovalRequestRecord | null,
  ): Promise<ApprovalRequestRecord | null> {
    if (!approval || approval.status !== "pending") return approval;
    if (now() < approval.expiresAt) return approval;
    try {
      await this.governance.resolveReview({
        eventId: `event:${randomUUID()}`,
        approvalRequestId: approval.id,
        resolution: "expired",
        actorPrincipalId: "principal:policy-service",
        reason: "The approval window closed before a human responded",
      });
    } catch (error) {
      if (!(error instanceof MiddlewareStoreError)) throw error;
    }
    return this.governance.getApprovalRequest(approval.id);
  }

  private decide(
    impact: ActionImpact | null,
    forceReviewReason?: string,
  ): { result: PolicyResult; reasonCode: string } {
    if (!impact) {
      return { result: "DENY", reasonCode: "NO_DIRECT_CAPABILITY" };
    }
    if (impact.score > this.thresholds.denyThreshold) {
      return { result: "DENY", reasonCode: "RISK_ABOVE_DENY_THRESHOLD" };
    }
    if (forceReviewReason) {
      return { result: "REVIEW_REQUIRED", reasonCode: forceReviewReason };
    }
    if (impact.score > this.thresholds.reviewThreshold) {
      return { result: "REVIEW_REQUIRED", reasonCode: "RISK_ABOVE_REVIEW_THRESHOLD" };
    }
    return { result: "ALLOW", reasonCode: "WITHIN_RISK_THRESHOLD" };
  }

  private async requireAssetNode(targetNodeId: string): Promise<GraphNode> {
    const target = await this.graphStore.getNode(targetNodeId);
    if (!target) throw new HttpError(404, `Protected resource ${targetNodeId} was not found`);
    if (target.type !== "asset") {
      throw new HttpError(400, "A protected action must target an asset node");
    }
    return target;
  }

  private async recordAttempt(decision: PolicyDecisionRecord): Promise<void> {
    await this.upsertAuditEdge(decision, "ATTEMPTED", "attempted", "attempted", decision.createdAt);
  }

  private async recordDenial(decision: PolicyDecisionRecord): Promise<void> {
    await this.upsertAuditEdge(decision, "DENIED", "denied", "denied", decision.createdAt);
  }

  private async upsertAuditEdge(
    decision: PolicyDecisionRecord,
    relation: GraphEdge["relation"],
    status: GraphEdge["status"],
    prefix: string,
    createdAt: string,
  ): Promise<void> {
    const edge: GraphEdge = {
      id: `edge:${prefix}:${decision.operationId}`,
      sourceId: decision.agentNodeId,
      targetId: decision.targetNodeId,
      relation,
      status,
      runId: decision.runId,
      metadata: {
        operationId: decision.operationId,
        decisionId: decision.id,
        policyResult: decision.result,
        reasonCode: decision.reasonCode,
        capability: decision.capabilityRelation,
        riskScore: decision.riskScore,
      },
      createdAt,
    };
    await this.graphStore.upsertEdge(edge);
  }
}

function timelineActor(
  identity: ExecutionIdentity,
  authorization?: AuthorizationDecision,
) {
  const storedOriginDisplayName = authorization?.evidence.originDisplayName;
  const storedAgentDisplayName = authorization?.evidence.actorAgentDisplayName;
  return {
    principalId: `agent:${identity.actorAgentId}`,
    kind: (authorization?.delegationId ?? identity.delegation)
      ? "delegated_agent" as const
      : "agent" as const,
    ...(typeof storedAgentDisplayName === "string"
      ? { displayName: storedAgentDisplayName }
      : identity.actorAgentDisplayName
        ? { displayName: identity.actorAgentDisplayName }
        : {}),
    originPrincipalId: authorization?.originPrincipalId ?? identity.principal.id,
    originDisplayName: typeof storedOriginDisplayName === "string"
      ? storedOriginDisplayName
      : identity.principal.displayName,
    agentId: identity.actorAgentId,
    ...(identity.delegation ? { parentAgentId: identity.delegation.parentAgentId } : {}),
  };
}

function authorizationDecisionEventId(authorizationId: string): string {
  return `run-event:authz-decision:${authorizationId}`;
}

function authorizationActionEventId(authorizationId: string): string {
  return `run-event:authz-action:${authorizationId}`;
}

function riskDecisionEventId(riskId: string): string {
  return `run-event:risk:${riskId}`;
}

function riskBreakerEventId(riskId: string, breakerVersion: number): string {
  return `run-event:risk-breaker:${riskId}:${breakerVersion}`;
}

function riskActionEventId(riskId: string): string {
  return `run-event:risk-action:${riskId}`;
}

function approvalPausedEventId(approvalRequestId: string): string {
  return `run-event:approval-paused:${approvalRequestId}`;
}

function approvalResolvedEventId(approvalEventId: string): string {
  return `run-event:approval-resolved:${approvalEventId}`;
}

function breakerRecoveryEventId(decisionId: string, breakerVersion: number): string {
  return `run-event:breaker-recovery:${decisionId}:${breakerVersion}`;
}

function inferPreviousBreakerState(
  risk: RiskDecision,
): "NORMAL" | "WARN" | "TRIPPED" {
  if (risk.factors.some((factor) => factor.code === "BREAKER_ALREADY_TRIPPED")) {
    return "TRIPPED";
  }
  if (risk.factors.some((factor) => factor.code === "BREAKER_WARN_PENDING")) {
    return "WARN";
  }
  return "NORMAL";
}

function timelineResource(target: GraphNode) {
  return {
    resourceId: target.id,
    label: target.label,
    kind: typeof target.metadata.kind === "string" ? target.metadata.kind : "resource",
  };
}

function timelineDelegationField(identity: ExecutionIdentity) {
  if (!identity.delegation) return {};
  return {
    delegation: {
      delegationId: identity.delegation.id,
      parentAgentId: identity.delegation.parentAgentId,
      childAgentId: identity.delegation.childAgentId,
      depth: identity.delegation.depth,
      effectiveCapabilities: identity.delegation.effectiveScope.map(
        (scope) => `${scope.capability}:${scope.targetNodeId}`,
      ),
    },
  };
}

function authorizationBlockReason(reasonCode: string): string {
  if (reasonCode === "AGENT_OWNED_BY_ANOTHER_PRINCIPAL") {
    return "Blocked because this Agent is owned by another person. Nothing changed.";
  }
  if (reasonCode === "RESOURCE_OWNED_BY_ANOTHER_PRINCIPAL") {
    return "Blocked because this resource is owned by another person. Nothing changed.";
  }
  return "Blocked because this identity lacks the required role, exact permission, or delegated scope. Nothing changed.";
}
