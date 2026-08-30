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

/** The subset of AgentService the gateway needs to prove Run ownership. */
export interface RunAuthority {
  getRun(runId: string): AgentRun;
  getAgent(agentId: string): Agent;
}

export interface GrantedAction {
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
 * Performs an action that policy has already authorized. An adapter is never
 * consulted before a decision is claimed, so it can assume it is allowed to
 * act and does not repeat any permission logic.
 */
export interface ResourceAdapter {
  execute(action: GrantedAction): Promise<ResourceActionResult>;
}

export type GatewayResponse =
  | {
      status: "executed";
      decision: PolicyDecisionRecord;
      result: ResourceActionResult;
    }
  | {
      status: "approval_required";
      decision: PolicyDecisionRecord;
      approvalRequest: ApprovalRequestRecord;
    }
  | { status: "denied"; decision: PolicyDecisionRecord };

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
 * The POC resource backend.
 *
 * It deliberately performs simulated effects rather than touching real systems,
 * and CAN_USE mints a short-lived opaque handle instead of ever returning a
 * real secret value. The point of the demo is that the *decision* is real, not
 * that the side effect is.
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
    private readonly adapter: ResourceAdapter = new DemoResourceAdapter(),
  ) {}

  async request(input: {
    runId: string;
    operationId: string;
    capability: CapabilityRelation;
    targetNodeId: string;
    payload?: Record<string, unknown> | undefined;
    actorPrincipalId: string;
  }): Promise<GatewayResponse> {
    const { run, agent } = this.requireEligibleRun(input.runId);
    const payload = input.payload ?? {};

    const request: ProtectedActionRequest = {
      operationId: input.operationId,
      runId: run.id,
      agentId: agent.id,
      capability: input.capability,
      targetNodeId: input.targetNodeId,
      payload,
      actorPrincipalId: input.actorPrincipalId,
    };
    const evaluation = await this.policy.evaluate(request);

    if (evaluation.decision.result === "DENY") {
      return { status: "denied", decision: evaluation.decision };
    }
    if (evaluation.decision.result === "REVIEW_REQUIRED") {
      return {
        status: "approval_required",
        decision: evaluation.decision,
        approvalRequest: evaluation.approvalRequest!,
      };
    }
    return this.execute(evaluation.decision, agent, payload, input.actorPrincipalId);
  }

  /**
   * Executes an action that a human approved. The payload must be identical to
   * the one that was reviewed; the recomputed request hash enforces that.
   */
  async resume(input: {
    runId: string;
    decisionId: string;
    payload?: Record<string, unknown> | undefined;
    actorPrincipalId: string;
  }): Promise<GatewayResponse> {
    const { run, agent } = this.requireEligibleRun(input.runId);
    const detail = await this.policy.getDecision(input.decisionId);
    if (detail.decision.runId !== run.id) {
      throw new HttpError(403, "This decision belongs to a different Run");
    }
    return this.execute(detail.decision, agent, input.payload ?? {}, input.actorPrincipalId);
  }

  private async execute(
    decision: PolicyDecisionRecord,
    agent: Agent,
    payload: Record<string, unknown>,
    actorPrincipalId: string,
  ): Promise<GatewayResponse> {
    const claimed = await this.policy.claimForExecution({
      decisionId: decision.id,
      agentId: agent.id,
      actorPrincipalId,
      payload,
    });
    const target = await this.graphStore.getNode(claimed.targetNodeId);
    if (!target) throw new HttpError(404, "The protected resource no longer exists");

    const result = await this.adapter.execute({
      runId: claimed.runId,
      agentId: agent.id,
      agentNodeId: claimed.agentNodeId,
      capability: claimed.capabilityRelation,
      target,
      payload,
      decision: claimed,
    });
    await this.policy.recordSuccess(claimed);
    return { status: "executed", decision: claimed, result };
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
