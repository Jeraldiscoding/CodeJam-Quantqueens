import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { GraphNode, GraphStore } from "./graph-types.js";
import type { PolicyService, ProtectedActionRequest } from "./policy-service.js";
import type {
  ApprovalRequestRecord,
  CapabilityRelation,
  PolicyDecisionRecord,
} from "./policy-store.js";
import type { Agent, AgentRun } from "./types.js";
import type { ExecutionIdentityService } from "./execution-identity.js";
import type { AuthenticatedPrincipal, ExecutionIdentity, RiskDecision, AuthorizationDecision } from "./security-types.js";
import { appendRequiredRunEvent, type RunTimeline } from "./run-timeline.js";

/** The subset of AgentService the gateway needs to prove Run ownership. */
export interface RunAuthority {
  getRun(runId: string): AgentRun;
  getAgent(agentId: string): Agent;
  beginProtectedAction?(runId: string): () => void;
  beginAgentProtectedAction?(agentId: string): () => void;
  assertProtectedActionMayExecute?(runId: string): void;
  assertAgentProtectedActionMayExecute?(agentId: string): void;
}

export interface GrantedAction {
  operationId: string;
  runId: string;
  agentId: string;
  agentNodeId: string;
  capability: CapabilityRelation;
  target: GraphNode;
  payload: Record<string, unknown>;
  decision: PolicyDecisionRecord;
}

export interface ResourceActionResult {
  kind: "read" | "write" | "call" | "credential";
  summary: string;
  detail: Record<string, unknown>;
}

/**
 * The protected adapter effect happened, but one of its downstream audit
 * projections could not be finalized. Callers must never describe this as a
 * pre-effect denial or assume the resource stayed unchanged.
 */
export class PostEffectFinalizationError extends Error {
  readonly name = "PostEffectFinalizationError";

  constructor(
    readonly decision: PolicyDecisionRecord,
    readonly result: ResourceActionResult,
    readonly finalizationStage: "graph_audit" | "timeline",
    cause: unknown,
  ) {
    super(
      `The protected effect completed, but ${finalizationStage === "graph_audit" ? "graph audit" : "timeline"} finalization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Performs an action that policy has already authorized. An adapter is never
 * consulted before a decision is claimed. Production adapters should still
 * validate the claim at their own effect boundary when they share an
 * authoritative store, as the managed SQLite adapter does.
 */
export interface ResourceAdapter {
  execute(action: GrantedAction): Promise<ResourceActionResult>;
}

export type GatewayResponse =
  | {
      status: "executed";
      decision: PolicyDecisionRecord;
      authorization?: AuthorizationDecision;
      risk?: RiskDecision;
      result: ResourceActionResult;
    }
  | {
      status: "approval_required";
      decision: PolicyDecisionRecord;
      authorization?: AuthorizationDecision;
      risk?: RiskDecision;
      approvalRequest: ApprovalRequestRecord;
    }
  | { status: "denied"; decision: PolicyDecisionRecord; authorization?: AuthorizationDecision; risk?: RiskDecision };

const capabilityKinds: Record<CapabilityRelation, ResourceActionResult["kind"]> = {
  CAN_READ: "read",
  CAN_WRITE: "write",
  CAN_CALL: "call",
  CAN_USE: "credential",
};

const activeRunStatuses = new Set<AgentRun["status"]>([
  "queued",
  "running",
  "awaiting_approval",
]);

/**
 * Legacy in-memory adapter for narrow unit tests only.
 *
 * It deliberately performs simulated effects rather than touching real systems,
 * and CAN_USE mints a short-lived opaque handle instead of ever returning a
 * real secret value. Production wiring must pass an explicit real adapter;
 * ResourceGateway intentionally has no simulated default.
 */
export class DemoResourceAdapter implements ResourceAdapter {
  private readonly writeJournal = new Map<string, number>();
  private readonly handles = new Map<string, { targetId: string; expiresAt: string }>();

  constructor(private readonly handleTtlMs = 300_000) {}

  async execute(action: GrantedAction): Promise<ResourceActionResult> {
    const kind = capabilityKinds[action.capability];
    if (kind === "read") {
      return {
        kind,
        summary: `Read metadata for ${action.target.label}`,
        detail: {
          targetId: action.target.id,
          classification: action.target.classification,
          riskLevel: action.target.riskLevel,
          contents: "<redacted by the Resource Gateway>",
        },
      };
    }
    if (kind === "write") {
      const revision = (this.writeJournal.get(action.target.id) ?? 0) + 1;
      this.writeJournal.set(action.target.id, revision);
      return {
        kind,
        summary: `Wrote a revision to ${action.target.label}`,
        detail: {
          targetId: action.target.id,
          revision,
          fields: Object.keys(action.payload).sort(),
        },
      };
    }
    if (kind === "call") {
      return {
        kind,
        summary: `Called ${action.target.label}`,
        detail: {
          targetId: action.target.id,
          operation: String(action.payload.operation ?? "invoke"),
          accepted: true,
        },
      };
    }
    const handle = `handle:${randomUUID()}`;
    const expiresAt = new Date(Date.now() + this.handleTtlMs).toISOString();
    this.handles.set(handle, { targetId: action.target.id, expiresAt });
    return {
      kind,
      summary: `Issued a scoped handle for ${action.target.label}`,
      detail: {
        handle,
        expiresAt,
        scope: action.target.id,
        note: "This is a reference, not a secret value. The gateway never returns real material.",
      },
    };
  }
}

/**
 * The one place a Run may reach a protected resource.
 *
 * Every call is scored against the Knowledge Graph, recorded, and correlated
 * with ATTEMPTED / DENIED / TOUCHED evidence. An unauthorized action never
 * reaches the adapter at all: the gateway returns before execution rather than
 * executing and reporting afterwards.
 */
export class ResourceGateway {
  constructor(
    private readonly policy: PolicyService,
    private readonly graphStore: GraphStore,
    private readonly runs: RunAuthority,
    private readonly adapter: ResourceAdapter,
    private readonly identities?: ExecutionIdentityService,
    private readonly timeline?: RunTimeline,
  ) {}

  async request(input: {
    runId: string;
    operationId: string;
    capability: CapabilityRelation;
    targetNodeId: string;
    payload?: Record<string, unknown> | undefined;
    actorPrincipalId?: string;
    principal?: AuthenticatedPrincipal;
    delegationId?: string;
  }): Promise<GatewayResponse> {
    const release = this.runs.beginProtectedAction?.(input.runId);
    let releaseActor: (() => void) | undefined;
    try {
      const { run, agent: rootAgent } = this.requireEligibleRun(input.runId);
      const identity = await this.resolveIdentity(input, run, rootAgent);
      if (identity.actorAgentId !== run.agentId) {
        releaseActor = this.runs.beginAgentProtectedAction?.(identity.actorAgentId);
      }
      const agent = this.runs.getAgent(identity.actorAgentId);
      const payload = input.payload ?? {};

      await this.appendRequestEvents(
        identity,
        agent,
        input.operationId,
        input.capability,
        input.targetNodeId,
      );

      const request: ProtectedActionRequest = {
        operationId: input.operationId,
        runId: run.id,
        agentId: identity.actorAgentId,
        capability: input.capability,
        targetNodeId: input.targetNodeId,
        payload,
        actorPrincipalId: identity.principal.id,
        identity,
      };
      let evaluation: Awaited<ReturnType<PolicyService["evaluate"]>>;
      try {
        evaluation = await this.policy.evaluate(request);
      } catch (error) {
        await this.appendPreEffectFailure(
          identity,
          agent,
          input.operationId,
          input.capability,
          input.targetNodeId,
          "POLICY_EVALUATION_FAILED",
          error,
        );
        throw error;
      }

      if (evaluation.decision.result === "DENY") {
        return { status: "denied", decision: evaluation.decision, ...(evaluation.authorization ? { authorization: evaluation.authorization } : {}), ...(evaluation.risk ? { risk: evaluation.risk } : {}) };
      }
      if (evaluation.decision.result === "REVIEW_REQUIRED") {
        return {
          status: "approval_required",
          decision: evaluation.decision,
          ...(evaluation.authorization ? { authorization: evaluation.authorization } : {}),
          ...(evaluation.risk ? { risk: evaluation.risk } : {}),
          approvalRequest: evaluation.approvalRequest!,
        };
      }
      return this.execute(evaluation.decision, agent, payload, identity, evaluation.authorization, evaluation.risk);
    } finally {
      releaseActor?.();
      release?.();
    }
  }

  /**
   * Executes an action that a human approved. The payload must be identical to
   * the one that was reviewed; the recomputed request hash enforces that.
   */
  async resume(input: {
    runId: string;
    decisionId: string;
    payload?: Record<string, unknown> | undefined;
    actorPrincipalId?: string;
    principal?: AuthenticatedPrincipal;
    delegationId?: string;
  }): Promise<GatewayResponse> {
    const release = this.runs.beginProtectedAction?.(input.runId);
    let releaseActor: (() => void) | undefined;
    try {
      const { run, agent: rootAgent } = this.requireEligibleRun(input.runId);
      const identity = await this.resolveIdentity(input, run, rootAgent);
      if (identity.actorAgentId !== run.agentId) {
        releaseActor = this.runs.beginAgentProtectedAction?.(identity.actorAgentId);
      }
      const agent = this.runs.getAgent(identity.actorAgentId);
      const detail = await this.policy.getDecision(input.decisionId);
      if (detail.decision.runId !== run.id) {
        throw new HttpError(403, "This decision belongs to a different Run");
      }
      const authorization = this.identities ? await this.policy.getAuthorizationForDecision(detail.decision.id) : undefined;
      const risk = this.identities ? await this.policy.getRiskForDecision(detail.decision.id) : undefined;
      return this.execute(detail.decision, agent, input.payload ?? {}, identity, authorization ?? undefined, risk ?? undefined);
    } finally {
      releaseActor?.();
      release?.();
    }
  }

  private async execute(
    decision: PolicyDecisionRecord,
    agent: Agent,
    payload: Record<string, unknown>,
    identity: ExecutionIdentity,
    authorization?: AuthorizationDecision,
    risk?: RiskDecision,
  ): Promise<GatewayResponse> {
    let claimed: PolicyDecisionRecord;
    let target: GraphNode;
    try {
      this.runs.assertProtectedActionMayExecute?.(decision.runId);
      this.runs.assertAgentProtectedActionMayExecute?.(identity.actorAgentId);
      claimed = await this.policy.claimForExecution({
        decisionId: decision.id,
        agentId: agent.id,
        actorPrincipalId: identity.principal.id,
        actorRole: identity.principal.role,
        delegationChainIds: identity.delegationChain.map((delegation) => delegation.id),
        payload,
      });
      const resolvedTarget = await this.graphStore.getNode(claimed.targetNodeId);
      if (!resolvedTarget) throw new HttpError(404, "The protected resource no longer exists");
      target = resolvedTarget;
    } catch (error) {
      await this.appendPreEffectFailure(
        identity,
        agent,
        decision.operationId,
        decision.capabilityRelation,
        decision.targetNodeId,
        "EXECUTION_CLAIM_FAILED",
        error,
      );
      throw error;
    }

    let result: ResourceActionResult;
    try {
      result = await this.adapter.execute({
        operationId: claimed.operationId,
        runId: claimed.runId,
        agentId: agent.id,
        agentNodeId: claimed.agentNodeId,
        capability: claimed.capabilityRelation,
        target,
        payload,
        decision: claimed,
      });
    } catch (error) {
      if (this.timeline) {
        await this.timeline.append({
          runId: claimed.runId,
          type: "ACTION_FAILED",
          actor: gatewayActor(identity, agent.name),
          agentId: identity.actorAgentId,
          action: { operation: claimed.operationId, capability: claimed.capabilityRelation },
          resource: { resourceId: claimed.targetNodeId, label: target.label },
          ...gatewayDelegation(identity),
          outcome: "failed",
          reasonCode: "ADAPTER_EFFECT_FAILED",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
    const effectCompletedAt = new Date().toISOString();
    let graphAuditFailure: unknown;
    try {
      await this.policy.recordSuccess(claimed);
    } catch (error) {
      graphAuditFailure = error;
    }
    if (this.timeline) {
      try {
        await appendRequiredRunEvent(this.timeline, {
          id: `run-event:effect-completed:${claimed.id}`,
          occurredAt: effectCompletedAt,
          runId: claimed.runId,
          type: "ACTION_COMPLETED",
          actor: gatewayActor(identity, agent.name),
          agentId: identity.actorAgentId,
          action: { operation: claimed.operationId, capability: claimed.capabilityRelation },
          resource: { resourceId: claimed.targetNodeId, label: target.label, kind: typeof target.metadata.kind === "string" ? target.metadata.kind : "resource" },
          ...gatewayDelegation(identity),
          outcome: "succeeded",
          reasonCode: graphAuditFailure
            ? "EFFECT_COMPLETED_GRAPH_AUDIT_PENDING"
            : "ADAPTER_EFFECT_COMPLETED",
          reason: graphAuditFailure
            ? `${result.summary}; the protected effect completed, but its graph audit projection needs repair.`
            : `${result.summary}; the protected effect completed after authorization and safety checks.`,
          metadata: {
            authorizationResult: authorization?.result ?? "ALLOW",
            riskResult: risk?.result ?? "ALLOW",
            approved: claimed.result === "REVIEW_REQUIRED",
            blastRadius: readBlastRadius(risk, claimed),
            adapterKind: target.metadata.adapterKind ?? "demo",
            graphAuditFinalized: !graphAuditFailure,
          },
        });
      } catch (error) {
        throw new PostEffectFinalizationError(claimed, result, "timeline", error);
      }
    }
    if (graphAuditFailure) {
      throw new PostEffectFinalizationError(claimed, result, "graph_audit", graphAuditFailure);
    }
    return { status: "executed", decision: claimed, ...(authorization ? { authorization } : {}), ...(risk ? { risk } : {}), result };
  }

  private async resolveIdentity(
    input: { runId: string; principal?: AuthenticatedPrincipal; delegationId?: string; actorPrincipalId?: string },
    run: AgentRun,
    agent: Agent,
  ): Promise<ExecutionIdentity> {
    if (this.identities) {
      if (!input.principal) throw new HttpError(401, "A verified principal is required for protected actions");
      return this.identities.resolve({ runId: input.runId, principal: input.principal, ...(input.delegationId ? { delegationId: input.delegationId } : {}) });
    }
    const principalId = input.actorPrincipalId ?? "principal:legacy";
    return { principal: { id: principalId, kind: "system", displayName: principalId, role: "operator", authenticationSource: "system" }, runId: run.id, rootAgentId: agent.id, actorAgentId: agent.id, actorAgentNodeId: `agent:${agent.id}`, actorAgentDisplayName: agent.name, delegationChain: [] };
  }

  private async appendRequestEvents(
    identity: ExecutionIdentity,
    agent: Agent,
    operationId: string,
    capability: CapabilityRelation,
    targetNodeId: string,
  ): Promise<void> {
    if (!this.timeline) return;
    const target = await this.graphStore.getNode(targetNodeId);
    const common = { runId: identity.runId, actor: gatewayActor(identity, agent.name), agentId: identity.actorAgentId, action: { operation: operationId, capability }, resource: { resourceId: targetNodeId, ...(target ? { label: target.label, kind: typeof target.metadata.kind === "string" ? target.metadata.kind : "resource" } : {}) }, ...gatewayDelegation(identity), outcome: "pending" as const, reasonCode: "PROTECTED_ACTION_REQUESTED", reason: "The Agent requested a protected resource action; no effect has happened yet." };
    await this.timeline.append({ ...common, type: "ACTION_REQUESTED" });
    await this.timeline.append({ ...common, type: "RESOURCE_ACCESS_ATTEMPTED" });
  }

  private async appendPreEffectFailure(
    identity: ExecutionIdentity,
    agent: Agent,
    operationId: string,
    capability: CapabilityRelation,
    targetNodeId: string,
    reasonCode: string,
    error: unknown,
  ): Promise<void> {
    if (!this.timeline) return;
    try {
      const target = await this.graphStore.getNode(targetNodeId);
      await this.timeline.append({
        runId: identity.runId,
        type: "ACTION_FAILED",
        actor: gatewayActor(identity, agent.name),
        agentId: identity.actorAgentId,
        action: { operation: operationId, capability },
        resource: {
          resourceId: targetNodeId,
          ...(target ? {
            label: target.label,
            kind: typeof target.metadata.kind === "string" ? target.metadata.kind : "resource",
          } : {}),
        },
        ...gatewayDelegation(identity),
        outcome: "failed",
        reasonCode,
        reason: `The protected action stopped before the adapter ran: ${error instanceof Error ? error.message : String(error)}`,
      });
    } catch {
      // Preserve the original fail-closed error. A broken audit store must not
      // be converted into a different error or permit the protected effect.
    }
  }

  private requireEligibleRun(runId: string): { run: AgentRun; agent: Agent } {
    const run = this.runs.getRun(runId);
    const agent = this.runs.getAgent(run.agentId);
    if (!activeRunStatuses.has(run.status)) {
      throw new HttpError(409, `Run ${run.id} is ${run.status} and cannot take new actions`);
    }
    if (agent.status === "stopped") {
      throw new HttpError(409, "This Agent is stopped and is not eligible to act");
    }
    return { run, agent };
  }
}

function gatewayActor(identity: ExecutionIdentity, actorDisplayName?: string) {
  return {
    principalId: `agent:${identity.actorAgentId}`,
    kind: identity.delegation ? "delegated_agent" as const : "agent" as const,
    ...(actorDisplayName ? { displayName: actorDisplayName } : {}),
    originPrincipalId: identity.principal.id,
    originDisplayName: identity.principal.displayName,
    agentId: identity.actorAgentId,
    ...(identity.delegation ? { parentAgentId: identity.delegation.parentAgentId } : {}),
  };
}

function gatewayDelegation(identity: ExecutionIdentity) {
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

function readBlastRadius(risk: RiskDecision | undefined, decision: PolicyDecisionRecord): number {
  const stored = decision.evidence.blastRadius;
  if (typeof stored === "number" && Number.isSafeInteger(stored) && stored >= 0) return stored;
  const expansion = risk?.factors.find((factor) => factor.code === "BLAST_RADIUS_EXPANSION");
  return typeof expansion?.observed === "number" ? expansion.observed : 0;
}
