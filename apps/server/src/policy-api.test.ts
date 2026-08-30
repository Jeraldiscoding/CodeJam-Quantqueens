import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { PolicyService } from "./policy-service.js";
import { DemoResourceAdapter, ResourceGateway } from "./resource-gateway.js";
import { KnowledgeGraphRunPolicyGate } from "./run-policy-gate.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Counts how many times the Agent runtime was actually reached. */
class CountingRunner implements AgentRunner {
  public calls = 0;
  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls += 1;
    return { output: `Completed: ${request.prompt}`, threadId: "thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function makeServer(
  environment: NodeJS.ProcessEnv = {},
  runner = new CountingRunner(),
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-policy-api-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });

  const database = new MiddlewareDatabase(path.join(root, "data", "middleware.db"));
  await database.initialize();
  const graphStore = new SqliteGraphStore(database);
  const governance = new SqliteGovernanceStore(database);
  const graph = new KnowledgeGraphService(graphStore, config.policyReviewThreshold);
  const graphConfiguration = new GraphConfigurationService(graphStore);
  const policy = new PolicyService(graph, graphStore, governance, {
    reviewThreshold: config.policyReviewThreshold,
    denyThreshold: config.policyDenyThreshold,
    approvalTtlMs: config.policyApprovalTtlMs,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "launchpad.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    new DemoAgentGraphProvisioner(graphStore),
    new KnowledgeGraphRunPolicyGate(graph, policy),
  );
  await service.initialize();
  const gateway = new ResourceGateway(
    policy,
    graphStore,
    service,
    new DemoResourceAdapter(),
  );
  const app = await createApp(config, service, graph, graphConfiguration, policy, gateway);
  app.addHook("onClose", () => database.close());
  return { app, service, graph, graphStore, policy, runner };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

/** Gives the Agent CAN_WRITE on a config that deploys to a restricted dataset. */
async function configureHighRiskAgent(
  app: Awaited<ReturnType<typeof makeServer>>["app"],
  agentId: string,
) {
  const createNode = async (body: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/api/graph/nodes", payload: body });
    expect(response.statusCode).toBe(201);
    return response.json().node.id as string;
  };
  const link = async (sourceId: string, targetId: string, relation: string) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/graph/relationships`,
      payload: { sourceId, targetId, relation },
    });
    expect(response.statusCode).toBe(201);
  };

  const config = await createNode({
    type: "asset",
    label: "Deployment configuration",
    classification: "internal",
    riskLevel: "medium",
    riskWeight: 4,
  });
  const production = await createNode({
    type: "asset",
    label: "Production service",
    classification: "confidential",
    riskLevel: "high",
    riskWeight: 7,
  });
  const dataset = await createNode({
    type: "asset",
    label: "Customer dataset",
    classification: "restricted",
    riskLevel: "critical",
    riskWeight: 10,
  });
  await link(`agent:${agentId}`, config, "CAN_WRITE");
  await link(config, production, "DEPLOYS_TO");
  await link(production, dataset, "PROCESSES");
  return { config, production, dataset };
}

describe("Pre-run policy gate", () => {
  it("starts a run normally when the Agent has no configured capability", async () => {
    const { app, service, runner } = await makeServer();
    const agent = await service.createAgent({ name: "Unconfigured Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Say hello" },
    });
    expect(response.statusCode).toBe(202);
    await settle();

    const run = service.getRun(response.json().run.id);
    expect(run.status).toBe("completed");
    expect(run.policy?.reasonCode).toBe("NO_PROTECTED_CAPABILITY");
    expect(runner.calls).toBe(1);
    await app.close();
  });

  it("pauses a high blast radius run before the runner is ever called", async () => {
    const { app, service, runner } = await makeServer();
    const agent = await service.createAgent({ name: "Release Guardian" });
    await configureHighRiskAgent(app, agent.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Deploy the release" },
    });
    const runId = response.json().run.id as string;
    await settle();

    const run = service.getRun(runId);
    expect(run.status).toBe("awaiting_approval");
    expect(run.policy?.result).toBe("REVIEW_REQUIRED");
    expect(run.policy?.riskScore).toBe(21);
    // The whole point: the Agent runtime never started.
    expect(runner.calls).toBe(0);

    // The Agent is free again, but cannot start a second run while paused.
    expect(service.getAgent(agent.id).status).toBe("ready");
    const blocked = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Try again" },
    });
    expect(blocked.statusCode).toBe(409);
    await app.close();
  });

  it("resumes a paused run exactly once after approval", async () => {
    const { app, service, runner } = await makeServer();
    const agent = await service.createAgent({ name: "Release Guardian" });
    await configureHighRiskAgent(app, agent.id);

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Deploy the release" },
    });
    const runId = started.json().run.id as string;
    await settle();

    const queue = await app.inject({ method: "GET", url: "/api/policy/approvals" });
    expect(queue.statusCode).toBe(200);
    const approvals = queue.json().approvals as Array<{
      approvalRequest: { id: string };
      decision: { runId: string; riskScore: number };
    }>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.decision.runId).toBe(runId);

    const approved = await app.inject({
      method: "POST",
      url: `/api/policy/approvals/${approvals[0]!.approvalRequest.id}/approve`,
      payload: { reason: "Release window is open" },
    });
    expect(approved.statusCode).toBe(200);

    const resumed = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume` });
    expect(resumed.statusCode).toBe(200);
    await settle();

    expect(service.getRun(runId).status).toBe("completed");
    expect(runner.calls).toBe(1);

    // The claim is single use, so the run cannot be replayed.
    const replay = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume` });
    expect(replay.statusCode).toBe(409);
    expect(runner.calls).toBe(1);
    await app.close();
  });

  it("ends the run when a reviewer rejects it", async () => {
    const { app, service, runner } = await makeServer();
    const agent = await service.createAgent({ name: "Release Guardian" });
    await configureHighRiskAgent(app, agent.id);

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Deploy the release" },
    });
    const runId = started.json().run.id as string;
    await settle();

    const queue = await app.inject({ method: "GET", url: "/api/policy/approvals" });
    const approvalId = queue.json().approvals[0].approvalRequest.id as string;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/policy/approvals/${approvalId}/reject`,
      payload: { reason: "Change freeze" },
    });
    expect(rejected.statusCode).toBe(200);

    const run = service.getRun(runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/rejected/i);
    expect(runner.calls).toBe(0);

    const resumeAttempt = await app.inject({ method: "POST", url: `/api/runs/${runId}/resume` });
    expect(resumeAttempt.statusCode).toBe(409);
    await app.close();
  });

  it("denies a run whose blast radius passes the deny threshold", async () => {
    const { app, service, runner } = await makeServer({ POLICY_DENY_THRESHOLD: "20" });
    const agent = await service.createAgent({ name: "Over-permissioned Agent" });
    await configureHighRiskAgent(app, agent.id);

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Deploy the release" },
    });
    const runId = started.json().run.id as string;
    await settle();

    const run = service.getRun(runId);
    expect(run.status).toBe("failed");
    expect(run.policy?.result).toBe("DENY");
    expect(run.error).toMatch(/deny threshold/);
    expect(runner.calls).toBe(0);

    const decisions = await app.inject({ method: "GET", url: `/api/runs/${runId}/policy` });
    expect(decisions.json().decisions[0].decision.result).toBe("DENY");
    await app.close();
  });
});

describe("Resource Gateway API", () => {
  it("refuses a protected action the Agent has no capability for", async () => {
    const { app, service } = await makeServer();
    const agent = await service.createAgent({ name: "Release Guardian" });
    const { production } = await configureHighRiskAgent(app, agent.id);

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Deploy the release" },
    });
    const runId = started.json().run.id as string;
    await settle();

    // The Agent can reach production downstream but holds no direct CAN_WRITE.
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: {
        operationId: "op:direct-production-write",
        capability: "CAN_WRITE",
        targetNodeId: production,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().decision.reasonCode).toBe("NO_DIRECT_CAPABILITY");

    const graph = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/graph` });
    const denied = graph.json().graph.activity.denied as Array<{ targetId: string }>;
    expect(denied.some((item) => item.targetId === production)).toBe(true);
    await app.close();
  });
});
