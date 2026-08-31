import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";
import type { CapabilityRelation } from "./policy-store.js";
import {
  PostEffectFinalizationError,
  type GatewayResponse,
  type ResourceGateway,
} from "./resource-gateway.js";
import type { AuthenticatedPrincipal, CircuitBreakerRecord } from "./security-types.js";
import type { SecurityStore } from "./security-store.js";
import type { RunTimeline } from "./run-timeline.js";

/**
 * Narrow Agent-accessible runtime for managed resources. Unlike Codex stream
 * parsing, the action cannot reach its adapter except through ResourceGateway.
 */
export class ControlledActionRuntime {
  constructor(
    private readonly agents: AgentService,
    private readonly gateway: ResourceGateway,
    private readonly security?: SecurityStore,
    private readonly timeline?: RunTimeline,
  ) {}

  async request(input: {
    agentId: string;
    principal: AuthenticatedPrincipal;
    capability: CapabilityRelation;
    targetNodeId: string;
    payload?: Record<string, unknown>;
    delegationId?: string;
  }): Promise<{ run: ReturnType<AgentService["getRun"]>; outcome: GatewayResponse }> {
    const release = this.agents.beginManagedActionRequest(input.agentId);
    try {
      const run = await this.agents.createManagedActionRun(
        input.agentId,
        `${input.capability} ${input.targetNodeId}`,
        input.principal,
      );
      let effectCompleted = false;
      try {
        const outcome = await this.gateway.request({
          runId: run.id,
          operationId: `managed:${run.id}`,
          capability: input.capability,
          targetNodeId: input.targetNodeId,
          ...(input.payload ? { payload: input.payload } : {}),
          principal: input.principal,
          ...(input.delegationId ? { delegationId: input.delegationId } : {}),
        });
        if (outcome.status === "executed") {
          effectCompleted = true;
          await this.finishTerminalWithRepair(run.id, "completed", outcome.result.summary);
        } else if (outcome.status === "approval_required") {
          await this.agents.finishManagedActionRun(run.id, "awaiting_approval", "The unusual action is waiting for review.");
        } else {
          await this.finishTerminalWithRepair(run.id, "failed", plainBlockReason(outcome));
        }
        return { run: this.agents.getRun(run.id), outcome };
      } catch (error) {
        if (error instanceof PostEffectFinalizationError) {
          effectCompleted = true;
          await this.finishTerminalWithRepair(
            run.id,
            "completed",
            `${error.result.summary}. The effect completed, but middleware audit finalization needs attention.`,
          );
          throw error;
        }
        const current = this.agents.getRun(run.id);
        if (
          !effectCompleted &&
          (current.status === "running" || current.status === "awaiting_approval")
        ) {
          await this.finishTerminalWithRepair(
            run.id,
            "failed",
            `Protected action failed closed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  async resume(input: {
    runId: string;
    decisionId: string;
    principal: AuthenticatedPrincipal;
    payload?: Record<string, unknown>;
    delegationId?: string;
  }): Promise<{ run: ReturnType<AgentService["getRun"]>; outcome: GatewayResponse }> {
    let outcome: GatewayResponse;
    try {
      outcome = await this.gateway.resume({
        runId: input.runId,
        decisionId: input.decisionId,
        ...(input.payload ? { payload: input.payload } : {}),
        principal: input.principal,
        ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      });
    } catch (error) {
      if (error instanceof PostEffectFinalizationError) {
        await this.finishTerminalWithRepair(
          input.runId,
          "completed",
          `${error.result.summary}. The effect completed, but middleware audit finalization needs attention.`,
        );
      }
      throw error;
    }
    if (outcome.status === "executed") {
      await this.finishTerminalWithRepair(input.runId, "completed", outcome.result.summary);
    }
    return { run: this.agents.getRun(input.runId), outcome };
  }

  /**
   * Finalizes a managed action after PolicyService has durably recorded a
   * human rejection. The WARN breaker deliberately remains fail-closed until
   * an audited administrative reset or another explicit recovery policy.
   */
  async finishRejected(runId: string, reason: string) {
    const run = this.agents.getRun(runId);
    if (run.kind !== "managed_action") {
      throw new HttpError(409, "This is not a managed action Run");
    }
    if (run.status !== "awaiting_approval") {
      throw new HttpError(409, `Run ${run.id} is ${run.status} and is not awaiting approval`);
    }
    await this.finishTerminalWithRepair(
      run.id,
      "failed",
      `A reviewer rejected this protected action: ${reason}`,
    );
    return this.agents.getRun(run.id);
  }

  /**
   * A terminal JSON transition may succeed just before its SQLite event write
   * is interrupted. The AgentService transition is idempotent and binds the
   * retry to the original status, reason, timestamp, and deterministic event.
   */
  private async finishTerminalWithRepair(
    runId: string,
    outcome: "completed" | "failed",
    reason: string,
  ): Promise<void> {
    try {
      await this.agents.finishManagedActionRun(runId, outcome, reason);
    } catch (firstError) {
      try {
        await this.agents.finishManagedActionRun(runId, outcome, reason);
      } catch {
        throw firstError;
      }
    }
  }

  async resetSafetyStop(input: {
    agentId: string;
    principal: AuthenticatedPrincipal;
    reason: string;
  }) {
    if (!this.security || !this.timeline) {
      throw new Error("Audited safety-stop reset is unavailable");
    }
    const release = this.agents.beginManagedActionRequest(input.agentId);
    try {
      const run = await this.agents.createManagedActionRun(
        input.agentId,
        "Reset the Agent safety stop",
        input.principal,
      );
      const previous = await this.security.getBreaker(input.agentId);
      const baseline = await this.security.getLatestBaseline(input.agentId);
      let reset: CircuitBreakerRecord;
      try {
        reset = await this.security.resetBreaker(
          input.agentId,
          input.reason,
          new Date().toISOString(),
        );
        try {
          await this.timeline.append({
            runId: run.id,
            type: "CIRCUIT_BREAKER_TRANSITIONED",
            actor: {
              principalId: input.principal.id,
              kind: "human",
              displayName: input.principal.displayName,
              originPrincipalId: input.principal.id,
              agentId: input.agentId,
            },
            agentId: input.agentId,
            action: { operation: "reset_safety_stop" },
            decision: {
              layer: "circuit_breaker",
              result: reset.state,
              reasonCode: reset.reasonCode,
            },
            outcome: "allowed",
            reasonCode: reset.reasonCode,
            reason: input.reason,
            metadata: {
              previousState: previous.state,
              previousVersion: previous.version,
              newState: reset.state,
              newVersion: reset.version,
              breakerState: reset.state,
              breakerVersion: reset.version,
              transitionKind: "manual_reset",
              // A manual reset is not caused by a score crossing. Null makes
              // that distinction explicit instead of fabricating thresholds.
              warnThreshold: null,
              blockThreshold: null,
              historyWindow: baseline
                ? {
                    startAt: baseline.historyWindowStartAt,
                    endAt: baseline.historyWindowEndAt,
                    runLimit: baseline.historyWindowRunLimit,
                    inspectedRunCount: baseline.historyWindowRunCount,
                    eligibleRunCount: baseline.eligibleRunCount,
                    sourceRunCount: baseline.sourceRunIds.length,
                    sourceRunIds: baseline.sourceRunIds.slice(-20),
                    sourceRunIdsTruncated: baseline.sourceRunIds.length > 20,
                    minimumHistory: baseline.minimumHistory,
                    inclusionPolicy: baseline.inclusionPolicy,
                    calculatedAt: baseline.calculatedAt,
                  }
                : null,
            },
          });
        } catch (error) {
          await this.security.restoreBreaker(previous, reset.version);
          throw error;
        }
        await this.finishTerminalWithRepair(
          run.id,
          "completed",
          `The safety stop was reset from ${previous.state} to ${reset.state}.`,
        );
        return { run: this.agents.getRun(run.id), circuitBreaker: reset };
      } catch (error) {
        if (this.agents.getRun(run.id).status === "running") {
          await this.finishTerminalWithRepair(
            run.id,
            "failed",
            `Safety-stop reset failed closed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
    } finally {
      release();
    }
  }
}

function plainBlockReason(outcome: Extract<GatewayResponse, { status: "denied" }>): string {
  return outcome.risk?.explanation ??
    "Blocked because the authenticated identity or Agent did not have the required permission. Nothing changed.";
}
