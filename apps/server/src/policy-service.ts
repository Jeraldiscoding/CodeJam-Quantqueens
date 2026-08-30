import { randomUUID } from "node:crypto";
import type { GraphEdge, GraphNode, GraphStore } from "./graph-types.js";
import { HttpError } from "./errors.js";
import type { ActionImpact, KnowledgeGraphService } from "./knowledge-graph.js";
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

export const POLICY_VERSION = "kg-policy-1";

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
  actorPrincipalId: string;
}

export interface PolicyEvaluation {
  decision: PolicyDecisionRecord;
  approvalRequest?: ApprovalRequestRecord;
  graphRevision: string;
  impact: ActionImpact | null;
}

export interface DecisionDetail {
  decision: PolicyDecisionRecord;
  approvalRequest: ApprovalRequestRecord | null;
  events: ApprovalEventRecord[];
  claimed: boolean;
}

const now = () => new Date().toISOString();

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
  async evaluate(request: ProtectedActionRequest): Promise<PolicyEvaluation> {
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

    const outcome = this.decide(impact);
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
        actorPrincipalId: request.actorPrincipalId,
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

  /**
   * Consumes a decision for exactly one execution. Re-derives the request hash
   * from the live graph, so an approval granted against an older topology or a
   * different payload can no longer be spent.
   */
  async claimForExecution(input: {
    decisionId: string;
    agentId: string;
    actorPrincipalId: string;
    payload?: Record<string, unknown> | undefined;
  }): Promise<PolicyDecisionRecord> {
    const decision = await this.governance.getDecision(input.decisionId);
    if (!decision) throw new HttpError(404, "Policy decision not found");
    if (decision.result === "DENY") {
      throw new HttpError(403, `Policy denied this action: ${decision.reasonCode}`);
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
      approvalEventId = `event:${randomUUID()}`;
    }

    await this.governance.claimForExecution({
      decisionId: decision.id,
      operationId: decision.operationId,
      requestHash: decision.requestHash,
      ...(approvalEventId ? { approvalEventId } : {}),
      actorPrincipalId: input.actorPrincipalId,
    });
    return decision;
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
    return { approvalRequest: approvalRequest!, event };
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
    return { decision, approvalRequest, events, claimed: claim !== null };
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

  private decide(impact: ActionImpact | null): { result: PolicyResult; reasonCode: string } {
    if (!impact) {
      return { result: "DENY", reasonCode: "NO_DIRECT_CAPABILITY" };
    }
    if (impact.score > this.thresholds.denyThreshold) {
      return { result: "DENY", reasonCode: "RISK_ABOVE_DENY_THRESHOLD" };
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
