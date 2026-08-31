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
import { KnowledgeObservationService } from "./knowledge-observation.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteKnowledgeObservationStore } from "./sqlite-knowledge-observation-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

class LearningRunner implements AgentRunner {
  async run(): Promise<RunnerResult> {
    return {
      output: "Orders database calls Fraud service.",
      threadId: "thread:learning-test",
      usage: null,
    };
  }
  async cancel(): Promise<boolean> { return false; }
  async isAvailable(): Promise<boolean> { return true; }
}

describe("knowledge observation HTTP lifecycle", () => {
  it("learns from prompt and output, exposes evidence, changes risk, and never grants authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-observation-api-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      SEED_DEMO_DATA: "false",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const database = new MiddlewareDatabase(path.join(root, "data", "middleware.db"));
    await database.initialize();
    const graphStore = new SqliteGraphStore(database);
    const observationStore = new SqliteKnowledgeObservationStore(database);
    const observations = new KnowledgeObservationService(graphStore, observationStore);
    const graph = new KnowledgeGraphService(graphStore, 20, observationStore);
    const configuration = new GraphConfigurationService(graphStore, observationStore);
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "launchpad.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new LearningRunner(),
      new DemoAgentGraphProvisioner(graphStore),
      undefined,
      observations,
    );
    await service.initialize();
    const app = await createApp(
      config,
      service,
      graph,
      configuration,
      undefined,
      undefined,
      observations,
    );
    app.addHook("onClose", () => database.close());

    const agent = await service.createAgent({ name: "Learning Agent" });
    const assetResponse = await app.inject({
      method: "POST",
      url: "/api/graph/nodes",
      payload: { type: "asset", label: "Checkout API", classification: "public" },
    });
    expect(assetResponse.statusCode).toBe(201);
    const checkoutId = assetResponse.json().node.id as string;
    const permissionResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/graph/relationships`,
      payload: {
        sourceId: `agent:${agent.id}`,
        targetId: checkoutId,
        relation: "CAN_CALL",
      },
    });
    expect(permissionResponse.statusCode).toBe(201);

    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/messages`,
      payload: { content: "Checkout API reads from Orders database." },
    });
    expect(messageResponse.statusCode).toBe(202);
    await expect.poll(() => service.getRun(messageResponse.json().run.id).status).toBe("completed");

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/observations`,
    });
    expect(listResponse.statusCode).toBe(200);
    const learned = listResponse.json().observations as Array<{
      id: string;
      relation: string;
      state: string;
      confidence: number;
      sourceKind: string;
      evidence: string;
    }>;
    expect(learned).toHaveLength(2);
    expect(learned).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relation: "READS_FROM",
        state: "observed",
        sourceKind: "prompt",
        evidence: "Checkout API reads from Orders database.",
      }),
      expect.objectContaining({
        relation: "CALLS",
        state: "observed",
        sourceKind: "run_output",
        evidence: "Orders database calls Fraud service.",
      }),
    ]));
    expect(learned.every((observation) => observation.confidence > 0.7)).toBe(true);

    const capabilities = await graph.listCapabilities(agent.id);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({ relation: "CAN_CALL", targetId: checkoutId });
    expect((await graphStore.getAllEdges()).filter((edge) => edge.relation.startsWith("CAN_"))).toHaveLength(1);

    const catalogResponse = await app.inject({ method: "GET", url: "/api/graph" });
    expect(catalogResponse.statusCode).toBe(200);
    expect(catalogResponse.json().graph.observations).toHaveLength(2);
    const agentGraphResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/graph`,
    });
    expect(agentGraphResponse.statusCode).toBe(200);
    expect(agentGraphResponse.json().graph.observationEdges).toHaveLength(2);
    await expect(graph.calculateBlastRadius(agent.id)).resolves.toMatchObject({ score: 4 });

    const readsFrom = learned.find((observation) => observation.relation === "READS_FROM")!;
    const confirmResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/observations/${readsFrom.id}/confirm`,
    });
    expect(confirmResponse.statusCode).toBe(200);
    expect(confirmResponse.json().observation.state).toBe("confirmed");
    await expect(graph.calculateBlastRadius(agent.id)).resolves.toMatchObject({ score: 4 });

    const rejectResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/observations/${readsFrom.id}/reject`,
    });
    expect(rejectResponse.statusCode).toBe(200);
    expect(rejectResponse.json().observation.state).toBe("rejected");
    await expect(graph.calculateBlastRadius(agent.id)).resolves.toMatchObject({ score: 0 });
    expect(await graph.listCapabilities(agent.id)).toHaveLength(1);

    await app.close();
  });
});
