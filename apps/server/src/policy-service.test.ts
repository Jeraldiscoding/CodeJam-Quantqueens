import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { PolicyService } from "./policy-service.js";
import {
  DemoResourceAdapter,
  ResourceGateway,
  type RunAuthority,
} from "./resource-gateway.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import type { GraphEdge, GraphNode } from "./graph-types.js";
import type { Agent, AgentRun } from "./types.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const agentNodeId = `agent:${agentId}`;
const runId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-08-30T10:00:00.000Z";

const databases: MiddlewareDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const node = (
  id: string,
  type: GraphNode["type"],
  label: string,
  riskWeight = 0,
): GraphNode => ({
  id,
  type,
  label,
  riskLevel: riskWeight >= 10 ? "critical" : riskWeight >= 7 ? "high" : "low",
  riskWeight,
  classification: riskWeight >= 10 ? "restricted" : "internal",
  metadata: {},
  createdAt,
  updatedAt: createdAt,
});

const edge = (
  id: string,
  sourceId: string,
  targetId: string,
  relation: GraphEdge["relation"],
): GraphEdge => ({
  id,
  sourceId,
  targetId,
  relation,
  status: "authorized",
  metadata: {},
  createdAt,
});

/**
 * A small topology with three separate exposure levels:
 * - notes:        a harmless asset, score 2
 * - config:       reaches production and the customer dataset, score 21
 * - vault:        a very high weight asset, score 60
 */
async function makeFixture(thresholds = { review: 20, deny: 40, ttl: 900_000 }) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-policy-"));
  temporaryDirectories.push(root);
  const database = new MiddlewareDatabase(path.join(root, "middleware.db"));
  databases.push(database);
  await database.initialize();

  const graphStore = new SqliteGraphStore(database);
  const governance = new SqliteGovernanceStore(database);

  for (const item of [
    node(agentNodeId, "agent", "Release Guardian"),
    node("human:alice", "human", "Alice"),
    node("asset:notes", "asset", "Team notes", 2),
    node("asset:deployment-config", "asset", "Deployment configuration", 4),
    node("asset:production-service", "asset", "Production service", 7),
    node("asset:customer-dataset", "asset", "Customer dataset", 10),
    node("asset:vault", "asset", "Credential vault", 60),
    node("asset:unreachable", "asset", "Unrelated system", 5),
  ]) {
    await graphStore.createNode(item);
  }
  for (const item of [
    edge("edge:owns", "human:alice", agentNodeId, "OWNS"),
    edge("edge:can-read-notes", agentNodeId, "asset:notes", "CAN_READ"),
    edge("edge:can-write-config", agentNodeId, "asset:deployment-config", "CAN_WRITE"),
    edge("edge:can-use-vault", agentNodeId, "asset:vault", "CAN_USE"),
    edge(
      "edge:config-deploys-production",
      "asset:deployment-config",
      "asset:production-service",
      "DEPLOYS_TO",
    ),
    edge(
      "edge:production-processes-customers",
      "asset:production-service",
      "asset:customer-dataset",
      "PROCESSES",
    ),
  ]) {
    await graphStore.createEdge(item);
  }

  const graph = new KnowledgeGraphService(graphStore, thresholds.review);
  const policy = new PolicyService(graph, graphStore, governance, {
    reviewThreshold: thresholds.review,
    denyThreshold: thresholds.deny,
    approvalTtlMs: thresholds.ttl,
  });

  const run: AgentRun = {
    id: runId,
    agentId,
    status: "running",
    prompt: "Ship the release",
    output: null,
    error: null,
    usage: null,
    startedAt: createdAt,
    completedAt: null,
    createdAt,
  };
  const agent: Agent = {
    id: agentId,
    name: "Release Guardian",
    description: "",
    instructions: "",
    status: "busy",
    workspacePath: "/tmp/workspace",
    codexThreadId: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
  const runs: RunAuthority = {
    getRun: () => run,
    getAgent: () => agent,
  };

  const adapter = new DemoResourceAdapter();
  const gateway = new ResourceGateway(policy, graphStore, runs, adapter);
  return { graphStore, governance, graph, policy, gateway, run, agent };
}

describe("Policy evaluation", () => {
  it("allows an action whose blast radius sits under the review threshold", async () => {
    const { policy } = await makeFixture();
    const evaluation = await policy.evaluate({
      operationId: "op:read-notes",
      runId,
      agentId,
      capability: "CAN_READ",
      targetNodeId: "asset:notes",
      actorPrincipalId: "principal:test",
    });
    expect(evaluation.decision.result).toBe("ALLOW");
    expect(evaluation.decision.riskScore).toBe(2);
    expect(evaluation.decision.matchedCapabilityId).toBe("edge:can-read-notes");
  });

  it("requires review when the downstream blast radius exceeds the threshold", async () => {
    const { policy } = await makeFixture();
    const evaluation = await policy.evaluate({
      operationId: "op:write-config",
      runId,
      agentId,
      capability: "CAN_WRITE",
      targetNodeId: "asset:deployment-config",
      actorPrincipalId: "principal:test",
    });
    // 4 (config) + 7 (production) + 10 (customer dataset)
    expect(evaluation.decision.riskScore).toBe(21);
    expect(evaluation.decision.result).toBe("REVIEW_REQUIRED");
    expect(evaluation.approvalRequest?.status).toBe("pending");
  });

  it("denies outright above the deny threshold", async () => {
    const { policy } = await makeFixture();
    const evaluation = await policy.evaluate({
      operationId: "op:use-vault",
      runId,
      agentId,
      capability: "CAN_USE",
      targetNodeId: "asset:vault",
      actorPrincipalId: "principal:test",
    });
    expect(evaluation.decision.result).toBe("DENY");
    expect(evaluation.decision.reasonCode).toBe("RISK_ABOVE_DENY_THRESHOLD");
  });

  it("denies an action with no exact capability, however reachable the asset is", async () => {
    const { policy } = await makeFixture();
    // The Agent can reach production through config, but holds no direct edge.
    const evaluation = await policy.evaluate({
      operationId: "op:write-production",
      runId,
      agentId,
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-service",
      actorPrincipalId: "principal:test",
    });
    expect(evaluation.decision.result).toBe("DENY");
    expect(evaluation.decision.reasonCode).toBe("NO_DIRECT_CAPABILITY");
    expect(evaluation.decision.matchedCapabilityId).toBeUndefined();
  });

  it("records ATTEMPTED and DENIED evidence correlated with the Run", async () => {
    const { policy, graphStore } = await makeFixture();
    await policy.evaluate({
      operationId: "op:denied-write",
      runId,
      agentId,
      capability: "CAN_WRITE",
      targetNodeId: "asset:unreachable",
      actorPrincipalId: "principal:test",
    });
    const edges = await graphStore.getEdgesForRun(runId);
    const relations = edges.map((item) => item.relation).sort();
    expect(relations).toEqual(["ATTEMPTED", "DENIED"]);
    expect(edges.every((item) => item.sourceId === agentNodeId)).toBe(true);
    expect(edges.every((item) => item.targetId === "asset:unreachable")).toBe(true);
  });

  it("does not let audit evidence grant authority or change the score", async () => {
    const { policy, graph } = await makeFixture();
    const before = await graph.calculateBlastRadius(agentId);
    await policy.evaluate({
      operationId: "op:denied-again",
      runId,
      agentId,
      capability: "CAN_WRITE",
      targetNodeId: "asset:unreachable",
      actorPrincipalId: "principal:test",
    });
    const after = await graph.calculateBlastRadius(agentId);
    expect(after.score).toBe(before.score);

    // A denied attempt must not become a usable permission on a later call.
    const retry = await policy.evaluate({
      operationId: "op:denied-retry",
      runId,
      agentId,
      capability: "CAN_WRITE",
      targetNodeId: "asset:unreachable",
      actorPrincipalId: "principal:test",
    });
    expect(retry.decision.result).toBe("DENY");
  });

  it("is idempotent for a repeated operation ID", async () => {
    const { policy } = await makeFixture();
    const request = {
      operationId: "op:repeat",
      runId,
      agentId,
      capability: "CAN_READ" as const,
      targetNodeId: "asset:notes",
      actorPrincipalId: "principal:test",
    };
    const first = await policy.evaluate(request);
    const second = await policy.evaluate(request);
    expect(second.decision.id).toBe(first.decision.id);
  });
});

describe("Resource Gateway", () => {
  it("executes an allowed action and records TOUCHED evidence", async () => {
    const { gateway, graphStore } = await makeFixture();
    const outcome = await gateway.request({
      runId,
      operationId: "op:gateway-read",
      capability: "CAN_READ",
      targetNodeId: "asset:notes",
      actorPrincipalId: "principal:test",
    });
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") throw new Error("unreachable");
    expect(outcome.result.kind).toBe("read");

    const relations = (await graphStore.getEdgesForRun(runId))
      .map((item) => item.relation)
      .sort();
    expect(relations).toEqual(["ATTEMPTED", "TOUCHED"]);
  });

  it("never reaches the adapter for an unauthorized action", async () => {
    const { policy, graphStore } = await makeFixture();
    let executions = 0;
    const gateway = new ResourceGateway(
      policy,
      graphStore,
      {
        getRun: () => ({
          id: runId,
          agentId,
          status: "running",
          prompt: "",
          output: null,
          error: null,
          usage: null,
          startedAt: createdAt,
          completedAt: null,
          createdAt,
        }),
        getAgent: () => ({
          id: agentId,
          name: "Release Guardian",
          description: "",
          instructions: "",
          status: "busy",
          workspacePath: "/tmp/workspace",
          codexThreadId: null,
          lastError: null,
          createdAt,
          updatedAt: createdAt,
        }),
      },
      {
        async execute() {
          executions += 1;
          return { kind: "write", summary: "should not happen", detail: {} };
        },
      },
    );

    const outcome = await gateway.request({
      runId,
      operationId: "op:blocked-write",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-service",
      actorPrincipalId: "principal:test",
    });
    expect(outcome.status).toBe("denied");
    expect(executions).toBe(0);
  });

  it("pauses a high-risk action, then executes it once after approval", async () => {
    const { gateway, policy } = await makeFixture();
    const paused = await gateway.request({
      runId,
      operationId: "op:gateway-write",
      capability: "CAN_WRITE",
      targetNodeId: "asset:deployment-config",
      payload: { field: "replicas" },
      actorPrincipalId: "principal:test",
    });
    expect(paused.status).toBe("approval_required");
    if (paused.status !== "approval_required") throw new Error("unreachable");

    await policy.resolveApproval({
      approvalRequestId: paused.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: "principal:reviewer",
      actorHumanNodeId: "human:alice",
      reason: "Change reviewed",
    });

    const executed = await gateway.resume({
      runId,
      decisionId: paused.decision.id,
      payload: { field: "replicas" },
      actorPrincipalId: "principal:test",
    });
    expect(executed.status).toBe("executed");

    // The approval is single use: a second attempt must fail.
    await expect(
      gateway.resume({
        runId,
        decisionId: paused.decision.id,
        payload: { field: "replicas" },
        actorPrincipalId: "principal:test",
      }),
    ).rejects.toThrow();
  });

  it("refuses to execute an approval bound to a different payload", async () => {
    const { gateway, policy } = await makeFixture();
    const paused = await gateway.request({
      runId,
      operationId: "op:payload-bound",
      capability: "CAN_WRITE",
      targetNodeId: "asset:deployment-config",
      payload: { field: "replicas" },
      actorPrincipalId: "principal:test",
    });
    if (paused.status !== "approval_required") throw new Error("unreachable");
    await policy.resolveApproval({
      approvalRequestId: paused.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: "principal:reviewer",
    });

    await expect(
      gateway.resume({
        runId,
        decisionId: paused.decision.id,
        payload: { field: "delete-everything" },
        actorPrincipalId: "principal:test",
      }),
    ).rejects.toThrow(/no longer matches/);
  });

  it("voids an approval when the Agent graph changes after review", async () => {
    const { gateway, policy, graphStore } = await makeFixture();
    const paused = await gateway.request({
      runId,
      operationId: "op:revision-bound",
      capability: "CAN_WRITE",
      targetNodeId: "asset:deployment-config",
      actorPrincipalId: "principal:test",
    });
    if (paused.status !== "approval_required") throw new Error("unreachable");
    await policy.resolveApproval({
      approvalRequestId: paused.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: "principal:reviewer",
    });

    // Someone widens the Agent's reach after the human said yes.
    await graphStore.createEdge(
      edge("edge:can-read-vault", agentNodeId, "asset:vault", "CAN_READ"),
    );

    await expect(
      gateway.resume({
        runId,
        decisionId: paused.decision.id,
        actorPrincipalId: "principal:test",
      }),
    ).rejects.toThrow(/no longer matches/);
  });

  it("rejects a review so the action can never execute", async () => {
    const { gateway, policy } = await makeFixture();
    const paused = await gateway.request({
      runId,
      operationId: "op:rejected",
      capability: "CAN_WRITE",
      targetNodeId: "asset:deployment-config",
      actorPrincipalId: "principal:test",
    });
    if (paused.status !== "approval_required") throw new Error("unreachable");
    await policy.resolveApproval({
      approvalRequestId: paused.approvalRequest.id,
      resolution: "rejected",
      actorPrincipalId: "principal:reviewer",
      reason: "Too risky before the freeze",
    });

    await expect(
      gateway.resume({
        runId,
        decisionId: paused.decision.id,
        actorPrincipalId: "principal:test",
      }),
    ).rejects.toThrow(/rejected/);
  });

  it("expires a pending review and refuses execution afterwards", async () => {
    const { gateway, policy } = await makeFixture({ review: 20, deny: 40, ttl: 1_000 });
    const paused = await gateway.request({
      runId,
      operationId: "op:expired",
      capability: "CAN_WRITE",
      targetNodeId: "asset:deployment-config",
      actorPrincipalId: "principal:test",
    });
    if (paused.status !== "approval_required") throw new Error("unreachable");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(
      policy.resolveApproval({
        approvalRequestId: paused.approvalRequest.id,
        resolution: "approved",
        actorPrincipalId: "principal:reviewer",
      }),
    ).rejects.toThrow(/expired/);

    await expect(
      gateway.resume({
        runId,
        decisionId: paused.decision.id,
        actorPrincipalId: "principal:test",
      }),
    ).rejects.toThrow();
  });

  it("issues a scoped handle rather than a credential value", async () => {
    const { policy, graphStore, gateway } = await makeFixture({
      review: 100,
      deny: 200,
      ttl: 900_000,
    });
    void policy;
    void graphStore;
    const outcome = await gateway.request({
      runId,
      operationId: "op:credential-handle",
      capability: "CAN_USE",
      targetNodeId: "asset:vault",
      actorPrincipalId: "principal:test",
    });
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") throw new Error("unreachable");
    expect(outcome.result.kind).toBe("credential");
    expect(String(outcome.result.detail.handle)).toMatch(/^handle:/);
    // A handle and its scope, never material the Agent could authenticate with.
    expect(Object.keys(outcome.result.detail).sort()).toEqual([
      "expiresAt",
      "handle",
      "note",
      "scope",
    ]);
  });
});
