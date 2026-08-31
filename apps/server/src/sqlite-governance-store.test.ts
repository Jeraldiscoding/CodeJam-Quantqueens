import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MiddlewareDatabase } from "./middleware-database.js";
import type { PolicyDecisionRecord } from "./policy-store.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteSecurityStore } from "./sqlite-security-store.js";
import type { GraphEdge, GraphNode } from "./graph-types.js";

const createdAt = "2026-08-30T10:00:00.000Z";
const expiresAt = "2026-08-30T11:00:00.000Z";
const agentNodeId = "agent:11111111-1111-4111-8111-111111111111";
const targetNodeId = "asset:production-service";
const capabilityId = "edge:agent-can-call-production";
const databases: MiddlewareDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStores(databasePath?: string, initialTime = createdAt) {
  let filePath = databasePath;
  if (!filePath) {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-governance-test-"));
    temporaryDirectories.push(root);
    filePath = path.join(root, "middleware.db");
  }
  const database = new MiddlewareDatabase(filePath);
  databases.push(database);
  await database.initialize();
  let currentTime = initialTime;
  return {
    database,
    graph: new SqliteGraphStore(database),
    governance: new SqliteGovernanceStore(database, () => currentTime),
    setNow(value: string) {
      currentTime = value;
    },
  };
}

async function seedPermission(graph: SqliteGraphStore): Promise<void> {
  const node = (
    id: string,
    type: GraphNode["type"],
    label: string,
  ): GraphNode => ({
    id,
    type,
    label,
    riskLevel: type === "asset" ? "high" : "low",
    riskWeight: type === "asset" ? 7 : 0,
    classification: type === "asset" ? "confidential" : "internal",
    metadata: {},
    createdAt,
    updatedAt: createdAt,
  });
  await graph.createNode(node(agentNodeId, "agent", "Release Guardian"));
  await graph.createNode(node(targetNodeId, "asset", "Production service"));
  await graph.createNode(node("human:alice", "human", "Alice"));
  const capability: GraphEdge = {
    id: capabilityId,
    sourceId: agentNodeId,
    targetId: targetNodeId,
    relation: "CAN_CALL",
    status: "authorized",
    metadata: {},
    createdAt,
  };
  await graph.createEdge(capability);
}

function decision(
  result: PolicyDecisionRecord["result"],
  overrides: Partial<PolicyDecisionRecord> = {},
): PolicyDecisionRecord {
  return {
    id: `decision:${result.toLowerCase()}`,
    operationId: `operation:${result.toLowerCase()}`,
    runId: "run-123",
    agentNodeId,
    capabilityRelation: "CAN_CALL",
    targetNodeId,
    result,
    reasonCode: result === "DENY" ? "DIRECT_PERMISSION_MISSING" : "RISK_THRESHOLD",
    ...(result === "DENY" ? {} : { matchedCapabilityId: capabilityId }),
    riskScore: result === "REVIEW_REQUIRED" ? 21 : 7,
    riskThreshold: 20,
    policyVersion: "demo-v1",
    requestHash: "a".repeat(64),
    evidence: { pathNodeIds: [agentNodeId, targetNodeId] },
    ...(result === "REVIEW_REQUIRED" ? { expiresAt } : {}),
    createdAt,
    ...overrides,
  };
}

describe("SqliteGovernanceStore", () => {
  it("persists a pending review, human resolution, and one-time execution claim", async () => {
    let stores = await createStores();
    await seedPermission(stores.graph);
    const reviewDecision = decision("REVIEW_REQUIRED");

    const recorded = await stores.governance.recordEvaluation({
      decision: reviewDecision,
      approvalRequestId: "approval:release-production",
    });
    expect(recorded.approvalRequest).toMatchObject({
      status: "pending",
      expiresAt,
    });

    const databasePath = stores.database.filePath;
    stores.database.close();
    stores = await createStores(databasePath);
    expect(await stores.governance.getDecision("decision:review_required")).toMatchObject({
      result: "REVIEW_REQUIRED",
      evidence: { pathNodeIds: [agentNodeId, targetNodeId] },
    });
    expect(
      await stores.governance.getApprovalForDecision("decision:review_required"),
    ).toMatchObject({ status: "pending" });

    stores.setNow("2026-08-30T10:15:00.000Z");
    const approval = await stores.governance.resolveReview({
      eventId: "approval-event:approved",
      approvalRequestId: "approval:release-production",
      resolution: "approved",
      actorPrincipalId: "operator:demo",
      actorHumanNodeId: "human:alice",
      reason: "Reviewed the production impact path",
    });
    expect(approval).toMatchObject({ eventType: "approved", actorHumanNodeId: "human:alice" });

    stores.setNow("2026-08-30T10:16:00.000Z");
    await expect(
      stores.governance.claimForExecution({
        decisionId: "decision:review_required",
        operationId: reviewDecision.operationId,
        requestHash: reviewDecision.requestHash,
        approvalEventId: "approval-event:consumed",
        actorPrincipalId: "gateway:protected-action",
      }),
    ).resolves.toEqual({
      decisionId: "decision:review_required",
      claimedAt: "2026-08-30T10:16:00.000Z",
    });
    expect(
      await stores.governance.getApprovalRequest("approval:release-production"),
    ).toMatchObject({ status: "consumed" });
    expect(
      (await stores.governance.getApprovalEvents("approval:release-production")).map(
        (event) => event.eventType,
      ),
    ).toEqual(["approved", "consumed"]);

    stores.setNow("2026-08-30T10:17:00.000Z");
    await expect(
      stores.governance.claimForExecution({
        decisionId: "decision:review_required",
        operationId: reviewDecision.operationId,
        requestHash: reviewDecision.requestHash,
        approvalEventId: "approval-event:replayed",
        actorPrincipalId: "gateway:protected-action",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("keeps operations idempotent and rejects an idempotency key reused for another action", async () => {
    const stores = await createStores();
    const { graph, governance } = stores;
    await seedPermission(graph);
    const original = decision("ALLOW");

    await expect(governance.recordEvaluation({ decision: original })).resolves.toMatchObject({
      decision: { id: original.id },
    });
    await expect(
      governance.recordEvaluation({
        decision: { ...original, id: "decision:retry" },
      }),
    ).resolves.toMatchObject({ decision: { id: original.id } });
    await expect(
      governance.recordEvaluation({
        decision: { ...original, id: "decision:wrong", runId: "run-other" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    stores.setNow("2026-08-30T09:59:00.000Z");
    await expect(
      governance.claimForExecution({
        decisionId: original.id,
        operationId: original.operationId,
        requestHash: original.requestHash,
        actorPrincipalId: "gateway:protected-action",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    stores.setNow("2026-08-30T10:01:00.000Z");
    await expect(
      governance.claimForExecution({
        decisionId: original.id,
        operationId: original.operationId,
        requestHash: "b".repeat(64),
        actorPrincipalId: "gateway:protected-action",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      governance.claimForExecution({
        decisionId: original.id,
        operationId: original.operationId,
        requestHash: original.requestHash,
        actorPrincipalId: "gateway:protected-action",
      }),
    ).resolves.toMatchObject({ decisionId: original.id });
    stores.setNow("2026-08-30T10:02:00.000Z");
    await expect(
      governance.claimForExecution({
        decisionId: original.id,
        operationId: original.operationId,
        requestHash: original.requestHash,
        actorPrincipalId: "gateway:protected-action",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("checks the authoritative principal role inside the one-time claim transaction", async () => {
    const stores = await createStores();
    await seedPermission(stores.graph);
    const security = new SqliteSecurityStore(stores.database);
    const allowed = decision("ALLOW", { id: "decision:atomic-role", operationId: "operation:atomic-role" });
    await stores.governance.recordEvaluation({ decision: allowed });

    await security.upsertPrincipal({
      id: "human:alice",
      kind: "human",
      displayName: "Alice",
      role: "viewer",
      authenticationSource: "bearer_token",
    });
    stores.setNow("2026-08-30T10:01:00.000Z");
    await expect(stores.governance.claimForExecution({
      decisionId: allowed.id,
      operationId: allowed.operationId,
      requestHash: allowed.requestHash,
      actorPrincipalId: "human:alice",
      allowedPrincipalRoles: ["operator", "admin"],
    })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      message: expect.stringMatching(/authoritative principal role/i),
    });
    expect(await stores.governance.getActionClaim(allowed.id)).toBeNull();

    await security.upsertPrincipal({
      id: "human:alice",
      kind: "human",
      displayName: "Alice",
      role: "operator",
      authenticationSource: "bearer_token",
    });
    await expect(stores.governance.claimForExecution({
      decisionId: allowed.id,
      operationId: allowed.operationId,
      requestHash: allowed.requestHash,
      actorPrincipalId: "human:alice",
      allowedPrincipalRoles: ["operator", "admin"],
    })).resolves.toMatchObject({ decisionId: allowed.id });
  });

  it("atomically refuses a claim when the Agent safety state changed after evaluation", async () => {
    const first = await createStores();
    await seedPermission(first.graph);
    const allowed = decision("ALLOW", {
      id: "decision:atomic-breaker",
      operationId: "operation:atomic-breaker",
    });
    await first.governance.recordEvaluation({ decision: allowed });

    const second = await createStores(first.database.filePath);
    second.database.connection.prepare(`INSERT INTO circuit_breakers (
      scope_type, scope_id, state, version, reason_code, explanation,
      evidence_json, updated_at
    ) VALUES ('agent', ?, 'TRIPPED', 1, 'CONCURRENT_RISK',
      'Another action tripped the safety stop.', '{}', ?)`)
      .run("11111111-1111-4111-8111-111111111111", "2026-08-30T10:00:30.000Z");

    first.setNow("2026-08-30T10:01:00.000Z");
    await expect(first.governance.claimForExecution({
      decisionId: allowed.id,
      operationId: allowed.operationId,
      requestHash: allowed.requestHash,
      actorPrincipalId: "gateway:protected-action",
      breakerGuard: {
        scopeId: "11111111-1111-4111-8111-111111111111",
        expectedState: "NORMAL",
        expectedVersion: 0,
      },
    })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      message: expect.stringMatching(/changed after policy evaluation/i),
    });
    expect(await first.governance.getActionClaim(allowed.id)).toBeNull();

    await expect(first.governance.claimForExecution({
      decisionId: allowed.id,
      operationId: allowed.operationId,
      requestHash: allowed.requestHash,
      actorPrincipalId: "gateway:protected-action",
      breakerGuard: {
        scopeId: "11111111-1111-4111-8111-111111111111",
        expectedState: "TRIPPED",
        expectedVersion: 1,
      },
    })).resolves.toMatchObject({ decisionId: allowed.id });
  });

  it("never allows denied, rejected, or expired decisions to be claimed", async () => {
    const stores = await createStores();
    const { graph, governance } = stores;
    await seedPermission(graph);

    const denied = decision("DENY");
    await governance.recordEvaluation({ decision: denied });
    stores.setNow("2026-08-30T10:01:00.000Z");
    await expect(
      governance.claimForExecution({
        decisionId: denied.id,
        operationId: denied.operationId,
        requestHash: denied.requestHash,
        actorPrincipalId: "gateway:protected-action",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    const review = decision("REVIEW_REQUIRED");
    await governance.recordEvaluation({
      decision: review,
      approvalRequestId: "approval:rejected",
    });
    stores.setNow("2026-08-30T10:30:00.000Z");
    await governance.resolveReview({
      eventId: "approval-event:rejected",
      approvalRequestId: "approval:rejected",
      resolution: "rejected",
      actorPrincipalId: "operator:demo",
      reason: "Risk is too high",
    });
    stores.setNow("2026-08-30T10:31:00.000Z");
    await expect(
      governance.claimForExecution({
        decisionId: review.id,
        operationId: review.operationId,
        requestHash: review.requestHash,
        actorPrincipalId: "gateway:protected-action",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("expires a pending review instead of accepting a late approval", async () => {
    const stores = await createStores();
    const { graph, governance } = stores;
    await seedPermission(graph);
    const review = decision("REVIEW_REQUIRED");
    await governance.recordEvaluation({
      decision: review,
      approvalRequestId: "approval:expiring",
    });

    stores.setNow("2026-08-30T09:59:00.000Z");
    await expect(
      governance.resolveReview({
        eventId: "approval-event:backdated",
        approvalRequestId: "approval:expiring",
        resolution: "rejected",
        actorPrincipalId: "operator:demo",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    stores.setNow(expiresAt);
    await expect(
      governance.resolveReview({
        eventId: "approval-event:too-late",
        approvalRequestId: "approval:expiring",
        resolution: "approved",
        actorPrincipalId: "operator:demo",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(
      governance.resolveReview({
        eventId: "approval-event:expired",
        approvalRequestId: "approval:expiring",
        resolution: "expired",
        actorPrincipalId: "system:approval-expirer",
      }),
    ).resolves.toMatchObject({ eventType: "expired" });
    await expect(
      governance.getApprovalRequest("approval:expiring"),
    ).resolves.toMatchObject({ status: "expired" });
  });

  it("keeps review resolution and execution claims single-winner across connections", async () => {
    const first = await createStores();
    await seedPermission(first.graph);
    const review = decision("REVIEW_REQUIRED");
    await first.governance.recordEvaluation({
      decision: review,
      approvalRequestId: "approval:contended",
    });

    const second = await createStores(first.database.filePath);
    first.setNow("2026-08-30T10:15:00.000Z");
    second.setNow("2026-08-30T10:15:00.000Z");
    const resolutions = await Promise.allSettled([
      first.governance.resolveReview({
        eventId: "approval-event:first-resolution",
        approvalRequestId: "approval:contended",
        resolution: "approved",
        actorPrincipalId: "operator:first",
      }),
      second.governance.resolveReview({
        eventId: "approval-event:second-resolution",
        approvalRequestId: "approval:contended",
        resolution: "rejected",
        actorPrincipalId: "operator:second",
      }),
    ]);
    expect(resolutions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(resolutions.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(
      second.governance.getApprovalRequest("approval:contended"),
    ).resolves.toMatchObject({ status: "approved" });

    first.setNow("2026-08-30T10:16:00.000Z");
    second.setNow("2026-08-30T10:16:00.000Z");
    const claims = await Promise.allSettled([
      first.governance.claimForExecution({
        decisionId: review.id,
        operationId: review.operationId,
        requestHash: review.requestHash,
        approvalEventId: "approval-event:first-claim",
        actorPrincipalId: "gateway:first",
      }),
      second.governance.claimForExecution({
        decisionId: review.id,
        operationId: review.operationId,
        requestHash: review.requestHash,
        approvalEventId: "approval-event:second-claim",
        actorPrincipalId: "gateway:second",
      }),
    ]);
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(claims.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(second.governance.getActionClaim(review.id)).resolves.toEqual({
      decisionId: review.id,
      claimedAt: "2026-08-30T10:16:00.000Z",
    });
    await expect(
      second.governance.getApprovalEvents("approval:contended"),
    ).resolves.toHaveLength(2);
  });

  it("rolls back a decision when its approval request cannot be inserted", async () => {
    const { graph, governance } = await createStores();
    await seedPermission(graph);
    await governance.recordEvaluation({
      decision: decision("REVIEW_REQUIRED"),
      approvalRequestId: "approval:duplicate",
    });

    const second = decision("REVIEW_REQUIRED", {
      id: "decision:second-review",
      operationId: "operation:second-review",
      requestHash: "b".repeat(64),
    });
    await expect(
      governance.recordEvaluation({
        decision: second,
        approvalRequestId: "approval:duplicate",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(governance.getDecision(second.id)).resolves.toBeNull();
  });

  it("rejects nested secret material in durable policy evidence", async () => {
    const { graph, governance } = await createStores();
    await seedPermission(graph);

    await expect(
      governance.recordEvaluation({
        decision: decision("ALLOW", {
          evidence: { request: { apiKey: "must-not-be-persisted" } },
        }),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(governance.getDecision("decision:allow")).resolves.toBeNull();
  });
});
