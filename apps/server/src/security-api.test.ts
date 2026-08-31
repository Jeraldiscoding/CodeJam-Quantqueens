import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { BehavioralBaselineService, BehavioralRiskService } from "./behavioral-security.js";
import { loadConfig } from "./config.js";
import { ControlledActionRuntime } from "./controlled-action-runtime.js";
import { SafetyEvidenceService } from "./safety-evidence.js";
import { DelegationService } from "./delegation-service.js";
import { demoAgents } from "./demo-graph.js";
import { ExecutionIdentityService } from "./execution-identity.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { SqliteManagedResourceAdapter } from "./managed-resource-adapter.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { PolicyService } from "./policy-service.js";
import { ResourceGateway } from "./resource-gateway.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteRunTimelineStore } from "./sqlite-run-timeline-store.js";
import { SqliteSecurityStore } from "./sqlite-security-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

class UnusedRunner implements AgentRunner {
  async run(_request: RunnerRequest): Promise<RunnerResult> {
    throw new Error("Managed actions must not invoke the conversational runner");
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

describe("managed security API", () => {
  it("uses the server principal, ignores forged body identity, and changes managed state through the gateway", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-security-api-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      SEED_DEMO_DATA: "true",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      APP_PRINCIPAL_ID: "human:alice",
      APP_PRINCIPAL_NAME: "Alice",
      APP_PRINCIPAL_ROLE: "admin",
    });
    const databasePath = path.join(root, "data", "middleware.db");
    const database = new MiddlewareDatabase(databasePath);
    await database.initialize();
    const graphStore = new SqliteGraphStore(database);
    const graph = new KnowledgeGraphService(graphStore, config.policyReviewThreshold);
    const graphConfiguration = new GraphConfigurationService(graphStore);
    const timeline = new SqliteRunTimelineStore(database);
    const security = new SqliteSecurityStore(database);
    const principal: AuthenticatedPrincipal = {
      id: config.principalId,
      kind: "human",
      displayName: config.principalName,
      role: config.principalRole,
      authenticationSource: "local_loopback",
    };
    await security.upsertPrincipal(principal);

    let service!: AgentService;
    const directory = {
      getRun: (runId: string) => service.getRun(runId),
      getAgent: (agentId: string) => service.getAgent(agentId),
      getRuns: (agentId: string) => service.getRuns(agentId),
    };
    const baselines = new BehavioralBaselineService(security, timeline, directory);
    const risk = new BehavioralRiskService(
      security,
      baselines,
      config.policyReviewThreshold,
      config.policyDenyThreshold,
    );
    const identities = new ExecutionIdentityService(directory, security, timeline);
    const policy = new PolicyService(
      graph,
      graphStore,
      new SqliteGovernanceStore(database),
      {
        reviewThreshold: config.policyReviewThreshold,
        denyThreshold: config.policyDenyThreshold,
        approvalTtlMs: config.policyApprovalTtlMs,
      },
      { security, risk, timeline },
    );
    service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "launchpad.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new UnusedRunner(),
      new DemoAgentGraphProvisioner(graphStore, {
        id: principal.id,
        label: principal.displayName,
      }),
      undefined,
      undefined,
      timeline,
    );
    await service.initialize();
    const adapter = new SqliteManagedResourceAdapter(security);
    const gateway = new ResourceGateway(policy, graphStore, service, adapter, identities, timeline);
    const delegations = new DelegationService(security, graph, timeline);
    const controlledActions = new ControlledActionRuntime(service, gateway, security, timeline);
    const safetyEvidence = new SafetyEvidenceService(service, policy, security, timeline);
    const app = await createApp(
      config,
      service,
      graph,
      graphConfiguration,
      policy,
      gateway,
      undefined,
      timeline,
      { principal, identities, delegations, baselines, security, controlledActions, safetyEvidence },
    );
    app.addHook("onClose", () => database.close());

    // Admission and the protected effect share one Agent lifecycle boundary:
    // two simultaneous HTTP requests may not create two managed Runs or two
    // durable revisions for the same Agent.
    const raceResponses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
        headers: { "x-principal-id": "human:mallory" },
        payload: {
          capability: "CAN_WRITE",
          targetNodeId: "asset:staging-config",
          payload: { content: "approved staging change" },
          actorPrincipalId: "human:mallory",
          principal: { id: "human:mallory", role: "admin" },
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
        headers: { "x-principal-id": "human:mallory" },
        payload: {
          capability: "CAN_WRITE",
          targetNodeId: "asset:staging-config",
          payload: { content: "approved staging change" },
          actorPrincipalId: "human:mallory",
          principal: { id: "human:mallory", role: "admin" },
        },
      }),
    ]);
    expect(raceResponses.map((item) => item.statusCode).sort((left, right) => left - right))
      .toEqual([200, 409]);
    const response = raceResponses.find((item) => item.statusCode === 200)!;
    const refusal = raceResponses.find((item) => item.statusCode === 409)!;
    expect(refusal.json()).toMatchObject({ error: expect.stringMatching(/already running/i) });
    const body = response.json();
    expect(adapter.invocationCount).toBe(1);
    expect(await security.getManagedResourceState("asset:staging-config")).toMatchObject({
      revision: 1,
      lastOperationId: `managed:${body.run.id}`,
    });
    const raceReceipts = database.connection.prepare(
      "SELECT run_id, operation_id FROM managed_resource_action_receipts ORDER BY operation_id",
    ).all() as Array<{ run_id: string; operation_id: string }>;
    expect(raceReceipts).toEqual([{
      run_id: body.run.id,
      operation_id: `managed:${body.run.id}`,
    }]);
    expect(service.getRuns(demoAgents.releaseGuardian.id).filter(
      (run) => run.prompt === "CAN_WRITE asset:staging-config",
    )).toHaveLength(1);

    const aliceRead = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
      headers: { "x-principal-id": "human:bob" },
      payload: {
        capability: "CAN_READ",
        targetNodeId: "asset:alice-private-records",
        principalId: "human:bob",
      },
    });
    expect(aliceRead.statusCode, aliceRead.body).toBe(200);
    const aliceReadBody = aliceRead.json();
    expect(aliceReadBody.outcome).toMatchObject({
      status: "executed",
      authorization: {
        originPrincipalId: principal.id,
        result: "ALLOW",
        reasonCode: "ROLE_AND_EXACT_CAPABILITY_ALLOW",
        evidence: {
          resourceOwnerIds: ["human:alice"],
          resourceOwnershipAllowed: true,
        },
      },
      result: { kind: "read" },
    });
    expect(adapter.invocationCount).toBe(2);

    const bobRead = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
      headers: { "x-principal-id": "human:bob" },
      payload: {
        capability: "CAN_READ",
        targetNodeId: "asset:bob-private-records",
        principalId: "human:bob",
        principal: { id: "human:bob", role: "admin" },
      },
    });
    expect(bobRead.statusCode, bobRead.body).toBe(403);
    const bobReadBody = bobRead.json();
    expect(bobReadBody.outcome).toMatchObject({
      status: "denied",
      authorization: {
        originPrincipalId: principal.id,
        result: "DENY",
        reasonCode: "RESOURCE_OWNED_BY_ANOTHER_PRINCIPAL",
        evidence: {
          resourceOwnerIds: ["human:bob"],
          resourceOwnershipAllowed: false,
        },
      },
    });
    expect(adapter.invocationCount).toBe(2);
    const bobEvents = await timeline.list(bobReadBody.run.id);
    expect(bobEvents.find((event) => event.type === "ACTION_BLOCKED")).toMatchObject({
      actor: {
        originPrincipalId: principal.id,
        agentId: demoAgents.releaseGuardian.id,
      },
      agentId: demoAgents.releaseGuardian.id,
      action: { capability: "CAN_READ" },
      resource: { resourceId: "asset:bob-private-records" },
      outcome: "blocked",
      reasonCode: "RESOURCE_OWNED_BY_ANOTHER_PRINCIPAL",
    });
    const bobImpact = await app.inject({
      method: "GET",
      url: "/api/graph/resources/asset:bob-private-records/impact",
    });
    expect(bobImpact.statusCode, bobImpact.body).toBe(200);
    expect(bobImpact.json().owners).toMatchObject([
      { id: "human:bob", label: "Bob (Demo User)", type: "human" },
    ]);

    const marcusAgent = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.dataSteward.id}/managed-actions`,
      payload: {
        capability: "CAN_READ",
        targetNodeId: "asset:customer-dataset",
      },
    });
    expect(marcusAgent.statusCode, marcusAgent.body).toBe(403);
    expect(marcusAgent.json().outcome.authorization).toMatchObject({
      originPrincipalId: principal.id,
      result: "DENY",
      reasonCode: "AGENT_OWNED_BY_ANOTHER_PRINCIPAL",
      evidence: {
        agentOwnerIds: ["human:marcus"],
        agentOwnershipAllowed: false,
        directCapability: "demo:steward-can-read-customers",
      },
    });
    expect(adapter.invocationCount).toBe(2);

    expect(body.run.originPrincipalId).toBe(principal.id);
    expect(body.outcome.authorization).toMatchObject({
      originPrincipalId: principal.id,
      result: "ALLOW",
    });
    expect(await security.getPrincipal("human:mallory")).toBeNull();
    expect(await security.getManagedResourceState("asset:staging-config")).toMatchObject({
      revision: 1,
      lastOperationId: `managed:${body.run.id}`,
    });
    expect(adapter.invocationCount).toBe(2);
    const events = await timeline.list(body.run.id);
    expect(events.find((event) => event.type === "RUN_CREATED")?.actor.originPrincipalId).toBe(principal.id);
    expect(events.find((event) => event.type === "ACTION_COMPLETED")?.metadata).toMatchObject({
      authorizationResult: "ALLOW",
      riskResult: "ALLOW",
      approved: false,
      blastRadius: 3,
    });

    // Exercise the exact two-button UI flow through HTTP: finish three real
    // trusted staging Runs, fetch learned context, then attempt a technically
    // permitted shared change with materially larger graph impact.
    for (const revision of [2, 3]) {
      const normal = await app.inject({
        method: "POST",
        url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
        payload: {
          capability: "CAN_WRITE",
          targetNodeId: "asset:staging-config",
          payload: { content: `trusted staging change ${revision}` },
        },
      });
      expect(normal.statusCode).toBe(200);
      expect(normal.json().outcome.risk.result).toBe("ALLOW");
    }
    const baselineResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/behavior-baseline`,
    });
    expect(baselineResponse.statusCode).toBe(200);
    expect(baselineResponse.json().baseline).toMatchObject({
      eligibleRunCount: 4,
      minimumHistory: 3,
      maximumBlastRadius: 3,
      normalScope: expect.arrayContaining([
        { capability: "CAN_READ", targetNodeId: "asset:alice-private-records" },
        { capability: "CAN_WRITE", targetNodeId: "asset:staging-config" },
      ]),
    });

    const unusual = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
      payload: {
        capability: "CAN_WRITE",
        targetNodeId: "asset:deployment-config",
        payload: { content: "broader production change" },
      },
    });
    expect(unusual.statusCode).toBe(403);
    const unusualBody = unusual.json();
    expect(unusualBody.outcome.authorization.result).toBe("ALLOW");
    expect(unusualBody.outcome.risk).toMatchObject({ result: "BLOCK" });
    expect(unusualBody.outcome.risk.explanation).toMatch(/blocked before anything changed/i);
    expect(unusualBody.outcome.risk.factors.map((factor: { code: string }) => factor.code)).toEqual(
      expect.arrayContaining(["NOVEL_RESOURCE", "BLAST_RADIUS_EXPANSION", "SENSITIVE_DOWNSTREAM"]),
    );
    expect(unusualBody.outcome.risk.explanation).toMatch(/Customer dataset/);
    expect(await security.getManagedResourceState("asset:deployment-config")).toBeNull();
    expect((await security.getBreaker(demoAgents.releaseGuardian.id)).state).toBe("TRIPPED");

    const evidenceResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/safety-evidence/latest`,
    });
    expect(evidenceResponse.statusCode).toBe(200);
    expect(evidenceResponse.json().evidence).toMatchObject({
      schemaVersion: 1,
      run: { id: unusualBody.run.id, status: "failed" },
      action: {
        capability: "CAN_WRITE",
        resourceId: "asset:deployment-config",
        resourceLabel: "Deployment configuration",
      },
      identity: {
        originPrincipalId: principal.id,
        rootAgentId: demoAgents.releaseGuardian.id,
        actorAgentId: demoAgents.releaseGuardian.id,
        delegationChain: [],
      },
      verdict: {
        permission: "ALLOW",
        safety: "BLOCK",
        effect: "PREVENTED",
      },
      historicalContext: {
        revision: expect.any(Number),
        trustedRunCount: 4,
        sourceRunIds: expect.arrayContaining([
          aliceReadBody.run.id,
          body.run.id,
        ]),
        normalScope: expect.arrayContaining([
          { capability: "CAN_READ", targetNodeId: "asset:alice-private-records" },
          { capability: "CAN_WRITE", targetNodeId: "asset:staging-config" },
        ]),
        maximumBlastRadius: 3,
        factors: expect.arrayContaining([
          expect.objectContaining({ code: "NOVEL_RESOURCE" }),
          expect.objectContaining({ code: "BLAST_RADIUS_EXPANSION" }),
          expect.objectContaining({
            code: "SENSITIVE_DOWNSTREAM",
            path: [
              "asset:deployment-config",
              "asset:production-service",
              "asset:customer-dataset",
            ],
          }),
        ]),
      },
      impactAtDecision: {
        blastRadius: 5,
        targets: expect.arrayContaining([
          expect.objectContaining({ id: "asset:deployment-config" }),
          expect.objectContaining({
            id: "asset:customer-dataset",
            path: [
              "Deployment configuration",
              "Production service",
              "Customer dataset",
            ],
          }),
        ]),
      },
      effectEvidence: {
        policyClaimed: false,
        completionEventRecorded: false,
        durableStateChangedByThisAction: false,
      },
      timeline: { eventCount: 9, firstSequence: 1, lastSequence: 9 },
      coverage: { scope: "managed_resource_actions" },
    });
    expect(evidenceResponse.json().evidence.impactAtDecision.targets[0].id).toBe(
      "asset:deployment-config",
    );

    const impactResponse = await app.inject({
      method: "GET",
      url: "/api/graph/resources/asset:deployment-config/impact",
    });
    expect(impactResponse.statusCode).toBe(200);
    const downstream = impactResponse.json().downstream;
    expect(downstream).toMatchObject({ blastRadius: 5 });
    expect(downstream.targets[0].node.id).toBe("asset:deployment-config");
    expect(downstream.targets.map((target: { node: { label: string } }) => target.node.label)).toEqual(
      expect.arrayContaining(["Deployment configuration", "Production service", "Customer dataset"]),
    );

    const unusualTimeline = await app.inject({
      method: "GET",
      url: `/api/runs/${unusualBody.run.id}/events`,
    });
    expect(unusualTimeline.statusCode).toBe(200);
    expect(unusualTimeline.json().events.map((event: { type: string }) => event.type)).toEqual([
      "RUN_CREATED", "RUN_STARTED", "ACTION_REQUESTED", "RESOURCE_ACCESS_ATTEMPTED",
      "AUTHORIZATION_DECIDED", "RISK_DECIDED", "CIRCUIT_BREAKER_TRANSITIONED",
      "ACTION_BLOCKED", "RUN_FAILED",
    ]);

    const reset = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/circuit-breaker/reset`,
      payload: { reason: "Judge reviewed the blocked demo and reset it" },
    });
    expect(reset.statusCode).toBe(200);
    const resetBody = reset.json();
    expect(resetBody.circuitBreaker).toMatchObject({
      state: "NORMAL",
      reasonCode: "ADMIN_RESET",
    });
    expect(resetBody.run).toMatchObject({
      agentId: demoAgents.releaseGuardian.id,
      status: "completed",
      originPrincipalId: principal.id,
    });
    const resetTimelineResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${resetBody.run.id}/events`,
    });
    expect(resetTimelineResponse.statusCode).toBe(200);
    expect(resetTimelineResponse.json().events.map((event: { type: string }) => event.type)).toEqual([
      "RUN_CREATED", "RUN_STARTED", "CIRCUIT_BREAKER_TRANSITIONED", "RUN_COMPLETED",
    ]);
    expect(resetTimelineResponse.json().events[2]).toMatchObject({
      actor: { principalId: principal.id, originPrincipalId: principal.id },
      agentId: demoAgents.releaseGuardian.id,
      decision: { layer: "circuit_breaker", result: "NORMAL", reasonCode: "ADMIN_RESET" },
      reason: "Judge reviewed the blocked demo and reset it",
      metadata: {
        previousState: "TRIPPED",
        newState: "NORMAL",
      },
    });

    // Hold policy evaluation open while stop is requested. stopAgent must not
    // report success and then allow this older request to claim or execute.
    // The lifecycle lease lets stop drain the request, while the pre-claim
    // cancellation guard makes the still-pending effect fail closed.
    let policyEntered!: () => void;
    let releasePolicy!: () => void;
    const enteredPolicy = new Promise<void>((resolve) => {
      policyEntered = resolve;
    });
    const policyBarrier = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const originalEvaluate = policy.evaluate.bind(policy);
    const evaluateSpy = vi.spyOn(policy, "evaluate").mockImplementationOnce(async (input) => {
      policyEntered();
      await policyBarrier;
      return originalEvaluate(input);
    });
    const invocationsBeforeStop = adapter.invocationCount;
    const claimsBeforeStop = database.connection.prepare(
      "SELECT COUNT(*) AS count FROM policy_action_claims",
    ).get() as { count: number };
    const receiptsBeforeStop = database.connection.prepare(
      "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
    ).get() as { count: number };
    const stateBeforeStop = await security.getManagedResourceState("asset:staging-config");
    expect(stateBeforeStop?.revision).toBe(3);

    const actionDuringStop = app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
      payload: {
        capability: "CAN_WRITE",
        targetNodeId: "asset:staging-config",
        payload: { content: "must not survive stop" },
      },
    });
    await enteredPolicy;
    const pendingRun = service.getRuns(demoAgents.releaseGuardian.id).find(
      (run) => run.status === "running",
    );
    expect(pendingRun).toBeDefined();

    let stopResolved = false;
    const stopping = app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/stop`,
    }).then((result) => {
      stopResolved = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopResolved).toBe(false);

    releasePolicy();
    const [stoppedAction, stopped] = await Promise.all([actionDuringStop, stopping]);
    evaluateSpy.mockRestore();
    expect(stoppedAction.statusCode, stoppedAction.body).toBe(409);
    expect(stopped.json().agent.status).toBe("stopped");
    expect(service.getRun(pendingRun!.id).status).toBe("failed");
    expect(adapter.invocationCount).toBe(invocationsBeforeStop);
    expect(await security.getManagedResourceState("asset:staging-config")).toEqual(stateBeforeStop);
    expect((database.connection.prepare(
      "SELECT COUNT(*) AS count FROM policy_action_claims",
    ).get() as { count: number }).count).toBe(claimsBeforeStop.count);
    expect((database.connection.prepare(
      "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
    ).get() as { count: number }).count).toBe(receiptsBeforeStop.count);

    const stoppedFutureAction = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
      payload: {
        capability: "CAN_WRITE",
        targetNodeId: "asset:staging-config",
        payload: { content: "stopped Agents cannot act" },
      },
    });
    expect(stoppedFutureAction.statusCode, stoppedFutureAction.body).toBe(409);
    expect(adapter.invocationCount).toBe(invocationsBeforeStop);

    const restarted = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/start`,
    });
    expect(restarted.statusCode, restarted.body).toBe(200);
    const afterRestart = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/managed-actions`,
      payload: {
        capability: "CAN_WRITE",
        targetNodeId: "asset:staging-config",
        payload: { content: "new work after an explicit restart" },
      },
    });
    expect(afterRestart.statusCode, afterRestart.body).toBe(200);
    expect(adapter.invocationCount).toBe(invocationsBeforeStop + 1);
    expect(await security.getManagedResourceState("asset:staging-config")).toMatchObject({
      revision: 4,
      lastOperationId: `managed:${afterRestart.json().run.id}`,
    });

    // Official Track B proof: Alice creates a new non-human Agent, grants that
    // exact Agent one Alice-data permission, proves Alice ALLOW/Bob DENY, then
    // disables it. This must not rely on the statically seeded demo Agent.
    const createdAgentResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Alice's Audit Agent",
        description: "Created during the Track B verification",
        instructions: "Use only explicitly granted resources.",
      },
    });
    expect(createdAgentResponse.statusCode, createdAgentResponse.body).toBe(201);
    const createdAgent = createdAgentResponse.json().agent;
    expect(await graph.ownersOfAgent(createdAgent.id)).toMatchObject([
      { id: principal.id, type: "human" },
    ]);
    expect(await graph.listCapabilities(createdAgent.id)).toEqual([]);

    const grant = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/graph/relationships`,
      payload: {
        sourceId: `agent:${createdAgent.id}`,
        targetId: "asset:alice-private-records",
        relation: "CAN_READ",
      },
    });
    expect(grant.statusCode, grant.body).toBe(201);

    const createdOwnedRead = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/managed-actions`,
      payload: {
        capability: "CAN_READ",
        targetNodeId: "asset:alice-private-records",
      },
    });
    expect(createdOwnedRead.statusCode, createdOwnedRead.body).toBe(200);
    const createdOwnedRunId = createdOwnedRead.json().run.id as string;
    const createdForeignRead = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/managed-actions`,
      headers: { "x-principal-id": "human:bob" },
      payload: {
        capability: "CAN_READ",
        targetNodeId: "asset:bob-private-records",
        claimedPrincipalId: "human:bob",
      },
    });
    expect(createdForeignRead.statusCode, createdForeignRead.body).toBe(403);
    const createdForeignRunId = createdForeignRead.json().run.id as string;
    expect(createdForeignRead.json().outcome.authorization).toMatchObject({
      originPrincipalId: principal.id,
      result: "DENY",
    });
    expect(database.connection.prepare(`SELECT run_id FROM managed_resource_action_receipts
      WHERE run_id IN (?, ?) ORDER BY run_id`).all(
      createdOwnedRunId,
      createdForeignRunId,
    )).toEqual([{ run_id: createdOwnedRunId }]);
    expect((await timeline.list(createdOwnedRunId)).find(
      (event) => event.type === "ACTION_COMPLETED",
    )?.actor).toMatchObject({
      principalId: `agent:${createdAgent.id}`,
      agentId: createdAgent.id,
      originPrincipalId: principal.id,
    });

    const stoppedCreatedAgent = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/stop`,
    });
    expect(stoppedCreatedAgent.statusCode, stoppedCreatedAgent.body).toBe(200);
    const receiptsBeforeStoppedAttempt = database.connection.prepare(
      "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
    ).get() as { count: number };
    const stoppedAttempt = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/managed-actions`,
      payload: {
        capability: "CAN_READ",
        targetNodeId: "asset:alice-private-records",
      },
    });
    expect(stoppedAttempt.statusCode, stoppedAttempt.body).toBe(409);
    expect(database.connection.prepare(
      "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
    ).get()).toEqual(receiptsBeforeStoppedAttempt);

    // The generic protected-action route must enforce the lifecycle of the
    // delegated actor as well as the root Run Agent. A live root Run cannot be
    // used to launder an effect through a child Agent after that child stops.
    const delegatedChildResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Stopped Delegated Child",
        description: "Lifecycle boundary proof for delegated generic actions",
      },
    });
    expect(delegatedChildResponse.statusCode, delegatedChildResponse.body).toBe(201);
    const delegatedChild = delegatedChildResponse.json().agent;
    const delegatedChildGrant = await app.inject({
      method: "POST",
      url: `/api/agents/${delegatedChild.id}/graph/relationships`,
      payload: {
        sourceId: `agent:${delegatedChild.id}`,
        targetId: "asset:staging-config",
        relation: "CAN_WRITE",
      },
    });
    expect(delegatedChildGrant.statusCode, delegatedChildGrant.body).toBe(201);

    const genericRun = await service.createManagedActionRun(
      demoAgents.releaseGuardian.id,
      "Prove a stopped delegated child cannot act",
      principal,
    );
    const delegatedChildRecord = await app.inject({
      method: "POST",
      url: `/api/runs/${genericRun.id}/delegations`,
      payload: {
        childAgentId: delegatedChild.id,
        scope: [{ capability: "CAN_WRITE", targetNodeId: "asset:staging-config" }],
        expiresAt: "2027-08-31T08:00:00.000Z",
        reason: "Bounded generic-route lifecycle regression",
      },
    });
    expect(delegatedChildRecord.statusCode, delegatedChildRecord.body).toBe(201);
    const delegationId = delegatedChildRecord.json().delegation.id as string;
    const stoppedDelegatedChild = await app.inject({
      method: "POST",
      url: `/api/agents/${delegatedChild.id}/stop`,
    });
    expect(stoppedDelegatedChild.statusCode, stoppedDelegatedChild.body).toBe(200);

    const invocationsBeforeStoppedDelegation = adapter.invocationCount;
    const claimsBeforeStoppedDelegation = database.connection.prepare(
      "SELECT COUNT(*) AS count FROM policy_action_claims",
    ).get() as { count: number };
    const receiptsBeforeStoppedDelegation = database.connection.prepare(
      "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
    ).get() as { count: number };
    const stateBeforeStoppedDelegation = await security.getManagedResourceState(
      "asset:staging-config",
    );
    const stoppedDelegatedAction = await app.inject({
      method: "POST",
      url: `/api/runs/${genericRun.id}/actions`,
      payload: {
        operationId: "generic:stopped-delegated-child",
        capability: "CAN_WRITE",
        targetNodeId: "asset:staging-config",
        payload: { content: "must not write after the delegated child stops" },
        delegationId,
      },
    });
    expect(stoppedDelegatedAction.statusCode, stoppedDelegatedAction.body).toBe(409);
    expect(stoppedDelegatedAction.json().error).toMatch(/stopped.*not eligible to act/i);
    expect(adapter.invocationCount).toBe(invocationsBeforeStoppedDelegation);
    expect(await security.getManagedResourceState("asset:staging-config")).toEqual(
      stateBeforeStoppedDelegation,
    );
    expect(database.connection.prepare(
      "SELECT COUNT(*) AS count FROM policy_action_claims",
    ).get()).toEqual(claimsBeforeStoppedDelegation);
    expect(database.connection.prepare(
      "SELECT COUNT(*) AS count FROM managed_resource_action_receipts",
    ).get()).toEqual(receiptsBeforeStoppedDelegation);
    expect(await policy.getDecisionByOperation("generic:stopped-delegated-child")).toBeNull();
    await service.finishManagedActionRun(
      genericRun.id,
      "failed",
      "Stopped delegated child prevented the generic action",
    );

    // RBAC must also protect the authority configuration itself. Otherwise a
    // viewer could add a CAN_READ/OWNS edge and manufacture permission before
    // entering the otherwise-correct managed action pipeline.
    // Simulate a durable role downgrade without changing the process-local
    // principal object. Graph configuration must consult the authoritative
    // identity row instead of trusting stale startup state.
    await security.upsertPrincipal({ ...principal, role: "viewer" });
    const viewerGraphMutation = await app.inject({
      method: "POST",
      url: "/api/graph/nodes",
      payload: {
        type: "asset",
        label: "Viewer-created privilege target",
        classification: "internal",
      },
    });
    expect(viewerGraphMutation.statusCode, viewerGraphMutation.body).toBe(403);
    expect(viewerGraphMutation.json()).toMatchObject({
      error: expect.stringMatching(/only an administrator/i),
    });
    expect((await graphStore.getAllNodes()).some((node) =>
      node.label === "Viewer-created privilege target")).toBe(false);

    const agentIdsBeforeViewerProbes = service.listAgents().map((agent) => agent.id).sort();
    const releaseStatusBeforeViewerProbes = service.getAgent(demoAgents.releaseGuardian.id).status;
    const viewerControlPlaneMutations = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { name: "Viewer-created Agent" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/agents/${demoAgents.releaseGuardian.id}`,
        payload: { description: "Viewer changed this" },
      }),
      app.inject({ method: "POST", url: `/api/agents/${demoAgents.releaseGuardian.id}/start` }),
      app.inject({ method: "POST", url: `/api/agents/${demoAgents.releaseGuardian.id}/stop` }),
      app.inject({ method: "DELETE", url: `/api/agents/${demoAgents.releaseGuardian.id}` }),
      app.inject({
        method: "POST",
        url: `/api/agents/${demoAgents.releaseGuardian.id}/messages`,
        payload: { content: "Viewer must not start Agent work" },
      }),
      app.inject({
        method: "POST",
        url: `/api/agents/${demoAgents.releaseGuardian.id}/circuit-breaker/reset`,
        payload: { reason: "Viewer must not reset safety state" },
      }),
      app.inject({
        method: "POST",
        url: "/api/policy/approvals/approval:not-real/approve",
        payload: { reason: "Viewer must not approve" },
      }),
    ]);
    for (const response of viewerControlPlaneMutations) {
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(service.listAgents().map((agent) => agent.id).sort()).toEqual(agentIdsBeforeViewerProbes);
    expect(service.getAgent(demoAgents.releaseGuardian.id).status).toBe(releaseStatusBeforeViewerProbes);
    const breakerAtClose = await security.getBreaker(demoAgents.releaseGuardian.id);
    await app.close();

    const reopened = new MiddlewareDatabase(databasePath);
    await reopened.initialize();
    const reopenedSecurity = new SqliteSecurityStore(reopened);
    const reopenedTimeline = new SqliteRunTimelineStore(reopened);
    const reopenedJson = new JsonStore(path.join(root, "data", "launchpad.json"));
    await reopenedJson.initialize();
    expect(reopenedJson.snapshot().agents.find((agent) =>
      agent.id === createdAgent.id)).toMatchObject({ status: "stopped" });
    expect((await new SqliteGraphStore(reopened).getOutgoingEdges(
      `agent:${createdAgent.id}`,
    )).some((edge) =>
      edge.relation === "CAN_READ" && edge.targetId === "asset:alice-private-records"))
      .toBe(true);
    expect(reopened.connection.prepare(
      "SELECT run_id FROM managed_resource_action_receipts WHERE run_id=?",
    ).get(createdOwnedRunId)).toEqual({ run_id: createdOwnedRunId });
    expect(reopened.connection.prepare(
      "SELECT run_id FROM managed_resource_action_receipts WHERE run_id=?",
    ).get(createdForeignRunId)).toBeUndefined();
    expect(await reopenedSecurity.getBreaker(demoAgents.releaseGuardian.id)).toMatchObject({
      state: breakerAtClose.state,
      version: breakerAtClose.version,
    });
    expect((await reopenedTimeline.list(resetBody.run.id)).map((event) => event.type)).toEqual([
      "RUN_CREATED", "RUN_STARTED", "CIRCUIT_BREAKER_TRANSITIONED", "RUN_COMPLETED",
    ]);
    reopened.close();
  });
});
