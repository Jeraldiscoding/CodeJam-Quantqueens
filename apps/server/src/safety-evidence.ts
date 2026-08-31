import type { PolicyService } from "./policy-service.js";
import type { RunEvent, RunTimeline } from "./run-timeline.js";
import type { SecurityStore } from "./security-store.js";
import type { DelegationRecord, RiskFactor } from "./security-types.js";
import type { Agent, AgentRun } from "./types.js";

export interface SafetyEvidenceRunDirectory {
  getAgent(agentId: string): Agent;
  getRuns(agentId: string): AgentRun[];
}

export interface SafetyEvidence {
  schemaVersion: 1;
  run: Pick<AgentRun, "id" | "agentId" | "status" | "createdAt" | "completedAt">;
  action: {
    operationId: string;
    capability: string;
    resourceId: string;
    resourceLabel: string;
  };
  identity: {
    originPrincipalId: string;
    rootAgentId: string;
    actorAgentId: string;
    delegationChain: Array<{
      id: string;
      parentAgentId: string;
      childAgentId: string;
      depth: number;
      effectiveCapabilities: string[];
    }>;
  };
  verdict: {
    permission: "ALLOW" | "DENY";
    safety: "ALLOW" | "WARN" | "BLOCK" | "NOT_EVALUATED";
    effect: "COMPLETED" | "PREVENTED" | "WAITING_FOR_REVIEW" | "FAILED" | "UNKNOWN";
    explanation: string;
  };
  historicalContext: null | {
    baselineId: string;
    revision: number;
    sourceRunIds: string[];
    trustedRunCount: number;
    normalScope: Array<{ capability: string; targetNodeId: string }>;
    maximumBlastRadius: number;
    factors: RiskFactor[];
  };
  impactAtDecision: {
    blastRadius: number;
    targets: Array<{ id: string; label: string; path: string[] }>;
  };
  effectEvidence: {
    policyClaimed: boolean;
    completionEventRecorded: boolean;
    durableStateLastOperationId: string | null;
    durableStateChangedByThisAction: boolean;
  };
  timeline: {
    eventCount: number;
    firstSequence: number;
    lastSequence: number;
  };
  coverage: {
    scope: "managed_resource_actions";
    label: string;
    guarantee: string;
    limitation: string;
  };
}

/** Builds one durable, judge-readable proof from authoritative runtime records. */
export class SafetyEvidenceService {
  constructor(
    private readonly runs: SafetyEvidenceRunDirectory,
    private readonly policy: PolicyService,
    private readonly security: SecurityStore,
    private readonly timeline: RunTimeline,
  ) {}

  async latestForAgent(agentId: string): Promise<SafetyEvidence | null> {
    this.runs.getAgent(agentId);
    const orderedRuns = [...this.runs.getRuns(agentId)].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
    );
    for (const run of orderedRuns) {
      const decisions = await this.policy.getDecisionsForRun(run.id);
      const detail = decisions.at(-1);
      if (!detail?.authorization) continue;

      const events = await this.timeline.list(run.id);
      const risk = detail.risk;
      const baseline = risk?.baselineId
        ? await this.security.getBaseline(risk.baselineId)
        : null;
      const durableState = await this.security.getManagedResourceState(
        detail.decision.targetNodeId,
      );
      const completion = events.find((event) =>
        event.type === "ACTION_COMPLETED" &&
        event.action?.operation === detail.decision.operationId,
      );
      const delegationChain = await this.readDelegationChain(
        detail.authorization.delegationId,
      );
      const impact = readDecisionImpact(detail.decision.evidence);
      const permission = detail.authorization.result;
      const safety = risk?.result ?? "NOT_EVALUATED";
      const effect = determineEffect(
        run,
        permission,
        safety,
        detail.claimed,
        Boolean(completion),
      );

      return {
        schemaVersion: 1,
        run: {
          id: run.id,
          agentId: run.agentId,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        },
        action: {
          operationId: detail.decision.operationId,
          capability: detail.decision.capabilityRelation,
          resourceId: detail.decision.targetNodeId,
          resourceLabel: impact.targets.find((target) =>
            target.id === detail.decision.targetNodeId)?.label ?? readableResource(detail.decision.targetNodeId),
        },
        identity: {
          originPrincipalId: detail.authorization.originPrincipalId,
          rootAgentId: typeof detail.authorization.evidence.rootAgentId === "string"
            ? detail.authorization.evidence.rootAgentId
            : run.agentId,
          actorAgentId: detail.authorization.actorAgentId,
          delegationChain: delegationChain.map(projectDelegation),
        },
        verdict: {
          permission,
          safety,
          effect,
          explanation: risk?.explanation ??
            (permission === "DENY"
              ? "The action was blocked because the current identity, Agent permission, or delegated scope did not allow it."
              : completion?.reason ?? "The protected action passed its permission and safety checks."),
        },
        historicalContext: risk?.baselineId && risk.baselineRevision !== undefined
          ? {
              baselineId: risk.baselineId,
              revision: risk.baselineRevision,
              sourceRunIds: baseline?.sourceRunIds ?? [],
              trustedRunCount: baseline?.eligibleRunCount ?? 0,
              normalScope: baseline?.normalScope ?? [],
              maximumBlastRadius: baseline?.maximumBlastRadius ?? 0,
              factors: risk.factors,
            }
          : null,
        impactAtDecision: impact,
        effectEvidence: {
          policyClaimed: detail.claimed,
          completionEventRecorded: Boolean(completion),
          durableStateLastOperationId: durableState?.lastOperationId ?? null,
          durableStateChangedByThisAction:
            durableState?.lastOperationId === detail.decision.operationId,
        },
        timeline: {
          eventCount: events.length,
          firstSequence: events[0]?.sequence ?? 0,
          lastSequence: events.at(-1)?.sequence ?? 0,
        },
        coverage: {
          scope: "managed_resource_actions",
          label: "Protected managed resource actions",
          guarantee: "Permission, graph impact, learned behavior, and the safety stop are checked before the managed adapter can change the resource.",
          limitation: "Ordinary Codex shell, filesystem, and network operations are not transparently intercepted by this managed-action proof path.",
        },
      };
    }
    return null;
  }

  private async readDelegationChain(leafId?: string): Promise<DelegationRecord[]> {
    if (!leafId) return [];
    const chain: DelegationRecord[] = [];
    const visited = new Set<string>();
    let current = await this.security.getDelegation(leafId);
    while (current) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      chain.unshift(current);
      current = current.parentDelegationId
        ? await this.security.getDelegation(current.parentDelegationId)
        : null;
    }
    return chain;
  }
}

function projectDelegation(record: DelegationRecord) {
  return {
    id: record.id,
    parentAgentId: record.parentAgentId,
    childAgentId: record.childAgentId,
    depth: record.depth,
    effectiveCapabilities: record.effectiveScope.map((scope) =>
      `${scope.capability}:${scope.targetNodeId}`,
    ),
  };
}

function readDecisionImpact(evidence: Record<string, unknown>): SafetyEvidence["impactAtDecision"] {
  const blastRadius = typeof evidence.blastRadius === "number" &&
    Number.isSafeInteger(evidence.blastRadius) && evidence.blastRadius >= 0
    ? evidence.blastRadius
    : 0;
  const storedTargets = Array.isArray(evidence.impactTargets)
    ? evidence.impactTargets
    : evidence.scoredTargets;
  const targets = Array.isArray(storedTargets)
    ? storedTargets.flatMap((value) => {
        if (!isObject(value) || typeof value.id !== "string") return [];
        const path = Array.isArray(value.path)
          ? value.path.filter((item): item is string => typeof item === "string")
          : [];
        return [{
          id: value.id,
          label: typeof value.label === "string" ? value.label : readableResource(value.id),
          path,
        }];
      })
    : [];
  const labels = new Map(targets.map((target) => [target.id, target.label]));
  return {
    blastRadius,
    targets: targets.map((target) => ({
      ...target,
      path: target.path.map((id) => labels.get(id) ?? readableResource(id)),
    })),
  };
}

function determineEffect(
  run: AgentRun,
  permission: "ALLOW" | "DENY",
  safety: SafetyEvidence["verdict"]["safety"],
  claimed: boolean,
  completed: boolean,
): SafetyEvidence["verdict"]["effect"] {
  if (completed) return "COMPLETED";
  if (!claimed && (permission === "DENY" || safety === "BLOCK")) return "PREVENTED";
  if (!claimed && safety === "WARN") return "WAITING_FOR_REVIEW";
  if (run.status === "failed") return "FAILED";
  return "UNKNOWN";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readableResource(id: string): string {
  return id.replace(/^asset:/, "").replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}
