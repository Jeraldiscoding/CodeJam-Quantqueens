import type { ActionImpact, KnowledgeGraphService } from "./knowledge-graph.js";
import { sha256Hex } from "./policy-hash.js";
import type { DecisionDetail, PolicyService } from "./policy-service.js";
import type { CapabilityRelation } from "./policy-store.js";
import { analyzePromptIntent, type PromptIntentAnalysis } from "./prompt-intelligence.js";
import type { RunPolicySummary } from "./types.js";
import type { ExecutionIdentity } from "./security-types.js";

export interface RunGateInput {
  runId: string;
  agentId: string;
  prompt: string;
  executionMode?: "protected_action_planner";
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
    private readonly resolveIdentity?: (input: RunGateInput) => Promise<ExecutionIdentity>,
  ) {}

  async evaluateRun(input: RunGateInput): Promise<RunPolicySummary> {
    const intent = analyzePromptIntent(input.prompt);
    if (
      intent.intent === "informational" ||
      (intent.intent === "action" && input.executionMode === "protected_action_planner")
    ) {
      const thresholds = this.policy.policyThresholds;
      const planned = input.executionMode === "protected_action_planner";
      return {
        result: "ALLOW",
        reasonCode: planned ? "READ_ONLY_PLANNING_BEFORE_ACTION_GATE" : intent.reasonCode,
        intent: intent.intent,
        intentExplanation: planned
          ? "Codex may interpret this request in a read-only planning turn. Any protected effect still requires an exact Resource Gateway decision."
          : intent.explanation,
        riskScore: 0,
        reviewThreshold: thresholds.reviewThreshold,
        denyThreshold: thresholds.denyThreshold,
        decisionId: null,
        approvalRequestId: null,
        evaluatedAt: new Date().toISOString(),
        riskFactors: [],
      };
    }

    const existing = await this.policy.getDecisionByOperation(runOperationId(input.runId));
    if (existing) return this.summarize(existing, intent);

    const worst = await this.mostExposedCapability(input.agentId);
    const thresholds = this.policy.policyThresholds;
    if (!worst) {
      return {
        result: intent.intent === "suspicious" ? "DENY" : "ALLOW",
        reasonCode:
          intent.intent === "suspicious"
            ? "SUSPICIOUS_REQUEST_WITHOUT_CAPABILITY"
            : "NO_PROTECTED_CAPABILITY",
        intent: intent.intent,
        intentExplanation: intent.explanation,
        riskScore: 0,
        reviewThreshold: thresholds.reviewThreshold,
        denyThreshold: thresholds.denyThreshold,
        decisionId: null,
        approvalRequestId: null,
        evaluatedAt: new Date().toISOString(),
        riskFactors: [],
      };
    }

    const identity = this.resolveIdentity ? await this.resolveIdentity(input) : undefined;
    const evaluation = await this.policy.evaluate(
      {
        operationId: runOperationId(input.runId),
        runId: input.runId,
        agentId: input.agentId,
        capability: worst.capability,
        targetNodeId: worst.targetNodeId,
        payload: promptPayload(input.prompt),
        actorPrincipalId: identity?.principal.id ?? "principal:run-gate",
        ...(identity ? { identity } : {}),
      },
      intent.intent === "suspicious" ? { forceReviewReason: intent.reasonCode } : {},
    );

    return {
      result: evaluation.decision.result,
      reasonCode: evaluation.decision.reasonCode,
      intent: intent.intent,
      intentExplanation: intent.explanation,
      riskScore: evaluation.decision.riskScore,
      reviewThreshold: thresholds.reviewThreshold,
      denyThreshold: thresholds.denyThreshold,
      decisionId: evaluation.decision.id,
      approvalRequestId: evaluation.approvalRequest?.id ?? null,
      evaluatedAt: evaluation.decision.createdAt,
      riskFactors: this.riskFactors(evaluation.impact),
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
    const identity = this.resolveIdentity ? await this.resolveIdentity(input) : undefined;
    await this.policy.claimForExecution({
      decisionId: existing.decision.id,
      agentId: input.agentId,
      actorPrincipalId: identity?.principal.id ?? "principal:run-gate",
      ...(identity
        ? {
            actorRole: identity.principal.role,
            delegationChainIds: identity.delegationChain.map((delegation) => delegation.id),
          }
        : {}),
      payload: promptPayload(input.prompt),
    });
  }

  private summarize(existing: DecisionDetail, intent: PromptIntentAnalysis): RunPolicySummary {
    const thresholds = this.policy.policyThresholds;
    return {
      result: existing.decision.result,
      reasonCode: existing.decision.reasonCode,
      intent: intent.intent,
      intentExplanation: intent.explanation,
      riskScore: existing.decision.riskScore,
      reviewThreshold: thresholds.reviewThreshold,
      denyThreshold: thresholds.denyThreshold,
      decisionId: existing.decision.id,
      approvalRequestId: existing.approvalRequest?.id ?? null,
      evaluatedAt: existing.decision.createdAt,
      riskFactors: this.storedRiskFactors(existing.decision.evidence),
    };
  }

  private riskFactors(impact: ActionImpact | null): RunPolicySummary["riskFactors"] {
    return impact?.targets.map((target) => ({
      id: target.node.id,
      label: target.node.label,
      riskWeight: target.node.riskWeight,
      classification: target.node.classification,
      path: target.path.nodeIds,
    })) ?? [];
  }

  private storedRiskFactors(
    evidence: Record<string, unknown>,
  ): RunPolicySummary["riskFactors"] {
    if (!Array.isArray(evidence.scoredTargets)) return [];
    return evidence.scoredTargets.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const target = value as Record<string, unknown>;
      if (
        typeof target.id !== "string" ||
        typeof target.label !== "string" ||
        typeof target.riskWeight !== "number" ||
        typeof target.classification !== "string" ||
        !Array.isArray(target.path) ||
        !target.path.every((part) => typeof part === "string")
      ) {
        return [];
      }
      return [{
        id: target.id,
        label: target.label,
        riskWeight: target.riskWeight,
        classification: target.classification,
        path: target.path as string[],
      }];
    });
  }

  private async mostExposedCapability(
    agentId: string,
  ): Promise<{
    capability: CapabilityRelation;
    targetNodeId: string;
    score: number;
    impact: ActionImpact;
  } | null> {
    const capabilities = await this.graph.listCapabilities(agentId);
    let worst: {
      capability: CapabilityRelation;
      targetNodeId: string;
      score: number;
      impact: ActionImpact;
    } | null =
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
        worst = { capability, targetNodeId: edge.targetId, score: impact.score, impact };
      }
    }
    return worst;
  }
}
