import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { BehavioralBaselineService, BehavioralRiskService } from "./behavioral-security.js";
import { loadConfig } from "./config.js";
import { ControlledActionRuntime } from "./controlled-action-runtime.js";
import { DelegationService } from "./delegation-service.js";
import { demoAgents } from "./demo-graph.js";
import { ExecutionIdentityService } from "./execution-identity.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { SqliteManagedResourceAdapter } from "./managed-resource-adapter.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { ModelActionMediator } from "./model-action-mediator.js";
import { PolicyService } from "./policy-service.js";
import { ResourceGateway } from "./resource-gateway.js";
import { KnowledgeGraphRunPolicyGate } from "./run-policy-gate.js";
import { SafetyEvidenceService } from "./safety-evidence.js";
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

class CountingRunner implements AgentRunner {
  calls = 0;
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls += 1;
    const output = request.prompt.includes("<protected_action>")
      ? [
          "I will ask the middleware to update the production deployment configuration.",
          '<protected_action>{"capability":"CAN_WRITE","targetNodeId":"asset:deployment-config","reason":"Apply the requested production release"}</protected_action>',
        ].join("\n")
      : `Codex handled: ${request.prompt}`;
    return { output, threadId: "thread:integrated", usage: null };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

describe("integrated pre-run approval", () => {
  it("approves, consumes, and rejects coarse-gate reviews with production identity evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-integrated-run-gate-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      SEED_DEMO_DATA: "true",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "test-model",
      APP_PRINCIPAL_ID: "human:alice",
      APP_PRINCIPAL_NAME: "Alice",
      APP_PRINCIPAL_ROLE: "admin",
    });
    const database = new MiddlewareDatabase(path.join(root, "data", "middleware.db"));
    await database.initialize();
    const graphStore = new SqliteGraphStore(database);
    const timeline = new SqliteRunTimelineStore(database);
    const security = new SqliteSecurityStore(database);
    const graph = new KnowledgeGraphService(graphStore, config.policyReviewThreshold);
    const graphConfiguration = new GraphConfigurationService(graphStore);
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
    const runGate = new KnowledgeGraphRunPolicyGate(
      graph,
      policy,
      (input) => identities.resolve({ runId: input.runId, principal }),
    );
    const runner = new CountingRunner();
    service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "launchpad.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
      new DemoAgentGraphProvisioner(graphStore, { id: principal.id, label: principal.displayName }),
      runGate,
      undefined,
      timeline,
    );
    await service.initialize();
    const gateway = new ResourceGateway(
      policy,
      graphStore,
      service,
      new SqliteManagedResourceAdapter(security),
      identities,
      timeline,
    );
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

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/messages`,
      payload: { content: "Deploy the release" },
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("awaiting_approval");
    expect(runner.calls).toBe(0);

    const approvalId = service.getRun(runId).policy!.approvalRequestId!;
    const approved = await app.inject({
      method: "POST",
      url: `/api/policy/approvals/${approvalId}/approve`,
      payload: { reason: "Reviewed in the release window" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const resumed = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume` });
    expect(resumed.statusCode, resumed.body).toBe(200);
    await expect.poll(() => service.getRun(runId).status).toBe("completed");
    expect(runner.calls).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/messages`,
      payload: { content: "Deploy the release again" },
    });
    const secondRunId = second.json().run.id as string;
    await expect.poll(() => service.getRun(secondRunId).status).toBe("awaiting_approval");
    const secondApprovalId = service.getRun(secondRunId).policy!.approvalRequestId!;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/policy/approvals/${secondApprovalId}/reject`,
      payload: { reason: "Change freeze" },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(service.getRun(secondRunId)).toMatchObject({ status: "failed" });
    expect(runner.calls).toBe(1);

    const reset = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/circuit-breaker/reset`,
      payload: { reason: "Prepare model-proposal approval test" },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    service.setRuntimeMediator(new ModelActionMediator(graphConfiguration, gateway, principal));

    const modelStarted = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/messages`,
      payload: { content: "Update the production deployment configuration to release 3.0.0." },
    });
    const modelRunId = modelStarted.json().run.id as string;
    await expect.poll(() => service.getRun(modelRunId).status).toBe("awaiting_approval");
    expect(service.getRun(modelRunId).pendingAction).toMatchObject({
      targetNodeId: "asset:deployment-config",
      capability: "CAN_WRITE",
    });
    const modelApprovalId = service.getRun(modelRunId).policy!.approvalRequestId!;
    const modelApproved = await app.inject({
      method: "POST",
      url: `/api/policy/approvals/${modelApprovalId}/approve`,
      payload: { reason: "Production window reviewed" },
    });
    expect(modelApproved.statusCode, modelApproved.body).toBe(200);
    const modelResumed = await app.inject({
      method: "POST",
      url: `/api/runs/${modelRunId}/resume`,
    });
    expect(modelResumed.statusCode, modelResumed.body).toBe(200);
    expect(service.getRun(modelRunId).status).toBe("completed");
    expect(service.getRun(modelRunId).pendingAction).toBeUndefined();
    expect(service.getRun(modelRunId).output).toMatch(/Middleware result: Updated Deployment configuration/i);
    expect(await security.getManagedResourceState("asset:deployment-config")).toMatchObject({
      revision: 1,
      lastOperationId: `model-proposed:${modelRunId}`,
    });

    const modelRejectedStart = await app.inject({
      method: "POST",
      url: `/api/agents/${demoAgents.releaseGuardian.id}/messages`,
      payload: { content: "Update the production deployment configuration to release 3.0.1." },
    });
    const modelRejectedRunId = modelRejectedStart.json().run.id as string;
    await expect.poll(() => service.getRun(modelRejectedRunId).status).toBe("awaiting_approval");
    const rejectedApprovalId = service.getRun(modelRejectedRunId).policy!.approvalRequestId!;
    const modelRejected = await app.inject({
      method: "POST",
      url: `/api/policy/approvals/${rejectedApprovalId}/reject`,
      payload: { reason: "No second production change" },
    });
    expect(modelRejected.statusCode, modelRejected.body).toBe(200);
    expect(service.getRun(modelRejectedRunId).status).toBe("failed");
    expect(service.getRun(modelRejectedRunId).pendingAction).toBeUndefined();
    expect((await security.getManagedResourceState("asset:deployment-config"))?.revision).toBe(1);

    await app.close();
  });
});
