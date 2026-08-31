import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./graph-types.js";
import { SqliteManagedResourceAdapter } from "./managed-resource-adapter.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { computeRequestHash, digestOf } from "./policy-hash.js";
import type { CapabilityRelation, PolicyDecisionRecord } from "./policy-store.js";
import type { GrantedAction } from "./resource-gateway.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteSecurityStore } from "./sqlite-security-store.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const agentNodeId = `agent:${agentId}`;
const principal: AuthenticatedPrincipal = {
  id: "human:alice",
  kind: "human",
  displayName: "Alice",
  role: "admin",
  authenticationSource: "system",
};
const createdAt = "2026-08-31T08:00:00.000Z";
const claimedAt = "2026-08-31T08:01:00.000Z";
const recoveredAt = "2026-08-31T08:01:30.000Z";
const executedAt = "2026-08-31T08:02:00.000Z";
const expiresAt = "2030-09-01T08:00:00.000Z";
const rootAgentId = "33333333-3333-4333-8333-333333333333";
const parentAgentId = "22222222-2222-4222-8222-222222222222";
const graphRevision = "graph-revision:managed-adapter-test";

const databases: MiddlewareDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SqliteManagedResourceAdapter claim boundary", () => {
  it("rejects a direct unclaimed write without changing durable state", async () => {
    const f = await fixture();
    const action = await f.prepare({ operationId: "op:unclaimed", claim: false });

    await expect(f.adapter.execute(action)).rejects.toThrow(/no one-time execution claim/i);

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it("cannot reuse a claimed decision for another resource or capability", async () => {
    const targetFixture = await fixture();
    const targetAction = await targetFixture.prepare({ operationId: "op:wrong-target" });
    const otherTarget = await targetFixture.graph.getNode("asset:other-managed");
    if (!otherTarget) throw new Error("other managed target was not provisioned");

    await expect(targetFixture.adapter.execute({
      ...targetAction,
      target: otherTarget,
    })).rejects.toThrow(/does not authorize this exact managed action/i);
    expect(await targetFixture.security.getManagedResourceState(otherTarget.id)).toBeNull();
    expect(await targetFixture.security.getManagedResourceState(targetAction.target.id)).toBeNull();

    const capabilityFixture = await fixture();
    const readAction = await capabilityFixture.prepare({
      operationId: "op:wrong-capability",
      capability: "CAN_READ",
    });
    await expect(capabilityFixture.adapter.execute({
      ...readAction,
      capability: "CAN_WRITE",
    })).rejects.toThrow(/does not authorize this exact managed action/i);
    expect(await capabilityFixture.security.getManagedResourceState(readAction.target.id)).toBeNull();
    expect(receiptCount(capabilityFixture.database)).toBe(0);
  });

  it("rejects a claimed write when the breaker changes before the SQLite effect", async () => {
    const f = await fixture();
    const action = await f.prepare({ operationId: "op:stale-breaker" });
    f.database.connection.prepare(`UPDATE circuit_breakers SET
      state='TRIPPED', version=version + 1,
      reason_code='CONCURRENT_SAFETY_STOP',
      explanation='A concurrent request stopped this Agent.', updated_at=?
      WHERE scope_type='agent' AND scope_id=?`).run(executedAt, agentId);

    await expect(f.adapter.execute(action)).rejects.toThrow(/changed after the action was claimed/i);

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it("rejects a nested claim when an ancestor delegation is revoked before the effect", async () => {
    const f = await fixture();
    const action = await f.prepare({
      operationId: "op:revoked-parent-delegation",
      nestedDelegation: true,
    });
    await f.security.revokeDelegation(
      "delegation:parent:op:revoked-parent-delegation",
      "Parent authority was withdrawn after the claim",
      executedAt,
    );

    await expect(f.adapter.execute(action)).rejects.toThrow(/delegation chain.*no longer active/i);

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it.each([
    { label: "root", sourceAgentId: rootAgentId },
    { label: "intermediate", sourceAgentId: parentAgentId },
  ])("rejects a nested claim when the $label source capability is removed after claim", async ({
    label,
    sourceAgentId,
  }) => {
    const f = await fixture();
    const operationId = `op:${label}-capability-removed-after-claim`;
    const action = await f.prepare({ operationId, nestedDelegation: true });
    f.database.connection.prepare(`DELETE FROM graph_edges
      WHERE source_id=? AND target_id=? AND relation='CAN_WRITE'`)
      .run(`agent:${sourceAgentId}`, action.target.id);

    await expect(f.adapter.execute(action)).rejects.toThrow(
      /Agent capability.*changed after the claim/i,
    );

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it.each([
    { label: "root", targetAgentId: rootAgentId },
    { label: "intermediate", targetAgentId: parentAgentId },
  ])("rejects a nested claim when $label ownership changes after claim", async ({
    label,
    targetAgentId,
  }) => {
    const f = await fixture();
    const operationId = `op:${label}-ownership-changed-after-claim`;
    const action = await f.prepare({ operationId, nestedDelegation: true });
    await f.graph.createEdge({
      id: `edge:bob-owns-${label}-after-claim`,
      sourceId: "human:bob",
      targetId: `agent:${targetAgentId}`,
      relation: "OWNS",
      status: "authorized",
      metadata: {},
      createdAt: executedAt,
    });

    await expect(f.adapter.execute(action)).rejects.toThrow(
      /Agent ownership.*changed after the claim/i,
    );

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it("rejects a claimed write when resource ownership changes before the effect", async () => {
    const f = await fixture();
    const action = await f.prepare({ operationId: "op:ownership-changed" });
    await f.graph.createEdge({
      id: "edge:bob-now-owns-managed",
      sourceId: "human:bob",
      targetId: action.target.id,
      relation: "OWNS",
      status: "authorized",
      metadata: {},
      createdAt: executedAt,
    });

    await expect(f.adapter.execute(action)).rejects.toThrow(/resource ownership.*changed after the claim/i);

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it("requires correlated authorization and risk evidence after a claim", async () => {
    const f = await fixture();
    const action = await f.prepare({ operationId: "op:missing-risk" });
    f.database.connection.prepare("DELETE FROM risk_decisions WHERE policy_decision_id=?")
      .run(action.decision.id);

    await expect(f.adapter.execute(action)).rejects.toThrow(/no correlated executable safety decision/i);

    expect(await f.security.getManagedResourceState(action.target.id)).toBeNull();
    expect(receiptCount(f.database)).toBe(0);
  });

  it("accepts normal, nested, and approved-WARN claims and records each durable effect once", async () => {
    const normal = await fixture();
    const normalAction = await normal.prepare({ operationId: "op:normal-effect" });

    await expect(normal.adapter.execute(normalAction)).resolves.toMatchObject({
      kind: "write",
      detail: { revision: 1 },
    });
    await expect(normal.adapter.execute(normalAction)).resolves.toMatchObject({
      kind: "write",
      detail: { revision: 1 },
    });
    expect(await normal.security.getManagedResourceState(normalAction.target.id)).toMatchObject({
      revision: 1,
      lastOperationId: normalAction.operationId,
    });
    expect(receiptCount(normal.database)).toBe(1);

    const nested = await fixture();
    const nestedAction = await nested.prepare({
      operationId: "op:nested-normal-effect",
      nestedDelegation: true,
    });
    await expect(nested.adapter.execute(nestedAction)).resolves.toMatchObject({
      kind: "write",
      detail: { revision: 1 },
    });
    expect(await nested.security.getManagedResourceState(nestedAction.target.id)).toMatchObject({
      revision: 1,
      lastOperationId: nestedAction.operationId,
    });
    expect(receiptCount(nested.database)).toBe(1);

    const warned = await fixture();
    const warnedAction = await warned.prepare({
      operationId: "op:approved-warn-effect",
      riskResult: "WARN",
    });
    expect(await warned.security.getBreaker(agentId)).toMatchObject({
      state: "NORMAL",
      reasonCode: "WARN_APPROVED",
    });

    await expect(warned.adapter.execute(warnedAction)).resolves.toMatchObject({
      kind: "write",
      detail: { revision: 1 },
    });
    expect(await warned.security.getManagedResourceState(warnedAction.target.id)).toMatchObject({
      revision: 1,
      lastOperationId: warnedAction.operationId,
    });
    expect(receiptCount(warned.database)).toBe(1);
  });

  it("requires an exact claim for reads and returns an idempotent protected snapshot", async () => {
    const f = await fixture();
    const write = await f.prepare({ operationId: "op:seed-read-state" });
    await f.adapter.execute(write);

    const unclaimedRead = await f.prepare({
      operationId: "op:unclaimed-read",
      capability: "CAN_READ",
      claim: false,
    });
    await expect(f.adapter.execute(unclaimedRead)).rejects.toThrow(/no one-time execution claim/i);

    const read = await f.prepare({
      operationId: "op:claimed-read",
      capability: "CAN_READ",
    });
    await expect(f.adapter.execute(read)).resolves.toMatchObject({
      kind: "read",
      detail: { revision: 1 },
    });
    await expect(f.adapter.execute(read)).resolves.toMatchObject({
      kind: "read",
      detail: { revision: 1 },
    });
    expect(receiptCount(f.database)).toBe(2); // one write and one claimed read
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "managed-adapter-boundary-"));
  directories.push(directory);
  const database = new MiddlewareDatabase(path.join(directory, "middleware.db"));
  databases.push(database);
  await database.initialize();
  const graph = new SqliteGraphStore(database);
  const security = new SqliteSecurityStore(database);
  const governance = new SqliteGovernanceStore(database, () => claimedAt);
  await graph.createNode(node(agentNodeId, "agent", "Release Agent"));
  await graph.createNode(node(`agent:${parentAgentId}`, "agent", "Parent Agent"));
  await graph.createNode(node(`agent:${rootAgentId}`, "agent", "Root Agent"));
  await graph.createNode(node("human:alice", "human", "Alice"));
  await graph.createNode(node("human:bob", "human", "Bob"));
  await graph.createNode(node("asset:managed", "asset", "Managed configuration"));
  await graph.createNode(node("asset:other-managed", "asset", "Other managed configuration"));
  await security.upsertPrincipal(principal);
  const adapter = new SqliteManagedResourceAdapter(security);

  return {
    database,
    graph,
    security,
    governance,
    adapter,
    prepare: async (options: {
      operationId: string;
      capability?: "CAN_READ" | "CAN_WRITE";
      targetNodeId?: string;
      payload?: Record<string, unknown>;
      riskResult?: "ALLOW" | "WARN";
      claim?: boolean;
      nestedDelegation?: boolean;
    }): Promise<GrantedAction> => {
      const capability = options.capability ?? "CAN_WRITE";
      const targetNodeId = options.targetNodeId ?? "asset:managed";
      const payload = options.payload ?? { content: options.operationId };
      const riskResult = options.riskResult ?? "ALLOW";
      const decisionId = `decision:${options.operationId}`;
      const runId = `run:${options.operationId}`;
      const authorizationId = `authorization:${options.operationId}`;
      const capabilityEdgeId = `edge:${options.operationId}`;
      await graph.createEdge(capabilityEdge(
        capabilityEdgeId,
        capability,
        targetNodeId,
      ));
      if (options.nestedDelegation) {
        await graph.createEdge(capabilityEdge(
          `edge:delegation-root:${options.operationId}`,
          capability,
          targetNodeId,
          rootAgentId,
        ));
        await graph.createEdge(capabilityEdge(
          `edge:delegation-parent:${options.operationId}`,
          capability,
          targetNodeId,
          parentAgentId,
        ));
      }
      const requestHash = computeRequestHash({
        policyVersion: "managed-adapter-test-v1",
        runId,
        agentNodeId,
        capability,
        targetNodeId,
        graphRevision,
        payloadDigest: digestOf(payload),
      });
      const decision: PolicyDecisionRecord = {
        id: decisionId,
        operationId: options.operationId,
        runId,
        agentNodeId,
        capabilityRelation: capability,
        targetNodeId,
        result: riskResult === "WARN" ? "REVIEW_REQUIRED" : "ALLOW",
        reasonCode: riskResult === "WARN" ? "REVIEW_REQUIRED" : "WITHIN_RISK_THRESHOLD",
        matchedCapabilityId: capabilityEdgeId,
        riskScore: riskResult === "WARN" ? 20 : 0,
        riskThreshold: 20,
        policyVersion: "managed-adapter-test-v1",
        requestHash,
        evidence: {},
        ...(riskResult === "WARN" ? { expiresAt } : {}),
        createdAt,
      };
      const approvalRequestId = `approval:${options.operationId}`;
      await governance.recordEvaluation({
        decision,
        ...(riskResult === "WARN" ? { approvalRequestId } : {}),
      });
      const parentDelegationId = `delegation:parent:${options.operationId}`;
      const leafDelegationId = `delegation:leaf:${options.operationId}`;
      if (options.nestedDelegation) {
        const effectiveScope = [{ capability, targetNodeId }];
        await security.createDelegation({
          id: parentDelegationId,
          runId,
          originPrincipalId: principal.id,
          parentAgentId: rootAgentId,
          childAgentId: parentAgentId,
          depth: 1,
          requestedScope: effectiveScope,
          effectiveScope,
          status: "active",
          expiresAt,
          createdAt,
          reason: "Nested adapter boundary test",
        });
        await security.createDelegation({
          id: leafDelegationId,
          runId,
          originPrincipalId: principal.id,
          parentAgentId,
          childAgentId: agentId,
          parentDelegationId,
          depth: 2,
          requestedScope: effectiveScope,
          effectiveScope,
          status: "active",
          expiresAt,
          createdAt,
          reason: "Nested adapter boundary test",
        });
      }
      await security.recordAuthorization({
        id: authorizationId,
        policyDecisionId: decisionId,
        runId,
        originPrincipalId: principal.id,
        actorAgentId: agentId,
        ...(options.nestedDelegation ? { delegationId: leafDelegationId } : {}),
        role: principal.role,
        capability,
        targetNodeId,
        result: "ALLOW",
        reasonCode: "ROLE_AND_EXACT_CAPABILITY_ALLOW",
        matchedCapabilityId: capabilityEdgeId,
        evidence: options.nestedDelegation
          ? { rootAgentId, delegationDepth: 2 }
          : {},
        createdAt,
      });
      const recorded = await security.recordRiskAndTransition({
        id: `risk:${options.operationId}`,
        policyDecisionId: decisionId,
        authorizationDecisionId: authorizationId,
        runId,
        actorAgentId: agentId,
        targetNodeId,
        result: riskResult,
        reasonCode: riskResult === "WARN" ? "UNUSUAL_ACTION" : "WITHIN_BEHAVIOR_BASELINE",
        score: riskResult === "WARN" ? 20 : 0,
        warnThreshold: 20,
        blockThreshold: 40,
        graphRevision,
        factors: [],
        explanation: riskResult === "WARN" ? "Paused for review." : "Within normal behavior.",
        createdAt,
      }, riskResult === "WARN" ? "WARN" : "NORMAL");

      if (options.claim !== false) {
        let approvalEventId: string | undefined;
        if (riskResult === "WARN") {
          await governance.resolveReview({
            eventId: `approval-event:${options.operationId}`,
            approvalRequestId,
            resolution: "approved",
            actorPrincipalId: principal.id,
            reason: "Approved for the adapter boundary test",
          });
          approvalEventId = `consumption-event:${options.operationId}`;
        }
        await governance.claimForExecution({
          decisionId,
          operationId: options.operationId,
          requestHash,
          actorPrincipalId: principal.id,
          allowedPrincipalRoles: [principal.role],
          breakerGuard: {
            scopeId: agentId,
            expectedState: recorded.risk.breakerState,
            expectedVersion: recorded.risk.breakerVersion,
          },
          ...(approvalEventId ? { approvalEventId } : {}),
        });
        if (riskResult === "WARN") {
          await security.acknowledgeWarn(
            agentId,
            "Approved WARN recovered for one claimed action.",
            recoveredAt,
          );
        }
      }

      const target = await graph.getNode(targetNodeId);
      if (!target) throw new Error(`Managed target ${targetNodeId} was not found`);
      return {
        operationId: options.operationId,
        runId,
        agentId,
        agentNodeId,
        capability,
        target,
        payload,
        decision,
      };
    },
  };
}

function receiptCount(database: MiddlewareDatabase): number {
  return (database.connection.prepare(
    "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
  ).get() as { count: number }).count;
}

function node(
  id: string,
  type: GraphNode["type"],
  label: string,
): GraphNode {
  return {
    id,
    type,
    label,
    riskLevel: "low",
    riskWeight: 0,
    classification: "internal",
    metadata: type === "asset" ? { adapterKind: "managed_state" } : {},
    createdAt,
    updatedAt: createdAt,
  };
}

function capabilityEdge(
  id: string,
  relation: CapabilityRelation,
  targetId: string,
  sourceAgentId = agentId,
): GraphEdge {
  return {
    id,
    sourceId: `agent:${sourceAgentId}`,
    targetId,
    relation,
    status: "authorized",
    metadata: {},
    createdAt,
  };
}
