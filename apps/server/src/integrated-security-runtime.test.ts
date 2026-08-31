import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BehavioralBaselineService, BehavioralRiskService } from "./behavioral-security.js";
import { ControlledActionRuntime } from "./controlled-action-runtime.js";
import { DelegationService } from "./delegation-service.js";
import { ExecutionIdentityService } from "./execution-identity.js";
import type { GraphEdge, GraphNode } from "./graph-types.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { SqliteManagedResourceAdapter } from "./managed-resource-adapter.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { PolicyService } from "./policy-service.js";
import type { ClaimPolicyActionInput, GovernanceStore } from "./policy-store.js";
import { PostEffectFinalizationError, ResourceGateway } from "./resource-gateway.js";
import type { AppendRunEvent, RunTimeline } from "./run-timeline.js";
import type { AuthenticatedPrincipal, DelegationRecord, ExecutionIdentity } from "./security-types.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteRunTimelineStore } from "./sqlite-run-timeline-store.js";
import { SqliteSecurityStore } from "./sqlite-security-store.js";
import { SafetyEvidenceService } from "./safety-evidence.js";
import type { Agent, AgentRun } from "./types.js";
import type { AgentService } from "./agent-service.js";

const rootAgentId = "11111111-1111-4111-8111-111111111111";
const childAgentId = "22222222-2222-4222-8222-222222222222";
const intermediateAgentId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-08-31T08:00:00.000Z";
const principal: AuthenticatedPrincipal = {
  id: "human:alice",
  kind: "human",
  displayName: "Alice",
  role: "admin",
  authenticationSource: "bearer_token",
};
const databases: MiddlewareDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class Directory {
  readonly runs: AgentRun[] = [];
  readonly agents = new Map<string, Agent>();
  getRun(id: string) { const run = this.runs.find((item) => item.id === id); if (!run) throw new Error("Run not found"); return run; }
  getRuns(agentId: string) { return this.runs.filter((run) => run.agentId === agentId); }
  getAgent(id: string) { const agent = this.agents.get(id); if (!agent) throw new Error("Agent not found"); return agent; }
  beginProtectedAction(runId: string) { this.assertProtectedActionMayExecute(runId); return () => undefined; }
  beginAgentProtectedAction(agentId: string) { this.assertAgentProtectedActionMayExecute(agentId); return () => undefined; }
  assertProtectedActionMayExecute(runId: string) {
    const run = this.getRun(runId);
    if (run.status !== "queued" && run.status !== "running" && run.status !== "awaiting_approval") {
      throw new Error(`Run ${run.id} is not active`);
    }
    this.assertAgentProtectedActionMayExecute(run.agentId);
  }
  assertAgentProtectedActionMayExecute(agentId: string) {
    if (this.getAgent(agentId).status === "stopped") {
      throw new Error(`Agent ${agentId} is stopped and is not eligible to act`);
    }
  }
}

async function fixture(options: {
  minimumHistory?: number;
  historyWindowRunLimit?: number;
  timeline?: RunTimeline;
  beforeClaim?: (
    database: MiddlewareDatabase,
    input: ClaimPolicyActionInput,
  ) => void | Promise<void>;
} = {}) {
  const directoryPath = await mkdtemp(path.join(tmpdir(), "integrated-security-"));
  directories.push(directoryPath);
  const database = new MiddlewareDatabase(path.join(directoryPath, "middleware.db"));
  databases.push(database);
  await database.initialize();
  const graphStore = new SqliteGraphStore(database);
  const security = new SqliteSecurityStore(database);
  const timeline = options.timeline ?? new SqliteRunTimelineStore(database);
  const runs = new Directory();
  for (const id of [rootAgentId, childAgentId]) {
    runs.agents.set(id, agent(id));
    await graphStore.createNode(node(`agent:${id}`, "agent", id === rootAgentId ? "Release Agent" : "Analyst Agent"));
  }
  for (const item of [
    node("human:alice", "human", "Alice"),
    node("human:bob", "human", "Bob"),
    node("asset:bob-private", "asset", "Bob private records", 0, "internal", { kind: "mock_user_data", adapterKind: "managed_state" }),
    node("asset:staging-config", "asset", "Staging configuration", 1, "internal", { kind: "configuration", adapterKind: "managed_state" }),
    node("asset:production-config", "asset", "Shared production configuration", 5, "internal", { kind: "configuration", adapterKind: "managed_state" }),
    node("asset:service-a", "asset", "Payments service", 3),
    node("asset:service-b", "asset", "Orders service", 3),
    node("asset:service-c", "asset", "Identity service", 10, "restricted"),
  ]) await graphStore.createNode(item);
  for (const item of [
    edge("edge:owns", "human:alice", `agent:${rootAgentId}`, "OWNS"),
    edge("edge:bob-owns-private", "human:bob", "asset:bob-private", "OWNS"),
    edge("edge:root-read-bob-private", `agent:${rootAgentId}`, "asset:bob-private", "CAN_READ"),
    edge("edge:root-staging", `agent:${rootAgentId}`, "asset:staging-config", "CAN_WRITE"),
    edge("edge:root-production", `agent:${rootAgentId}`, "asset:production-config", "CAN_WRITE"),
    edge("edge:child-staging", `agent:${childAgentId}`, "asset:staging-config", "CAN_WRITE"),
    edge("edge:child-production", `agent:${childAgentId}`, "asset:production-config", "CAN_WRITE"),
    edge("edge:prod-a", "asset:production-config", "asset:service-a", "DEPLOYS_TO"),
    edge("edge:prod-b", "asset:production-config", "asset:service-b", "DEPLOYS_TO"),
    edge("edge:prod-c", "asset:production-config", "asset:service-c", "DEPLOYS_TO"),
  ]) await graphStore.createEdge(item);
  await security.upsertPrincipal(principal);
  const graph = new KnowledgeGraphService(graphStore);
  const identities = new ExecutionIdentityService(runs, security, timeline);
  const baselines = new BehavioralBaselineService(
    security,
    timeline,
    runs,
    options.minimumHistory ?? 3,
    options.historyWindowRunLimit ?? 20,
  );
  const risk = new BehavioralRiskService(security, baselines, 20, 40);
  const baseGovernance = new SqliteGovernanceStore(database);
  const governance: GovernanceStore = options.beforeClaim
    ? new Proxy(baseGovernance, {
        get(target, property) {
          if (property === "claimForExecution") {
            return async (input: ClaimPolicyActionInput) => {
              await options.beforeClaim!(database, input);
              return target.claimForExecution(input);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as GovernanceStore
    : baseGovernance;
  const policy = new PolicyService(graph, graphStore, governance, {
    reviewThreshold: 20,
    denyThreshold: 40,
    approvalTtlMs: 900_000,
  }, { security, risk, timeline });
  const adapter = new SqliteManagedResourceAdapter(security);
  const gateway = new ResourceGateway(policy, graphStore, runs, adapter, identities, timeline);
  return { database, graphStore, governance, security, timeline, runs, graph, identities, baselines, risk, policy, adapter, gateway };
}

describe("integrated graph security runtime", () => {
  it("lets RBAC allow while history and target-inclusive blast radius block before the durable effect", async () => {
    const f = await fixture();
    await establishTrustedHistory(f, 3);
    const run = await addRun(f, "run:danger", "running", "managed_action");
    const outcome = await f.gateway.request({
      runId: run.id,
      operationId: "op:dangerous-write",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "unsafe" },
      principal,
    });
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denial");
    expect(outcome.authorization?.result).toBe("ALLOW");
    expect(outcome.risk?.result).toBe("BLOCK");
    expect(outcome.risk?.factors.map((factor) => factor.code)).toEqual(expect.arrayContaining([
      "NOVEL_RESOURCE", "BLAST_RADIUS_EXPANSION", "SENSITIVE_DOWNSTREAM",
    ]));
    expect(outcome.risk?.explanation).toMatch(/blocked before anything changed/i);
    expect(f.adapter.invocationCount).toBe(3); // only the three trusted staging writes
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("TRIPPED");

    const events = await f.timeline.list(run.id);
    expect(events.map((event) => event.type)).toEqual([
      "RUN_CREATED", "ACTION_REQUESTED", "RESOURCE_ACCESS_ATTEMPTED",
      "AUTHORIZATION_DECIDED", "RISK_DECIDED", "CIRCUIT_BREAKER_TRANSITIONED",
      "ACTION_BLOCKED",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const riskEvent = events.find((event) => event.type === "RISK_DECIDED");
    expect(riskEvent?.metadata).toMatchObject({
      score: 65,
      warnThreshold: 20,
      blockThreshold: 40,
      breakerState: "TRIPPED",
      breakerVersion: 4,
      baselineRevision: 4,
      historyWindow: {
        runLimit: 20,
        inspectedRunCount: 3,
        eligibleRunCount: 3,
        sourceRunCount: 3,
        sourceRunIds: ["run:trusted:1", "run:trusted:2", "run:trusted:3"],
        sourceRunIdsTruncated: false,
        minimumHistory: 3,
      },
    });
    const transition = events.find((event) => event.type === "CIRCUIT_BREAKER_TRANSITIONED");
    expect(transition?.metadata).toMatchObject({
      previousState: "NORMAL",
      previousVersion: 3,
      breakerState: "TRIPPED",
      breakerVersion: 4,
      warnThreshold: 20,
      blockThreshold: 40,
      historyWindow: { sourceRunCount: 3 },
    });
  });

  it("keeps trusted learning inside a deterministic bounded Run window", async () => {
    const f = await fixture({ minimumHistory: 2, historyWindowRunLimit: 3 });
    await establishTrustedHistory(f, 5);
    const failed = await addRun(f, "run:failed:not-trusted", "failed", "managed_action");
    await f.timeline.append(terminalEvent(failed.id, "RUN_FAILED"));

    const first = await f.baselines.rebuild(rootAgentId);
    const repeated = await f.baselines.rebuild(rootAgentId);
    expect(first).toMatchObject({
      revision: repeated.revision,
      historyWindowRunLimit: 3,
      historyWindowRunCount: 3,
      eligibleRunCount: 3,
      sourceRunIds: ["run:trusted:3", "run:trusted:4", "run:trusted:5"],
      historyWindowStartAt: timestamp,
      historyWindowEndAt: timestamp,
    });
    expect(first.sourceRunIds).not.toContain(failed.id);

    const danger = await addRun(f, "run:bounded-history-decision", "running", "managed_action");
    await f.gateway.request({
      runId: danger.id,
      operationId: "op:bounded-history-decision",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      principal,
    });
    const riskEvent = (await f.timeline.list(danger.id)).find(
      (event) => event.type === "RISK_DECIDED",
    );
    expect(riskEvent?.metadata.historyWindow).toMatchObject({
      runLimit: 3,
      inspectedRunCount: 3,
      sourceRunIds: ["run:trusted:3", "run:trusted:4", "run:trusted:5"],
      sourceRunIdsTruncated: false,
    });

    const filePath = f.database.filePath;
    f.database.close();
    const reopened = new MiddlewareDatabase(filePath);
    databases.push(reopened);
    await reopened.initialize();
    expect(await new SqliteSecurityStore(reopened).getBaseline(first.id)).toMatchObject({
      revision: first.revision,
      historyWindowRunLimit: 3,
      historyWindowRunCount: 3,
      sourceRunIds: ["run:trusted:3", "run:trusted:4", "run:trusted:5"],
    });
    expect((await new SqliteRunTimelineStore(reopened).list(danger.id)).find(
      (event) => event.type === "RISK_DECIDED",
    )?.metadata.historyWindow).toMatchObject({
      runLimit: 3,
      sourceRunIds: ["run:trusted:3", "run:trusted:4", "run:trusted:5"],
    });
  });

  it("pauses a fresh permitted write when its backend impact path reaches a restricted dependency", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:cold-sensitive-downstream", "running", "managed_action");

    const outcome = await f.gateway.request({
      runId: run.id,
      operationId: "op:cold-sensitive-downstream",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "must wait for review" },
      principal,
    });

    expect(outcome.status).toBe("approval_required");
    if (outcome.status !== "approval_required") throw new Error("expected approval request");
    expect(outcome.authorization?.result).toBe("ALLOW");
    expect(outcome.risk).toMatchObject({ result: "WARN", score: 20, breakerState: "WARN" });
    const downstreamFactor = outcome.risk?.factors.find(
      (factor) => factor.code === "SENSITIVE_DOWNSTREAM",
    );
    expect(downstreamFactor).toMatchObject({
      observed: 1,
      path: ["asset:production-config", "asset:service-c"],
    });
    expect(downstreamFactor?.explanation).toMatch(/Identity service.*Shared production configuration → Identity service/i);
    expect(outcome.risk?.explanation).toMatch(/Paused for review/i);
    expect(outcome.risk?.explanation).toMatch(/Potentially affected: .*Identity service/i);
    const affectedList = outcome.risk?.explanation.split("Potentially affected:")[1] ?? "";
    expect(affectedList).not.toContain("Shared production configuration");
    expect(outcome.decision.evidence).toMatchObject({
      blastRadius: 4,
      sensitiveTargetIds: ["asset:service-c"],
      impactTargets: [
        expect.objectContaining({
          id: "asset:production-config",
          path: ["asset:production-config"],
        }),
        expect.objectContaining({ id: "asset:service-a" }),
        expect.objectContaining({ id: "asset:service-b" }),
        expect.objectContaining({
          id: "asset:service-c",
          path: ["asset:production-config", "asset:service-c"],
        }),
      ],
    });

    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect((await f.policy.getDecision(outcome.decision.id)).claimed).toBe(false);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("WARN");
    expect((await f.timeline.list(run.id)).map((event) => event.type)).toEqual([
      "RUN_CREATED", "ACTION_REQUESTED", "RESOURCE_ACCESS_ATTEMPTED",
      "AUTHORIZATION_DECIDED", "RISK_DECIDED", "CIRCUIT_BREAKER_TRANSITIONED",
      "ACTION_WARNED", "APPROVAL_PAUSED",
    ]);
  });

  it("denies an exact Agent capability when the resource belongs to another principal", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:owned-resource", "running", "managed_action");

    const outcome = await f.gateway.request({
      runId: run.id,
      operationId: "op:owned-resource",
      capability: "CAN_READ",
      targetNodeId: "asset:bob-private",
      principal,
    });

    expect(outcome.status).toBe("denied");
    expect(outcome.authorization).toMatchObject({
      result: "DENY",
      reasonCode: "RESOURCE_OWNED_BY_ANOTHER_PRINCIPAL",
      matchedCapabilityId: "edge:root-read-bob-private",
      evidence: {
        directCapability: "edge:root-read-bob-private",
        resourceOwnerIds: ["human:bob"],
        resourceOwnershipAllowed: false,
      },
    });
    expect(outcome.risk).toBeUndefined();
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:bob-private")).toBeNull();
    expect((await f.policy.getDecision(outcome.decision.id)).claimed).toBe(false);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("NORMAL");
    expect((await f.timeline.list(run.id)).map((event) => event.type)).toEqual([
      "RUN_CREATED", "ACTION_REQUESTED", "RESOURCE_ACCESS_ATTEMPTED",
      "AUTHORIZATION_DECIDED", "ACTION_BLOCKED",
    ]);
  });

  it("invalidates a pending approval when resource ownership changes", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:ownership-revision", "running", "managed_action");
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: "op:ownership-revision",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "reviewed before ownership changed" },
      principal,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    await f.graphStore.createEdge(edge(
      "edge:bob-owns-production",
      "human:bob",
      "asset:production-config",
      "OWNS",
    ));

    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "reviewed before ownership changed" },
      principal,
    })).rejects.toThrow(/no longer matches the Agent graph/i);

    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("WARN");
  });

  it("learns only trusted completed actions and repeated blocked attempts do not poison normal scope", async () => {
    const f = await fixture();
    await establishTrustedHistory(f, 3);
    const before = await f.baselines.rebuild(rootAgentId);
    expect(before.normalScope).toEqual([{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }]);
    const blocked = await addRun(f, "run:blocked-history", "running", "managed_action");
    const outcome = await f.gateway.request({ runId: blocked.id, operationId: "op:poison-attempt", capability: "CAN_WRITE", targetNodeId: "asset:production-config", principal });
    expect(outcome.status).toBe("denied");
    blocked.status = "failed";
    await f.timeline.append({ ...terminalEvent(blocked.id, "RUN_FAILED"), outcome: "failed" });
    const after = await f.baselines.rebuild(rootAgentId);
    expect(after.normalScope).toEqual(before.normalScope);
    expect(after.sourceRunIds).toEqual(before.sourceRunIds);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
  });

  it("executes a normal managed effect exactly once and learns its real blast radius", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:normal", "running", "managed_action");
    const allowed = await f.gateway.request({ runId: run.id, operationId: "op:normal-write", capability: "CAN_WRITE", targetNodeId: "asset:staging-config", payload: { content: "safe" }, principal });
    expect(allowed.status).toBe("executed");
    expect(f.adapter.invocationCount).toBe(1);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toMatchObject({ revision: 1, lastOperationId: "op:normal-write" });
    run.status = "completed";
    await f.timeline.append(terminalEvent(run.id));
    const baseline = await f.baselines.rebuild(rootAgentId);
    expect(baseline.typicalBlastRadius).toBe(1);
    expect(baseline.maximumBlastRadius).toBe(1);
  });

  it("consumes a managed policy decision once without duplicating the durable effect", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:one-time-claim", "running", "managed_action");
    const request = {
      runId: run.id,
      operationId: "op:one-time-claim",
      capability: "CAN_WRITE" as const,
      targetNodeId: "asset:staging-config",
      payload: { content: "safe" },
      principal,
    };

    await expect(f.gateway.request(request)).resolves.toMatchObject({ status: "executed" });
    await expect(f.gateway.request(request)).rejects.toThrow(/already been claimed/i);

    expect(f.adapter.invocationCount).toBe(1);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toMatchObject({
      revision: 1,
      lastOperationId: "op:one-time-claim",
    });
  });

  it("keeps WARN pending so another low-risk request cannot bypass review", async () => {
    const f = await fixture({ minimumHistory: 3 });
    const first = await addRun(f, "run:warn", "running", "managed_action");
    const warned = await f.gateway.request({ runId: first.id, operationId: "op:warn", capability: "CAN_WRITE", targetNodeId: "asset:production-config", principal });
    expect(warned.status).toBe("approval_required");
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("WARN");
    const second = await addRun(f, "run:bypass", "running", "managed_action");
    const bypass = await f.gateway.request({ runId: second.id, operationId: "op:bypass", capability: "CAN_WRITE", targetNodeId: "asset:staging-config", principal });
    expect(bypass.status).toBe("approval_required");
    if (bypass.status !== "approval_required") throw new Error("expected review");
    expect(bypass.risk?.factors.some((factor) => factor.code === "BREAKER_WARN_PENDING")).toBe(true);
    expect(f.adapter.invocationCount).toBe(0);
  });

  it("persists pause, approval, breaker recovery, and completion in exact WARN order", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:warn-resume", "running", "managed_action");
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: "op:warn-resume",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "reviewed-change" },
      principal,
    });
    expect(warned.status).toBe("approval_required");
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect((await f.timeline.list(run.id)).at(-1)?.type).toBe("APPROVAL_PAUSED");

    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
      reason: "Reviewed for the ordered approval test",
    });
    const resumed = await f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "reviewed-change" },
      principal,
    });
    expect(resumed.status).toBe("executed");
    expect(f.adapter.invocationCount).toBe(1);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("NORMAL");
    expect((await f.timeline.list(run.id)).map((item) => item.type)).toEqual([
      "RUN_CREATED", "ACTION_REQUESTED", "RESOURCE_ACCESS_ATTEMPTED",
      "AUTHORIZATION_DECIDED", "RISK_DECIDED", "CIRCUIT_BREAKER_TRANSITIONED",
      "ACTION_WARNED", "APPROVAL_PAUSED", "APPROVAL_RESOLVED",
      "CIRCUIT_BREAKER_TRANSITIONED", "ACTION_COMPLETED",
    ]);
  });

  it("does not consume an approved WARN or clear its breaker when recovery event persistence fails", async () => {
    let backing!: SqliteRunTimelineStore;
    const failing: RunTimeline = {
      list: (runId) => backing.list(runId),
      append: async (input) => {
        if (
          input.type === "CIRCUIT_BREAKER_TRANSITIONED" &&
          input.decision?.result === "NORMAL"
        ) throw new Error("breaker recovery timeline failed");
        return backing.append(input);
      },
    };
    const f = await fixture({ timeline: failing });
    backing = new SqliteRunTimelineStore(f.database);
    const run = await addRun(f, "run:warn-recovery-failure", "running", "managed_action");
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: "op:warn-recovery-failure",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "must-wait" },
      principal,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "must-wait" },
      principal,
    })).rejects.toThrow(/breaker recovery timeline failed/i);
    expect(f.adapter.invocationCount).toBe(0);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("WARN");
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
    expect((await f.policy.getDecision(warned.decision.id)).approvalRequest?.status).toBe("approved");
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
  });

  it("rejects a forged origin and rolls back delegation privilege when its event cannot persist", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:identity", "running", "managed_action");
    const forged = { ...principal, id: "human:mallory", displayName: "Mallory" };
    await f.security.upsertPrincipal(forged);
    await expect(f.identities.resolve({ runId: run.id, principal: forged })).rejects.toThrow(/different authenticated person/i);

    const identity = await f.identities.resolve({ runId: run.id, principal });
    const failingTimeline: RunTimeline = {
      list: (id) => f.timeline.list(id),
      append: async (input) => {
        if (input.type === "AGENT_DELEGATED") throw new Error("timeline unavailable");
        return f.timeline.append(input);
      },
    };
    const delegations = new DelegationService(f.security, f.graph, failingTimeline);
    await expect(delegations.delegate({
      identity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    })).rejects.toThrow(/timeline unavailable/);
    const records = await f.security.listDelegationsForRun(run.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("revoked");
  });

  it("does not let a protected action inherit identity from a legacy Run with no origin", async () => {
    const f = await fixture();
    const legacyRun: AgentRun = {
      id: "run:legacy-no-origin",
      agentId: rootAgentId,
      status: "running",
      prompt: "legacy",
      output: null,
      error: null,
      usage: null,
      startedAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
    };
    f.runs.runs.push(legacyRun);
    await f.timeline.append({
      runId: legacyRun.id,
      type: "RUN_CREATED",
      actor: { principalId: `agent:${rootAgentId}`, kind: "agent", agentId: rootAgentId },
      agentId: rootAgentId,
      outcome: "pending",
      reasonCode: "LEGACY_RUN",
      reason: "Legacy Run without server-attested human origin",
    });
    await expect(f.gateway.request({
      runId: legacyRun.id,
      operationId: "op:legacy-origin-fallback",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must-not-write" },
      principal,
    })).rejects.toThrow(/origin identity is unavailable/i);
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
  });

  it("intersects delegation scope and rejects escalation", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:delegate", "running", "managed_action");
    const identity = await f.identities.resolve({ runId: run.id, principal });
    const delegations = new DelegationService(f.security, f.graph, f.timeline);
    const delegated = await delegations.delegate({ identity, childAgentId, requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }], expiresAt: "2027-08-31T08:00:00.000Z" });
    const childIdentity = await f.identities.resolve({ runId: run.id, principal, delegationId: delegated.id });
    expect(childIdentity.actorAgentId).toBe(childAgentId);
    await expect(delegations.delegate({ identity: childIdentity, childAgentId: rootAgentId, requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:production-config" }], expiresAt: "2027-08-31T08:00:00.000Z" })).rejects.toThrow(/exceed effective authority/i);
    const count = f.adapter.invocationCount;
    await delegations.revoke(identity, delegated.id, "No longer needed");
    await expect(f.gateway.request({ runId: run.id, operationId: "op:revoked", capability: "CAN_WRITE", targetNodeId: "asset:staging-config", principal, delegationId: delegated.id })).rejects.toThrow(/revoked or expired/i);
    const tooDeep = new DelegationService(f.security, f.graph, f.timeline, 1);
    const activeAgain = await delegations.delegate({ identity, childAgentId, requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }], expiresAt: "2027-08-31T08:00:00.000Z" });
    const activeChild = await f.identities.resolve({ runId: run.id, principal, delegationId: activeAgain.id });
    await expect(tooDeep.delegate({ identity: activeChild, childAgentId: rootAgentId, requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }], expiresAt: "2027-08-31T08:00:00.000Z" })).rejects.toThrow(/depth cannot exceed/i);
    expect(f.adapter.invocationCount).toBe(count);
  });

  it("does not let delegation cross into an Agent owned by another principal", async () => {
    const f = await fixture();
    await f.graphStore.createEdge(edge(
      "edge:bob-owns-child",
      "human:bob",
      `agent:${childAgentId}`,
      "OWNS",
    ));
    const run = await addRun(f, "run:delegation-owner-boundary", "running", "managed_action");
    const identity = await f.identities.resolve({ runId: run.id, principal });
    const delegations = new DelegationService(f.security, f.graph, f.timeline);

    await expect(delegations.delegate({
      identity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    })).rejects.toThrow(/owned by another authenticated person/i);

    expect(await f.security.listDelegationsForRun(run.id)).toEqual([]);
    expect((await f.timeline.list(run.id)).map((event) => event.type)).toEqual(["RUN_CREATED"]);
  });

  it("rejects a delegated request when the acting child Agent is stopped", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:stopped-delegated-child", "running", "managed_action");
    const rootIdentity = await f.identities.resolve({ runId: run.id, principal });
    const delegations = new DelegationService(f.security, f.graph, f.timeline);
    const delegated = await delegations.delegate({
      identity: rootIdentity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    });
    f.runs.getAgent(childAgentId).status = "stopped";

    await expect(f.gateway.request({
      runId: run.id,
      operationId: "op:stopped-delegated-child",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must-not-write" },
      principal,
      delegationId: delegated.id,
    })).rejects.toThrow(/stopped.*not eligible to act/i);

    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
    expect(managedReceiptCount(f.database)).toBe(0);
    expect(await f.policy.getDecisionByOperation("op:stopped-delegated-child")).toBeNull();
  });

  it("rejects an approved delegated resume when the acting child Agent was stopped", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:stopped-child-before-resume", "running", "managed_action");
    const rootIdentity = await f.identities.resolve({ runId: run.id, principal });
    const delegations = new DelegationService(f.security, f.graph, f.timeline);
    const delegated = await delegations.delegate({
      identity: rootIdentity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:production-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    });
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: "op:stopped-child-before-resume",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "reviewed but child stopped" },
      principal,
      delegationId: delegated.id,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
      reason: "Approved before the child stopped",
    });
    f.runs.getAgent(childAgentId).status = "stopped";

    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "reviewed but child stopped" },
      principal,
      delegationId: delegated.id,
    })).rejects.toThrow(/stopped.*not eligible to act/i);

    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect(managedReceiptCount(f.database)).toBe(0);
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
  });

  it("executes one delegated child action and preserves the human to parent to child to resource chain", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:delegated-success", "running", "managed_action");
    const rootIdentity = await f.identities.resolve({ runId: run.id, principal });
    const delegations = new DelegationService(f.security, f.graph, f.timeline);
    const delegated = await delegations.delegate({
      identity: rootIdentity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
      reason: "Let the Analyst Agent update this one staging configuration",
    });

    const outcome = await f.gateway.request({
      runId: run.id,
      operationId: "op:delegated-staging-write",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "delegated-safe-change" },
      principal,
      delegationId: delegated.id,
    });

    expect(outcome.status).toBe("executed");
    expect(outcome.authorization).toMatchObject({
      result: "ALLOW",
      originPrincipalId: principal.id,
      actorAgentId: childAgentId,
      delegationId: delegated.id,
    });
    expect(f.adapter.invocationCount).toBe(1);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toMatchObject({
      revision: 1,
      lastOperationId: "op:delegated-staging-write",
    });
    const events = await f.timeline.list(run.id);
    const created = events.find((event) => event.type === "RUN_CREATED");
    const delegationEvent = events.find((event) => event.type === "AGENT_DELEGATED");
    const completed = events.find((event) => event.type === "ACTION_COMPLETED");
    expect(created?.actor).toMatchObject({ principalId: principal.id, originPrincipalId: principal.id });
    expect(delegationEvent?.delegation).toMatchObject({
      parentAgentId: rootAgentId,
      childAgentId,
      depth: 1,
    });
    expect(delegationEvent?.actor).toMatchObject({
      principalId: `agent:${rootAgentId}`,
      displayName: "Release Agent",
      originPrincipalId: principal.id,
      originDisplayName: principal.displayName,
    });
    expect(completed).toMatchObject({
      actor: {
        kind: "delegated_agent",
        displayName: "Analyst Agent",
        originPrincipalId: principal.id,
        originDisplayName: principal.displayName,
        agentId: childAgentId,
        parentAgentId: rootAgentId,
      },
      agentId: childAgentId,
      resource: { resourceId: "asset:staging-config" },
      delegation: {
        delegationId: delegated.id,
        parentAgentId: rootAgentId,
        childAgentId,
      },
    });
    const evidence = await new SafetyEvidenceService(
      f.runs,
      f.policy,
      f.security,
      f.timeline,
    ).latestForAgent(rootAgentId);
    expect(evidence).toMatchObject({
      run: { id: run.id },
      identity: {
        originPrincipalId: principal.id,
        rootAgentId,
        actorAgentId: childAgentId,
        delegationChain: [{
          id: delegated.id,
          parentAgentId: rootAgentId,
          childAgentId,
          depth: 1,
        }],
      },
      verdict: { permission: "ALLOW", safety: "ALLOW", effect: "COMPLETED" },
      effectEvidence: {
        policyClaimed: true,
        completionEventRecorded: true,
        durableStateChangedByThisAction: true,
      },
    });
  });

  it.each([
    { label: "root", capabilityEdgeId: "edge:root-staging" },
    { label: "intermediate", capabilityEdgeId: "edge:nested-intermediate-staging" },
  ])("denies before evaluation when the $label delegation source loses capability", async ({
    label,
    capabilityEdgeId,
  }) => {
    const f = await fixture();
    const run = await addRun(
      f,
      `run:${label}-delegation-source-capability-removed`,
      "running",
      "managed_action",
    );
    const delegated = await createNestedDelegation(f, run);
    const removed = f.database.connection.prepare("DELETE FROM graph_edges WHERE id=?")
      .run(capabilityEdgeId);
    expect(removed.changes).toBe(1);

    const outcome = await f.gateway.request({
      runId: run.id,
      operationId: `op:${label}-delegation-source-capability-removed`,
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must-not-write" },
      principal,
      delegationId: delegated.id,
    });

    expect(outcome.status).toBe("denied");
    expect(outcome.authorization).toMatchObject({
      result: "DENY",
      reasonCode: "DELEGATION_SOURCE_CAPABILITY_REVOKED",
      evidence: {
        delegationSourceCapabilitiesAllowed: false,
        delegationAllowed: false,
      },
    });
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
    expect(managedReceiptCount(f.database)).toBe(0);
  });

  it.each([
    { label: "root", targetAgentId: rootAgentId },
    { label: "intermediate", targetAgentId: intermediateAgentId },
  ])("denies before evaluation when $label delegation-source ownership changes", async ({
    label,
    targetAgentId,
  }) => {
    const f = await fixture();
    const run = await addRun(
      f,
      `run:${label}-delegation-source-ownership-changed`,
      "running",
      "managed_action",
    );
    const delegated = await createNestedDelegation(f, run);
    f.database.connection.prepare(`DELETE FROM graph_edges
      WHERE target_id=? AND relation='OWNS'`).run(`agent:${targetAgentId}`);
    await f.graphStore.createEdge(edge(
      `edge:bob-owns-${label}-delegation-source`,
      "human:bob",
      `agent:${targetAgentId}`,
      "OWNS",
    ));

    const outcome = await f.gateway.request({
      runId: run.id,
      operationId: `op:${label}-delegation-source-ownership-changed`,
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must-not-write" },
      principal,
      delegationId: delegated.id,
    });

    expect(outcome.status).toBe("denied");
    expect(outcome.authorization).toMatchObject({
      result: "DENY",
      reasonCode: "DELEGATION_AGENT_OWNERSHIP_CHANGED",
      evidence: {
        delegationAgentOwnershipAllowed: false,
        delegationAllowed: false,
      },
    });
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
    expect(managedReceiptCount(f.database)).toBe(0);
  });

  it("fails closed for expired and forged delegation chains before any managed effect", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:delegation-adversarial", "running", "managed_action");
    const scope = [{ capability: "CAN_WRITE" as const, targetNodeId: "asset:staging-config" }];
    const expired: DelegationRecord = {
      id: "delegation:expired",
      runId: run.id,
      originPrincipalId: principal.id,
      parentAgentId: rootAgentId,
      childAgentId,
      depth: 1,
      requestedScope: scope,
      effectiveScope: scope,
      status: "expired",
      createdAt: "2026-08-29T08:00:00.000Z",
      expiresAt: "2026-08-30T08:00:00.000Z",
      revokedAt: "2026-08-30T08:00:00.000Z",
      reason: "Expired test delegation",
    };
    await f.security.createDelegation(expired);
    await expect(f.gateway.request({
      runId: run.id,
      operationId: "op:expired-delegation",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must-not-write" },
      principal,
      delegationId: expired.id,
    })).rejects.toThrow(/revoked or expired/i);

    const parent: DelegationRecord = {
      ...expired,
      id: "delegation:valid-parent",
      status: "active",
      expiresAt: "2027-08-31T08:00:00.000Z",
      createdAt: timestamp,
      revokedAt: undefined,
      reason: "Valid parent used to test forged linkage",
    };
    const forgedLeaf: DelegationRecord = {
      ...parent,
      id: "delegation:forged-leaf",
      parentDelegationId: parent.id,
      // A real child delegation would name parent.childAgentId here. This
      // forged row tries to skip back to the root while claiming depth two.
      parentAgentId: rootAgentId,
      childAgentId,
      depth: 2,
      reason: "Forged parent linkage",
    };
    await f.security.createDelegation(parent);
    await f.security.createDelegation(forgedLeaf);
    await expect(f.gateway.request({
      runId: run.id,
      operationId: "op:forged-parent",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must-not-write" },
      principal,
      delegationId: forgedLeaf.id,
    })).rejects.toThrow(/parent linkage is invalid/i);
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
  });

  it("binds an approved action to the exact still-valid delegation at final claim", async () => {
    const f = await fixture();
    const run = await addRun(f, "run:delegation-binding", "running", "managed_action");
    const rootIdentity = await f.identities.resolve({ runId: run.id, principal });
    const delegations = new DelegationService(f.security, f.graph, f.timeline);
    const productionDelegation = await delegations.delegate({
      identity: rootIdentity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:production-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    });
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: "op:delegated-production-review",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "reviewed delegated production change" },
      principal,
      delegationId: productionDelegation.id,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    await delegations.revoke(rootIdentity, productionDelegation.id, "Authority withdrawn after review");
    const stagingOnly = await delegations.delegate({
      identity: rootIdentity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    });

    const resume = (delegationId?: string) => f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "reviewed delegated production change" },
      principal,
      ...(delegationId ? { delegationId } : {}),
    });
    await expect(resume(stagingOnly.id)).rejects.toThrow(/different delegation/i);
    await expect(resume()).rejects.toThrow(/different acting Agent/i);
    await expect(resume(productionDelegation.id)).rejects.toThrow(/revoked or expired/i);
    expect(f.adapter.invocationCount).toBe(0);
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();

    const expiryFixture = await fixture();
    const expiryRun = await addRun(expiryFixture, "run:delegation-expiry-after-review", "running", "managed_action");
    const expiryRoot = await expiryFixture.identities.resolve({ runId: expiryRun.id, principal });
    const expiryDelegations = new DelegationService(expiryFixture.security, expiryFixture.graph, expiryFixture.timeline);
    const expiring = await expiryDelegations.delegate({
      identity: expiryRoot,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:production-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    });
    const expiryWarn = await expiryFixture.gateway.request({
      runId: expiryRun.id,
      operationId: "op:delegation-expiry-review",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      principal,
      delegationId: expiring.id,
    });
    if (expiryWarn.status !== "approval_required") throw new Error("expected expiry approval request");
    await expiryFixture.policy.resolveApproval({
      approvalRequestId: expiryWarn.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    expiryFixture.database.connection.prepare(`UPDATE delegations SET
      status='expired', expires_at=?, revoked_at=? WHERE id=?`)
      .run("2026-08-30T08:00:00.000Z", "2026-08-31T08:00:00.000Z", expiring.id);
    await expect(expiryFixture.gateway.resume({
      runId: expiryRun.id,
      decisionId: expiryWarn.decision.id,
      principal,
      delegationId: expiring.id,
    })).rejects.toThrow(/revoked or expired/i);
    expect(expiryFixture.adapter.invocationCount).toBe(0);
    expect(await expiryFixture.security.getManagedResourceState("asset:production-config")).toBeNull();
  });

  it.each([
    { label: "root", capabilityEdgeId: "edge:root-production" },
    { label: "intermediate", capabilityEdgeId: "edge:nested-intermediate-production" },
  ])("revalidates the $label delegation-source capability at final claim", async ({
    label,
    capabilityEdgeId,
  }) => {
    const f = await fixture();
    const run = await addRun(
      f,
      `run:${label}-delegation-capability-final-claim`,
      "running",
      "managed_action",
    );
    const delegated = await createNestedDelegation(f, run, "asset:production-config");
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: `op:${label}-delegation-capability-final-claim`,
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "review before source authority changes" },
      principal,
      delegationId: delegated.id,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    const removed = f.database.connection.prepare("DELETE FROM graph_edges WHERE id=?")
      .run(capabilityEdgeId);
    expect(removed.changes).toBe(1);

    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "review before source authority changes" },
      principal,
      delegationId: delegated.id,
    })).rejects.toThrow(/source Agent capability.*no longer authorizes/i);

    expect(f.adapter.invocationCount).toBe(0);
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect(managedReceiptCount(f.database)).toBe(0);
  });

  it.each([
    { label: "root", targetAgentId: rootAgentId },
    { label: "intermediate", targetAgentId: intermediateAgentId },
  ])("revalidates $label delegation-source ownership at final claim", async ({
    label,
    targetAgentId,
  }) => {
    const f = await fixture();
    const run = await addRun(
      f,
      `run:${label}-delegation-ownership-final-claim`,
      "running",
      "managed_action",
    );
    const delegated = await createNestedDelegation(f, run, "asset:production-config");
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: `op:${label}-delegation-ownership-final-claim`,
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "review before source ownership changes" },
      principal,
      delegationId: delegated.id,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");
    await f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    f.database.connection.prepare(`DELETE FROM graph_edges
      WHERE target_id=? AND relation='OWNS'`).run(`agent:${targetAgentId}`);
    await f.graphStore.createEdge(edge(
      `edge:bob-owns-${label}-before-final-claim`,
      "human:bob",
      `agent:${targetAgentId}`,
      "OWNS",
    ));

    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "review before source ownership changes" },
      principal,
      delegationId: delegated.id,
    })).rejects.toThrow(/ownership in the reviewed delegation chain changed/i);

    expect(f.adapter.invocationCount).toBe(0);
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
    expect(managedReceiptCount(f.database)).toBe(0);
  });

  it("rechecks the authoritative current role before root and delegated approved effects", async () => {
    const viewer: AuthenticatedPrincipal = { ...principal, role: "viewer" };

    const rootFixture = await fixture();
    const rootRun = await addRun(rootFixture, "run:root-role-downgrade", "running", "managed_action");
    const rootWarn = await rootFixture.gateway.request({
      runId: rootRun.id,
      operationId: "op:root-role-downgrade",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "approved before downgrade" },
      principal,
    });
    if (rootWarn.status !== "approval_required") throw new Error("expected root approval request");
    await rootFixture.policy.resolveApproval({
      approvalRequestId: rootWarn.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    await rootFixture.security.upsertPrincipal(viewer);
    await expect(rootFixture.gateway.resume({
      runId: rootRun.id,
      decisionId: rootWarn.decision.id,
      payload: { content: "approved before downgrade" },
      principal: viewer,
    })).rejects.toThrow(/current role no longer allows/i);
    expect(rootFixture.adapter.invocationCount).toBe(0);
    expect((await rootFixture.policy.getDecision(rootWarn.decision.id)).claimed).toBe(false);
    expect((await rootFixture.policy.getDecision(rootWarn.decision.id)).approvalRequest?.status).toBe("approved");
    expect(await rootFixture.security.getManagedResourceState("asset:production-config")).toBeNull();

    const delegatedFixture = await fixture();
    const delegatedRun = await addRun(delegatedFixture, "run:delegated-role-downgrade", "running", "managed_action");
    const rootIdentity = await delegatedFixture.identities.resolve({ runId: delegatedRun.id, principal });
    const delegations = new DelegationService(
      delegatedFixture.security,
      delegatedFixture.graph,
      delegatedFixture.timeline,
    );
    const delegated = await delegations.delegate({
      identity: rootIdentity,
      childAgentId,
      requestedScope: [{ capability: "CAN_WRITE", targetNodeId: "asset:production-config" }],
      expiresAt: "2027-08-31T08:00:00.000Z",
    });
    const delegatedWarn = await delegatedFixture.gateway.request({
      runId: delegatedRun.id,
      operationId: "op:delegated-role-downgrade",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "delegated approval before downgrade" },
      principal,
      delegationId: delegated.id,
    });
    if (delegatedWarn.status !== "approval_required") throw new Error("expected delegated approval request");
    await delegatedFixture.policy.resolveApproval({
      approvalRequestId: delegatedWarn.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
    });
    await delegatedFixture.security.upsertPrincipal(viewer);
    await expect(delegatedFixture.gateway.resume({
      runId: delegatedRun.id,
      decisionId: delegatedWarn.decision.id,
      payload: { content: "delegated approval before downgrade" },
      principal: viewer,
      delegationId: delegated.id,
    })).rejects.toThrow(/current role no longer allows/i);
    expect(delegatedFixture.adapter.invocationCount).toBe(0);
    expect((await delegatedFixture.policy.getDecision(delegatedWarn.decision.id)).claimed).toBe(false);
    expect((await delegatedFixture.policy.getDecision(delegatedWarn.decision.id)).approvalRequest?.status).toBe("approved");
    expect(await delegatedFixture.security.getManagedResourceState("asset:production-config")).toBeNull();
  });

  it("uses deterministic backend reverse queries", async () => {
    const f = await fixture();
    const impact = await f.graph.downstreamDependents("asset:production-config");
    expect(impact.blastRadius).toBe(4); // target plus three downstream assets
    expect(impact.targets[0]?.node.id).toBe("asset:production-config");
    expect(impact.targets.map((target) => target.node.id)).toEqual([
      "asset:production-config", "asset:service-a", "asset:service-b", "asset:service-c",
    ]);
    const affecting = await f.graph.agentsAffectingResource("asset:service-a");
    expect(affecting.map((item) => item.agent.id)).toEqual([
      `agent:${rootAgentId}`, `agent:${childAgentId}`,
    ]);
    expect(await f.graph.relevantAgentResourcePath(rootAgentId, "asset:service-a")).toMatchObject({
      nodeIds: [`agent:${rootAgentId}`, "asset:production-config", "asset:service-a"],
    });
    expect((await f.graph.reachableResources(rootAgentId)).map((item) => item.node.id)).toEqual([
      "asset:bob-private", "asset:production-config", "asset:service-a", "asset:service-b",
      "asset:service-c", "asset:staging-config",
    ]);
    expect((await f.graph.inboundDependencies("asset:service-a")).map((item) => item.id)).toEqual(["edge:prod-a"]);
    const run = await addRun(f, "run:related", "running", "managed_action");
    await f.gateway.request({ runId: run.id, operationId: "op:related", capability: "CAN_WRITE", targetNodeId: "asset:staging-config", principal });
    expect(await f.graph.runsRelatedToResource("asset:staging-config")).toEqual([run.id]);
  });

  it("persists baseline, breaker, and ordered events across service restart", async () => {
    const f = await fixture();
    await establishTrustedHistory(f, 3);
    const run = await addRun(f, "run:restart", "running", "managed_action");
    await f.gateway.request({ runId: run.id, operationId: "op:restart-block", capability: "CAN_WRITE", targetNodeId: "asset:production-config", principal });
    const beforeEvents = await f.timeline.list(run.id);
    const filePath = f.database.filePath;
    f.database.close();
    const reopened = new MiddlewareDatabase(filePath);
    databases.push(reopened);
    await reopened.initialize();
    const security = new SqliteSecurityStore(reopened);
    const timeline = new SqliteRunTimelineStore(reopened);
    expect((await security.getLatestBaseline(rootAgentId))?.sourceRunIds).toHaveLength(3);
    expect((await security.getBreaker(rootAgentId)).state).toBe("TRIPPED");
    expect((await timeline.list(run.id)).map((item) => item.sequence)).toEqual(beforeEvents.map((item) => item.sequence));
  });

  it("restores a tripped breaker when the required administrative reset event cannot persist", async () => {
    const f = await fixture();
    await establishTrustedHistory(f, 3);
    const blockedRun = await addRun(f, "run:trip-before-reset", "running", "managed_action");
    await f.gateway.request({
      runId: blockedRun.id,
      operationId: "op:trip-before-reset",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      principal,
    });
    const before = await f.security.getBreaker(rootAgentId);
    expect(before.state).toBe("TRIPPED");

    let auditRun!: AgentRun;
    const agents = {
      beginManagedActionRequest: () => () => undefined,
      createManagedActionRun: async (agentId: string, prompt: string, origin: AuthenticatedPrincipal) => {
        auditRun = await addRun(f, "run:failed-reset-audit", "running", "managed_action");
        auditRun.prompt = prompt;
        auditRun.originPrincipalId = origin.id;
        return auditRun;
      },
      finishManagedActionRun: async (_runId: string, outcome: "completed" | "failed" | "awaiting_approval", reason: string) => {
        auditRun.status = outcome;
        if (outcome !== "awaiting_approval") {
          await f.timeline.append({
            ...terminalEvent(auditRun.id, outcome === "completed" ? "RUN_COMPLETED" : "RUN_FAILED"),
            reason,
          });
        }
        return auditRun;
      },
      getRun: () => auditRun,
    } as unknown as AgentService;
    const failingTimeline: RunTimeline = {
      list: (runId) => f.timeline.list(runId),
      append: async (input) => {
        if (
          input.type === "CIRCUIT_BREAKER_TRANSITIONED" &&
          input.action?.operation === "reset_safety_stop"
        ) throw new Error("reset audit timeline failed");
        return f.timeline.append(input);
      },
    };
    const runtime = new ControlledActionRuntime(
      agents,
      f.gateway,
      f.security,
      failingTimeline,
    );
    await expect(runtime.resetSafetyStop({
      agentId: rootAgentId,
      principal,
      reason: "This reset must be audited",
    })).rejects.toThrow(/reset audit timeline failed/i);
    expect(await f.security.getBreaker(rootAgentId)).toMatchObject({
      state: "TRIPPED",
      version: before.version,
      reasonCode: before.reasonCode,
    });
    expect((await f.timeline.list(auditRun.id)).some((event) =>
      event.type === "CIRCUIT_BREAKER_TRANSITIONED")).toBe(false);
    expect(auditRun.status).toBe("failed");
  });

  it("keeps concurrent threshold crossings tripped and prevents both effects", async () => {
    const f = await fixture();
    await establishTrustedHistory(f, 3);
    const first = await addRun(f, "run:race-a", "running", "managed_action");
    const second = await addRun(f, "run:race-b", "running", "managed_action");
    const outcomes = await Promise.all([
      f.gateway.request({ runId: first.id, operationId: "op:race-a", capability: "CAN_WRITE", targetNodeId: "asset:production-config", principal }),
      f.gateway.request({ runId: second.id, operationId: "op:race-b", capability: "CAN_WRITE", targetNodeId: "asset:production-config", principal }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "denied")).toBe(true);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("TRIPPED");
    expect(await f.security.getManagedResourceState("asset:production-config")).toBeNull();
  });

  it("repairs a missing required decision fact before an idempotent retry can execute", async () => {
    let backing!: SqliteRunTimelineStore;
    let failAuthorizationOnce = true;
    const interrupted: RunTimeline = {
      list: (runId) => backing.list(runId),
      append: async (input) => {
        if (input.type === "AUTHORIZATION_DECIDED" && failAuthorizationOnce) {
          failAuthorizationOnce = false;
          throw new Error("required authorization fact interrupted");
        }
        return backing.append(input);
      },
    };
    const f = await fixture({ timeline: interrupted });
    backing = new SqliteRunTimelineStore(f.database);
    const run = await addRun(f, "run:audit-repair", "running", "managed_action");
    const request = {
      runId: run.id,
      operationId: "op:audit-repair",
      capability: "CAN_WRITE" as const,
      targetNodeId: "asset:staging-config",
      payload: { content: "repair only after evidence exists" },
      principal,
    };

    await expect(f.gateway.request(request)).rejects.toThrow(/required authorization fact interrupted/i);
    expect(f.adapter.invocationCount).toBe(0);
    const persisted = await f.policy.getDecisionByOperation(request.operationId);
    expect(persisted).not.toBeNull();
    await expect(f.policy.claimForExecution({
      decisionId: persisted!.decision.id,
      agentId: rootAgentId,
      actorPrincipalId: principal.id,
      actorRole: principal.role,
      payload: request.payload,
    })).rejects.toThrow(/execution remains blocked/i);
    expect((await f.policy.getDecision(persisted!.decision.id)).claimed).toBe(false);

    await expect(f.gateway.request(request)).resolves.toMatchObject({ status: "executed" });
    expect(f.adapter.invocationCount).toBe(1);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toMatchObject({
      lastOperationId: request.operationId,
    });
    const types = (await f.timeline.list(run.id)).map((event) => event.type);
    expect(types.filter((type) => type === "AUTHORIZATION_DECIDED")).toHaveLength(1);
    expect(types.filter((type) => type === "RISK_DECIDED")).toHaveLength(1);
    expect(types.filter((type) => type === "ACTION_ALLOWED")).toHaveLength(1);
  });

  it("keeps a durably approved action blocked until its missing human audit fact is repaired", async () => {
    let backing!: SqliteRunTimelineStore;
    let failResolution = true;
    const interrupted: RunTimeline = {
      list: (runId) => backing.list(runId),
      append: async (input) => {
        if (input.type === "APPROVAL_RESOLVED" && failResolution) {
          throw new Error("approval audit interrupted");
        }
        return backing.append(input);
      },
    };
    const f = await fixture({ timeline: interrupted });
    backing = new SqliteRunTimelineStore(f.database);
    const run = await addRun(f, "run:approval-audit-repair", "running", "managed_action");
    const warned = await f.gateway.request({
      runId: run.id,
      operationId: "op:approval-audit-repair",
      capability: "CAN_WRITE",
      targetNodeId: "asset:production-config",
      payload: { content: "reviewed but not yet auditable" },
      principal,
    });
    if (warned.status !== "approval_required") throw new Error("expected approval request");

    await expect(f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
      reason: "Approval must be auditable",
    })).rejects.toThrow(/approval audit interrupted/i);
    expect((await f.policy.getDecision(warned.decision.id)).approvalRequest?.status).toBe("approved");
    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "reviewed but not yet auditable" },
      principal,
    })).rejects.toThrow(/execution remains blocked/i);
    expect(f.adapter.invocationCount).toBe(0);
    expect((await f.policy.getDecision(warned.decision.id)).claimed).toBe(false);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("WARN");

    failResolution = false;
    await expect(f.policy.resolveApproval({
      approvalRequestId: warned.approvalRequest.id,
      resolution: "approved",
      actorPrincipalId: principal.id,
      reason: "A different retry reason must not rewrite the original fact",
    })).resolves.toMatchObject({ event: { reason: "Approval must be auditable" } });
    await expect(f.gateway.resume({
      runId: run.id,
      decisionId: warned.decision.id,
      payload: { content: "reviewed but not yet auditable" },
      principal,
    })).resolves.toMatchObject({ status: "executed" });
    expect(f.adapter.invocationCount).toBe(1);
    expect((await f.timeline.list(run.id)).filter((event) =>
      event.type === "APPROVAL_RESOLVED")).toHaveLength(1);
  });

  it("atomically refuses a stale ALLOW claim when another request trips the breaker", async () => {
    let injected = false;
    const f = await fixture({
      beforeClaim: (database) => {
        if (injected) return;
        injected = true;
        const changed = database.connection.prepare(`UPDATE circuit_breakers
          SET state='TRIPPED', version=version + 1,
              reason_code='CONCURRENT_SAFETY_STOP',
              explanation='Another request tripped the safety stop.',
              updated_at=?
          WHERE scope_type='agent' AND scope_id=?`)
          .run("2026-08-31T08:00:01.000Z", rootAgentId);
        expect(changed.changes).toBe(1);
      },
    });
    const run = await addRun(f, "run:atomic-breaker-guard", "running", "managed_action");

    await expect(f.gateway.request({
      runId: run.id,
      operationId: "op:atomic-breaker-guard",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "must not race the safety stop" },
      principal,
    })).rejects.toThrow(/changed after policy evaluation/i);

    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
    const detail = await f.policy.getDecisionByOperation("op:atomic-breaker-guard");
    expect(detail?.claimed).toBe(false);
    expect((await f.security.getBreaker(rootAgentId)).state).toBe("TRIPPED");
  });

  it("fails closed before the sentinel when a required decision event cannot persist", async () => {
    let backing!: SqliteRunTimelineStore;
    const failing: RunTimeline = {
      list: (runId) => backing.list(runId),
      append: async (input: AppendRunEvent) => {
        if (input.type === "AUTHORIZATION_DECIDED") throw new Error("timeline write failed");
        return backing.append(input);
      },
    };
    const f = await fixture({ timeline: failing });
    backing = new SqliteRunTimelineStore(f.database);
    const run = await addRun(f, "run:timeline-failure", "running", "managed_action");
    await expect(f.gateway.request({ runId: run.id, operationId: "op:no-effect", capability: "CAN_WRITE", targetNodeId: "asset:staging-config", payload: { content: "no" }, principal })).rejects.toThrow(/timeline write failed/);
    expect(f.adapter.invocationCount).toBe(0);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toBeNull();
  });

  it("reports post-effect audit failure without claiming the real mutation was prevented", async () => {
    let backing!: SqliteRunTimelineStore;
    const interrupted: RunTimeline = {
      list: (runId) => backing.list(runId),
      append: async (input) => {
        if (input.type === "ACTION_COMPLETED") {
          throw new Error("completion timeline unavailable");
        }
        return backing.append(input);
      },
    };
    const f = await fixture({ timeline: interrupted });
    backing = new SqliteRunTimelineStore(f.database);
    const run = await addRun(f, "run:post-effect-audit", "running", "managed_action");

    await expect(f.gateway.request({
      runId: run.id,
      operationId: "op:post-effect-audit",
      capability: "CAN_WRITE",
      targetNodeId: "asset:staging-config",
      payload: { content: "the adapter really changed this" },
      principal,
    })).rejects.toBeInstanceOf(PostEffectFinalizationError);

    expect(f.adapter.invocationCount).toBe(1);
    expect(await f.security.getManagedResourceState("asset:staging-config")).toMatchObject({
      lastOperationId: "op:post-effect-audit",
    });
    const events = await f.timeline.list(run.id);
    expect(events.some((event) => event.type === "ACTION_FAILED")).toBe(false);
    expect(events.some((event) =>
      event.type === "ACTION_BLOCKED" && /nothing changed/i.test(event.reason))).toBe(false);
  });
});

async function establishTrustedHistory(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  for (let index = 1; index <= count; index += 1) {
    const run = await addRun(f, `run:trusted:${index}`, "running", "managed_action");
    const outcome = await f.gateway.request({ runId: run.id, operationId: `op:trusted:${index}`, capability: "CAN_WRITE", targetNodeId: "asset:staging-config", payload: { revision: index }, principal });
    if (outcome.status !== "executed") throw new Error("Trusted fixture action did not execute");
    run.status = "completed";
    run.completedAt = timestamp;
    await f.timeline.append(terminalEvent(run.id, "RUN_COMPLETED"));
  }
  return f.baselines.rebuild(rootAgentId);
}

async function addRun(f: Awaited<ReturnType<typeof fixture>>, id: string, status: AgentRun["status"], kind: AgentRun["kind"]) {
  const run: AgentRun = { id, agentId: rootAgentId, status, prompt: "", output: null, error: null, usage: null, startedAt: timestamp, completedAt: status === "completed" || status === "failed" ? timestamp : null, createdAt: timestamp, kind, originPrincipalId: principal.id };
  f.runs.runs.push(run);
  await f.timeline.append({ runId: id, type: "RUN_CREATED", actor: { principalId: principal.id, kind: "human", displayName: principal.displayName, originPrincipalId: principal.id, agentId: rootAgentId }, agentId: rootAgentId, outcome: "pending", reasonCode: "TEST_RUN", reason: "Test managed Run" });
  return run;
}

async function createNestedDelegation(
  f: Awaited<ReturnType<typeof fixture>>,
  run: AgentRun,
  targetNodeId = "asset:staging-config",
): Promise<DelegationRecord> {
  f.runs.agents.set(intermediateAgentId, agent(intermediateAgentId));
  await f.graphStore.createNode(node(
    `agent:${intermediateAgentId}`,
    "agent",
    "Intermediate Agent",
  ));
  await f.graphStore.createEdge(edge(
    targetNodeId === "asset:staging-config"
      ? "edge:nested-intermediate-staging"
      : "edge:nested-intermediate-production",
    `agent:${intermediateAgentId}`,
    targetNodeId,
    "CAN_WRITE",
  ));
  const delegations = new DelegationService(f.security, f.graph, f.timeline);
  const rootIdentity = await f.identities.resolve({ runId: run.id, principal });
  const parent = await delegations.delegate({
    identity: rootIdentity,
    childAgentId: intermediateAgentId,
    requestedScope: [{ capability: "CAN_WRITE", targetNodeId }],
    expiresAt: "2027-08-31T08:00:00.000Z",
  });
  const intermediateIdentity = await f.identities.resolve({
    runId: run.id,
    principal,
    delegationId: parent.id,
  });
  return delegations.delegate({
    identity: intermediateIdentity,
    childAgentId,
    requestedScope: [{ capability: "CAN_WRITE", targetNodeId }],
    expiresAt: "2027-08-31T08:00:00.000Z",
  });
}

function managedReceiptCount(database: MiddlewareDatabase): number {
  return (database.connection.prepare(
    "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
  ).get() as { count: number }).count;
}

function event(runId: string, type: "ACTION_COMPLETED" | "ACTION_BLOCKED", resourceId: string, metadata: Record<string, unknown>): AppendRunEvent {
  return { runId, type, actor: { principalId: `agent:${rootAgentId}`, kind: "agent", originPrincipalId: principal.id, agentId: rootAgentId }, agentId: rootAgentId, action: { operation: `op:${runId}`, capability: "CAN_WRITE" }, resource: { resourceId }, outcome: type === "ACTION_COMPLETED" ? "succeeded" : "blocked", reasonCode: type, reason: type, metadata };
}
function terminalEvent(runId: string, type: "RUN_COMPLETED" | "RUN_FAILED" = "RUN_COMPLETED"): AppendRunEvent {
  return { runId, type, actor: { principalId: `agent:${rootAgentId}`, kind: "agent", originPrincipalId: principal.id, agentId: rootAgentId }, agentId: rootAgentId, outcome: type === "RUN_COMPLETED" ? "succeeded" : "failed", reasonCode: type, reason: type };
}
function agent(id: string): Agent { return { id, name: id === rootAgentId ? "Release Agent" : "Analyst Agent", description: "", instructions: "", status: "busy", workspacePath: "/tmp", codexThreadId: null, lastError: null, createdAt: timestamp, updatedAt: timestamp }; }
function node(id: string, type: GraphNode["type"], label: string, riskWeight = 0, classification: GraphNode["classification"] = "internal", metadata: Record<string, unknown> = {}): GraphNode { return { id, type, label, riskLevel: classification === "restricted" ? "critical" : riskWeight >= 7 ? "high" : "low", riskWeight, classification, metadata, createdAt: timestamp, updatedAt: timestamp }; }
function edge(id: string, sourceId: string, targetId: string, relation: GraphEdge["relation"]): GraphEdge { return { id, sourceId, targetId, relation, status: "authorized", metadata: {}, createdAt: timestamp }; }
