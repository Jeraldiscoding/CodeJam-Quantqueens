import { randomUUID } from "node:crypto";
import type { GraphNode } from "./graph-types.js";
import type { ResourceImpact } from "./knowledge-graph.js";
import type { RunTimeline } from "./run-timeline.js";
import type { SecurityStore } from "./security-store.js";
import type {
  AuthorizationDecision,
  BehavioralBaseline,
  ExecutionIdentity,
  RiskDecision,
  RiskFactor,
} from "./security-types.js";
import type { AgentRun } from "./types.js";

export interface BaselineRunDirectory {
  getRuns(agentId: string): AgentRun[];
}

const INCLUSION_POLICY = "completed-runs:mediated-success:auth-allow:risk-allow-or-approved-warn:v1";
export const DEFAULT_HISTORY_WINDOW_RUN_LIMIT = 20;

/** Builds persisted behavior only from successful, mediated, trusted Run events. */
export class BehavioralBaselineService {
  constructor(
    private readonly security: SecurityStore,
    private readonly timeline: RunTimeline,
    private readonly runs: BaselineRunDirectory,
    readonly minimumHistory = 3,
    readonly historyWindowRunLimit = DEFAULT_HISTORY_WINDOW_RUN_LIMIT,
  ) {
    if (!Number.isSafeInteger(historyWindowRunLimit) || historyWindowRunLimit < minimumHistory) {
      throw new Error("The behavioral history window must be an integer at least as large as minimum history");
    }
  }

  async rebuild(agentId: string): Promise<BehavioralBaseline> {
    // Only the latest bounded terminal window is eligible for event reads and
    // aggregation. Stable time + ID ordering makes the same repository state
    // produce the same frozen source set across rebuilds and restarts.
    const completedRuns = this.runs.getRuns(agentId)
      .filter((run) => run.status === "completed")
      .sort(compareCompletedRuns)
      .slice(-this.historyWindowRunLimit);
    const historyWindowStartAt = completedRuns.length > 0
      ? completedRunTime(completedRuns[0]!)
      : null;
    const historyWindowEndAt = completedRuns.length > 0
      ? completedRunTime(completedRuns.at(-1)!)
      : null;
    const sourceRunIds: string[] = [];
    const normal = new Map<string, { capability: "CAN_READ" | "CAN_WRITE" | "CAN_CALL" | "CAN_USE"; targetNodeId: string }>();
    const blastRadii: number[] = [];
    const depths: number[] = [];

    for (const run of completedRuns) {
      const events = await this.timeline.list(run.id);
      const terminal = events.some((event) => event.type === "RUN_COMPLETED");
      const unsafe = events.some((event) =>
        event.type === "ACTION_BLOCKED" || event.type === "ACTION_FAILED" ||
        event.type === "RUN_FAILED" || event.type === "RUN_CANCELLED");
      const actions = events.filter((event) => event.type === "ACTION_COMPLETED");
      if (!terminal || unsafe || actions.length === 0) continue;
      const eligible = actions.every((event) => {
        const authorization = event.metadata.authorizationResult;
        const risk = event.metadata.riskResult;
        return authorization === "ALLOW" &&
          (risk === "ALLOW" || (risk === "WARN" && event.metadata.approved === true));
      });
      if (!eligible) continue;
      sourceRunIds.push(run.id);
      for (const event of actions) {
        const capability = event.action?.capability;
        const targetNodeId = event.resource?.resourceId;
        if (isCapability(capability) && targetNodeId) {
          normal.set(`${capability}\0${targetNodeId}`, { capability, targetNodeId });
        }
        if (typeof event.metadata.blastRadius === "number" && Number.isSafeInteger(event.metadata.blastRadius) && event.metadata.blastRadius >= 0) {
          blastRadii.push(event.metadata.blastRadius);
        }
        depths.push(event.delegation?.depth ?? 0);
      }
    }
    const latest = await this.security.getLatestBaseline(agentId);
    const normalScope = [...normal.values()].sort((left, right) =>
      `${left.capability}:${left.targetNodeId}`.localeCompare(`${right.capability}:${right.targetNodeId}`));
    const typicalBlastRadius = median(blastRadii);
    const maximumBlastRadius = Math.max(0, ...blastRadii);
    const typicalDelegationDepth = median(depths);
    const same = latest &&
      JSON.stringify(latest.sourceRunIds) === JSON.stringify(sourceRunIds) &&
      JSON.stringify(latest.normalScope) === JSON.stringify(normalScope) &&
      latest.typicalBlastRadius === typicalBlastRadius &&
      latest.maximumBlastRadius === maximumBlastRadius &&
      latest.typicalDelegationDepth === typicalDelegationDepth &&
      latest.historyWindowRunLimit === this.historyWindowRunLimit &&
      latest.historyWindowRunCount === completedRuns.length &&
      latest.historyWindowStartAt === historyWindowStartAt &&
      latest.historyWindowEndAt === historyWindowEndAt;
    if (same) return latest;
    const baseline: BehavioralBaseline = {
      id: `baseline:${randomUUID()}`,
      agentId,
      revision: (latest?.revision ?? 0) + 1,
      minimumHistory: this.minimumHistory,
      historyWindowRunLimit: this.historyWindowRunLimit,
      historyWindowRunCount: completedRuns.length,
      historyWindowStartAt,
      historyWindowEndAt,
      eligibleRunCount: sourceRunIds.length,
      sourceRunIds,
      normalScope,
      typicalBlastRadius,
      maximumBlastRadius,
      typicalDelegationDepth,
      inclusionPolicy: INCLUSION_POLICY,
      calculatedAt: new Date().toISOString(),
    };
    return this.security.saveBaseline(baseline);
  }
}

function completedRunTime(run: AgentRun): string {
  return run.completedAt ?? run.createdAt;
}

function compareCompletedRuns(left: AgentRun, right: AgentRun): number {
  return completedRunTime(left).localeCompare(completedRunTime(right)) ||
    left.id.localeCompare(right.id);
}

export class BehavioralRiskService {
  constructor(
    private readonly security: SecurityStore,
    private readonly baselines: BehavioralBaselineService,
    private readonly warnThreshold = 20,
    private readonly blockThreshold = 40,
  ) {}

  async assess(input: {
    policyDecisionId: string;
    authorization: AuthorizationDecision;
    identity: ExecutionIdentity;
    target: GraphNode;
    impact: ResourceImpact;
    graphRevision: string;
    createdAt: string;
  }): Promise<{
    decision: Omit<RiskDecision, "breakerState" | "breakerVersion">;
    requestedState: "NORMAL" | "WARN" | "TRIPPED";
  }> {
    const baseline = await this.baselines.rebuild(input.identity.actorAgentId);
    const mature = baseline.eligibleRunCount >= baseline.minimumHistory;
    const factors: RiskFactor[] = [];
    const currentBreaker = await this.security.getBreaker(input.identity.actorAgentId);
    if (currentBreaker.state === "TRIPPED") {
      factors.push({ code: "BREAKER_ALREADY_TRIPPED", expected: "NORMAL", observed: "TRIPPED", contribution: this.blockThreshold, explanation: "The safety stop is already active for this Agent." });
    } else if (currentBreaker.state === "WARN") {
      factors.push({ code: "BREAKER_WARN_PENDING", expected: "NORMAL", observed: "WARN", contribution: this.warnThreshold, explanation: "A previous unusual action is still waiting for human review." });
    }
    if (input.target.classification === "restricted" || input.target.riskLevel === "critical") {
      factors.push({ code: "SENSITIVE_RESOURCE", expected: false, observed: true, contribution: 20, explanation: `${input.target.label} is marked as restricted or critical.` });
    }
    const sensitiveDownstream = input.impact.targets
      .filter((target) =>
        target.node.id !== input.target.id &&
        (target.node.classification === "restricted" || target.node.riskLevel === "critical"))
      .sort((left, right) =>
        right.node.riskWeight - left.node.riskWeight || left.node.id.localeCompare(right.node.id));
    const mostSensitiveDownstream = sensitiveDownstream[0];
    if (mostSensitiveDownstream) {
      const pathLabels = mostSensitiveDownstream.path.nodeIds.map((nodeId) =>
        input.impact.targets.find((target) => target.node.id === nodeId)?.node.label ?? nodeId);
      factors.push({
        code: "SENSITIVE_DOWNSTREAM",
        expected: 0,
        observed: sensitiveDownstream.length,
        contribution: 20,
        explanation: `${mostSensitiveDownstream.node.label} is a restricted or critical downstream dependency reached through ${pathLabels.join(" → ")}.`,
        path: mostSensitiveDownstream.path.nodeIds,
      });
    }
    const known = baseline.normalScope.some((scope) =>
      scope.capability === input.authorization.capability && scope.targetNodeId === input.target.id);
    if (mature && !known) {
      factors.push({ code: "NOVEL_RESOURCE", expected: `${baseline.normalScope.length} previously trusted resource actions`, observed: `${input.authorization.capability}:${input.target.id}`, contribution: 20, explanation: `${input.target.label} has not appeared in this Agent's ${baseline.eligibleRunCount} trusted prior Runs.` });
    }
    const expandedBeyondTrusted =
      input.impact.blastRadius >= baseline.maximumBlastRadius + 2 &&
      input.impact.blastRadius > Math.max(2, baseline.maximumBlastRadius * 1.5);
    if (mature && expandedBeyondTrusted) {
      const path = input.impact.targets.at(-1)?.path.nodeIds;
      factors.push({ code: "BLAST_RADIUS_EXPANSION", expected: baseline.maximumBlastRadius, observed: input.impact.blastRadius, contribution: 25, explanation: `This action and its downstream dependencies include ${input.impact.blastRadius} resources; trusted Runs included at most ${baseline.maximumBlastRadius}.`, ...(path ? { path } : {}) });
    }
    const depth = input.identity.delegationChain.length;
    if (depth > Math.max(2, baseline.typicalDelegationDepth + 1)) {
      factors.push({ code: "DELEGATION_DEPTH", expected: baseline.typicalDelegationDepth, observed: depth, contribution: 15, explanation: `Delegation depth ${depth} is higher than the trusted pattern of ${baseline.typicalDelegationDepth}.` });
    }
    const score = factors.reduce((total, factor) => total + factor.contribution, 0);
    const result = score >= this.blockThreshold ? "BLOCK" : score >= this.warnThreshold ? "WARN" : "ALLOW";
    const reasonCode = result === "BLOCK" ? "BEHAVIOR_AND_IMPACT_BLOCK" : result === "WARN" ? "UNUSUAL_ACTION_REQUIRES_REVIEW" : "MATCHES_TRUSTED_BEHAVIOR";
    const explanation = explain(result, input.target.label, factors, input.impact);
    const requestedState = result === "BLOCK" ? "TRIPPED" : result === "WARN" ? "WARN" : "NORMAL";
    const decision: Omit<RiskDecision, "breakerState" | "breakerVersion"> = {
      id: `risk:${randomUUID()}`,
      policyDecisionId: input.policyDecisionId,
      authorizationDecisionId: input.authorization.id,
      runId: input.authorization.runId,
      actorAgentId: input.identity.actorAgentId,
      targetNodeId: input.target.id,
      result,
      reasonCode,
      score,
      warnThreshold: this.warnThreshold,
      blockThreshold: this.blockThreshold,
      graphRevision: input.graphRevision,
      baselineId: baseline.id,
      baselineRevision: baseline.revision,
      factors,
      explanation,
      createdAt: input.createdAt,
    };
    return { decision, requestedState };
  }
}

function explain(result: RiskDecision["result"], resource: string, factors: RiskFactor[], impact: ResourceImpact): string {
  if (result === "ALLOW") return `Allowed because ${resource} matches trusted behavior and has a limited downstream impact.`;
  const reasons = factors.map((factor) => factor.explanation);
  const affected = impact.targets
    .filter((target) => target.node.id !== impact.resource.id)
    .slice(0, 4)
    .map((target) => target.node.label);
  const action = result === "BLOCK" ? "Blocked before anything changed" : "Paused for review";
  return `${action} because ${reasons.join(" ")}${affected.length ? ` Potentially affected: ${affected.join(", ")}.` : ""}`;
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) / 2)]!;
}
function isCapability(value: unknown): value is "CAN_READ" | "CAN_WRITE" | "CAN_CALL" | "CAN_USE" {
  return value === "CAN_READ" || value === "CAN_WRITE" || value === "CAN_CALL" || value === "CAN_USE";
}
