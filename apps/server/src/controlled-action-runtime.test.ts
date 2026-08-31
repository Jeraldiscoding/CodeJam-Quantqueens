import { describe, expect, it, vi } from "vitest";
import type { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ControlledActionRuntime } from "./controlled-action-runtime.js";
import type { PolicyService } from "./policy-service.js";
import type { PolicyDecisionRecord } from "./policy-store.js";
import {
  PostEffectFinalizationError,
  type ResourceGateway,
} from "./resource-gateway.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import type { AgentRun } from "./types.js";

const timestamp = "2026-08-31T12:00:00.000Z";

function managedRun(status: AgentRun["status"] = "awaiting_approval"): AgentRun {
  return {
    id: "run:managed-review",
    agentId: "agent-id",
    status,
    prompt: "CAN_WRITE asset:configuration",
    output: null,
    error: null,
    usage: null,
    startedAt: timestamp,
    completedAt: null,
    createdAt: timestamp,
    kind: "managed_action",
    originPrincipalId: "human:alice",
  };
}

describe("ControlledActionRuntime managed rejection", () => {
  it("turns a rejected managed review into a terminal Run without invoking the gateway", async () => {
    const run = managedRun();
    const finishManagedActionRun = vi.fn(async (
      _runId: string,
      outcome: "completed" | "failed" | "awaiting_approval",
      reason: string,
    ) => {
      run.status = outcome;
      run.error = outcome === "failed" ? reason : null;
      run.completedAt = outcome === "awaiting_approval" ? null : timestamp;
      return run;
    });
    const agents = {
      getRun: () => run,
      finishManagedActionRun,
    } as unknown as AgentService;
    const gateway = {
      request: vi.fn(),
      resume: vi.fn(),
    } as unknown as ResourceGateway;
    const runtime = new ControlledActionRuntime(agents, gateway);

    const finished = await runtime.finishRejected(run.id, "Change window is closed");

    expect(finishManagedActionRun).toHaveBeenCalledWith(
      run.id,
      "failed",
      "A reviewer rejected this protected action: Change window is closed",
    );
    expect(finished).toMatchObject({
      status: "failed",
      completedAt: timestamp,
      error: expect.stringContaining("reviewer rejected"),
    });
    expect(gateway.request).not.toHaveBeenCalled();
    expect(gateway.resume).not.toHaveBeenCalled();
  });

  it("refuses to rewrite a non-pending or conversational Run", async () => {
    const completed = managedRun("completed");
    const agents = {
      getRun: () => completed,
      finishManagedActionRun: vi.fn(),
    } as unknown as AgentService;
    const runtime = new ControlledActionRuntime(agents, {} as ResourceGateway);
    await expect(runtime.finishRejected(completed.id, "late rejection"))
      .rejects.toMatchObject({ statusCode: 409 });

    completed.kind = "codex";
    completed.status = "awaiting_approval";
    await expect(runtime.finishRejected(completed.id, "wrong kind"))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(agents.finishManagedActionRun).not.toHaveBeenCalled();
  });

  it("routes a managed approval rejection to the terminal Run transition", async () => {
    const finishRejected = vi.fn(async () => managedRun("failed"));
    const rejectPendingRun = vi.fn();
    const service = { rejectPendingRun } as unknown as AgentService;
    const policy = {
      resolveApproval: vi.fn(async () => ({
        approvalRequest: {
          id: "approval:managed",
          decisionId: "decision:managed",
          status: "rejected",
          requestedAt: timestamp,
          expiresAt: "2026-09-01T12:00:00.000Z",
          updatedAt: timestamp,
        },
        event: {
          id: "event:managed-rejected",
          approvalRequestId: "approval:managed",
          eventType: "rejected",
          actorPrincipalId: "human:alice",
          reason: "Change window closed",
          createdAt: timestamp,
        },
      })),
      getDecision: vi.fn(async () => ({
        decision: {
          id: "decision:managed",
          operationId: "managed:123e4567-e89b-42d3-a456-426614174000",
          runId: "123e4567-e89b-42d3-a456-426614174001",
        },
      })),
    } as unknown as PolicyService;
    const principal: AuthenticatedPrincipal = {
      id: "human:alice",
      kind: "human",
      displayName: "Alice",
      role: "admin",
      authenticationSource: "system",
    };
    const securityRuntime = {
      principal,
      security: {
        getPrincipal: vi.fn(async () => principal),
      },
      controlledActions: { finishRejected },
    } as unknown as NonNullable<Parameters<typeof createApp>[8]>;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      policy,
      {} as ResourceGateway,
      undefined,
      undefined,
      securityRuntime,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/policy/approvals/approval:managed/reject",
      payload: { reason: "Change window closed" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(finishRejected).toHaveBeenCalledWith(
      "123e4567-e89b-42d3-a456-426614174001",
      "Change window closed",
    );
    expect(rejectPendingRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("never relabels an executed effect as failed when audit finalization throws", async () => {
    const run = managedRun("running");
    const finishManagedActionRun = vi.fn(async (
      _runId: string,
      outcome: "completed" | "failed" | "awaiting_approval",
      reason: string,
    ) => {
      run.status = outcome;
      run.output = outcome === "completed" ? reason : null;
      run.error = outcome === "failed" ? reason : null;
      run.completedAt = outcome === "awaiting_approval" ? null : timestamp;
      return run;
    });
    const agents = {
      beginManagedActionRequest: () => () => undefined,
      createManagedActionRun: async () => run,
      getRun: () => run,
      finishManagedActionRun,
    } as unknown as AgentService;
    const decision = { id: "decision:effect", runId: run.id } as PolicyDecisionRecord;
    const gateway = {
      request: vi.fn(async () => {
        throw new PostEffectFinalizationError(
          decision,
          { kind: "write", summary: "Changed staging configuration", detail: {} },
          "timeline",
          new Error("timeline unavailable after effect"),
        );
      }),
    } as unknown as ResourceGateway;
    const runtime = new ControlledActionRuntime(agents, gateway);
    const principal: AuthenticatedPrincipal = {
      id: "human:alice",
      kind: "human",
      displayName: "Alice",
      role: "admin",
      authenticationSource: "system",
    };

    await expect(runtime.request({
      agentId: run.agentId,
      principal,
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging",
    })).rejects.toBeInstanceOf(PostEffectFinalizationError);

    expect(run.status).toBe("completed");
    expect(run.error).toBeNull();
    expect(run.output).toMatch(/effect completed.*audit finalization needs attention/i);
    expect(finishManagedActionRun).toHaveBeenCalledTimes(1);
    expect(finishManagedActionRun).not.toHaveBeenCalledWith(
      run.id,
      "failed",
      expect.any(String),
    );
  });
});
