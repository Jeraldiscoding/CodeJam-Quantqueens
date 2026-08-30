import type { KnowledgeGraphService } from "./knowledge-graph.js";
import { sha256Hex } from "./policy-hash.js";
import type { DecisionDetail, PolicyService } from "./policy-service.js";
import type { CapabilityRelation } from "./policy-store.js";
import type { RunPolicySummary } from "./types.js";

export interface RunGateInput {
  runId: string;
  agentId: string;
  prompt: string;
}

/**
 * The boundary AgentService depends on. Keeping it an interface means the Run
 * lifecycle stays independent of the graph, the database, and the policy code.
 */
export interface RunPolicyGate {
  evaluateRun(input: RunGateInput): Promise<RunPolicySummary>;
  authorizeResume(input: RunGateInput): Promise<void>;
}

const runOperationId = (runId: string) => `run-gate:${runId}`;
const promptPayload = (prompt: string) => ({ promptSha256: sha256Hex(prompt) });

/**
 * Decides whether a Run may start at all.
 *
 * The Run is scored on the single direct capability whose downstream blast
 * radius is largest, because that is the worst thing the Run could do with the
 * authority it already holds. An Agent with no configured capability has
 * nothing to enforce, so it starts without a recorded decision.
 */
export class KnowledgeGraphRunPolicyGate implements RunPolicyGate {
  constructor(
    private readonly graph: KnowledgeGraphService,
    private readonly policy: PolicyService,
  ) {}

  async evaluateRun(input: RunGateInput): Promise<RunPolicySummary> {
    const existing = await this.policy.getDecisionByOperation(runOperationId(input.runId));
    if (existing) return this.summarize(existing);

    const worst = await this.mostExposedCapability(input.agentId);
    const thresholds = this.policy.policyThresholds;
    if (!worst) {
      return {
        result: "ALLOW",
        reasonCode: "NO_PROTECTED_CAPABILITY",
        riskScore: 0,
        reviewThreshold: thresholds.reviewThreshold,
        denyThreshold: thresholds.denyThreshold,
        decisionId: null,
        approvalRequestId: null,
        evaluatedAt: new Date().toISOString(),
      };
    }

    const evaluation = await this.policy.evaluate({
      operationId: runOperationId(input.runId),
      runId: input.runId,
      agentId: input.agentId,
      capability: worst.capability,
      targetNodeId: worst.targetNodeId,
      payload: promptPayload(input.prompt),
      actorPrincipalId: "principal:run-gate",
    });

    return {
      result: evaluation.decision.result,
      reasonCode: evaluation.decision.reasonCode,
      riskScore: evaluation.decision.riskScore,
      reviewThreshold: thresholds.reviewThreshold,
      denyThreshold: thresholds.denyThreshold,
      decisionId: evaluation.decision.id,
      approvalRequestId: evaluation.approvalRequest?.id ?? null,
      evaluatedAt: evaluation.decision.createdAt,
    };
  }

  /**
   * Spends the approval for exactly one resumed Run. Throws when the approval
   * is missing, rejected, expired, already used, or was granted against an
   * Agent graph that has since changed.
   */
  async authorizeResume(input: RunGateInput): Promise<void> {
    const existing = await this.policy.getDecisionByOperation(runOperationId(input.runId));
    if (!existing) {
      throw new Error("This Run has no recorded policy decision to resume");
    }
    await this.policy.claimForExecution({
      decisionId: existing.decision.id,
      agentId: input.agentId,
      actorPrincipalId: "principal:run-gate",
      payload: promptPayload(input.prompt),
    });
  }

  private summarize(existing: DecisionDetail): RunPolicySummary {
    const thresholds = this.policy.policyThresholds;
    return {
      result: existing.decision.result,
      reasonCode: existing.decision.reasonCode,
      riskScore: existing.decision.riskScore,
      reviewThreshold: thresholds.reviewThreshold,
      denyThreshold: thresholds.denyThreshold,
      decisionId: existing.decision.id,
      approvalRequestId: existing.approvalRequest?.id ?? null,
      evaluatedAt: existing.decision.createdAt,
    };
  }

  private async mostExposedCapability(
    agentId: string,
  ): Promise<{ capability: CapabilityRelation; targetNodeId: string; score: number } | null> {
    const capabilities = await this.graph.listCapabilities(agentId);
    let worst: { capability: CapabilityRelation; targetNodeId: string; score: number } | null =
      null;
    for (const edge of capabilities) {
      const capability = edge.relation as CapabilityRelation;
      const impact = await this.graph.calculateActionImpact(
        agentId,
        capability,
        edge.targetId,
      );
      if (!impact) continue;
      if (!worst || impact.score > worst.score) {
        worst = { capability, targetNodeId: edge.targetId, score: impact.score };
      }
    }
    return worst;
  }
}
