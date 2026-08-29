import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { JsonGraphStore } from "./json-graph-store.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe("Graph configuration API", () => {
  it("persists explicit relationships and returns their calculated blast radius", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-graph-api-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
    });
    const store = new JsonStore(path.join(root, "data", "launchpad.json"));
    const graphStore = new JsonGraphStore(store);
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(path.join(root, "workspaces")),
      createRunner(config),
      new DemoAgentGraphProvisioner(graphStore),
    );
    await service.initialize();
    const app = await createApp(
      config,
      service,
      new KnowledgeGraphService(graphStore),
      new GraphConfigurationService(graphStore),
    );
    const agent = await service.createAgent({ name: "Release Agent" });

    const createNode = async (body: Record<string, unknown>) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/graph/nodes",
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ node: { id: string } }>().node;
    };
    const relate = async (sourceId: string, targetId: string, relation: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${agent.id}/graph/relationships`,
        payload: { sourceId, targetId, relation },
      });
      expect(response.statusCode).toBe(201);
    };

    const deploymentConfig = await createNode({
      type: "asset", label: "Deployment config", riskLevel: "medium", riskWeight: 4,
      classification: "internal", metadata: { kind: "configuration" },
    });
    const production = await createNode({
      type: "asset", label: "Production service", riskLevel: "high", riskWeight: 7,
      classification: "confidential", metadata: { kind: "service" },
    });
    const customers = await createNode({
      type: "asset", label: "Customer dataset", riskLevel: "critical", riskWeight: 10,
      classification: "restricted", metadata: { kind: "dataset" },
    });
    const pii = await createNode({
      type: "data_category", label: "PII", riskLevel: "low", riskWeight: 0,
      classification: "restricted", metadata: { code: "pii" },
    });

    await relate(`agent:${agent.id}`, deploymentConfig.id, "CAN_WRITE");
    await relate(deploymentConfig.id, production.id, "DEPLOYS_TO");
    await relate(production.id, customers.id, "PROCESSES");
    await relate(customers.id, pii.id, "CONTAINS");

    const blastRadius = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/blast-radius`,
    });
    expect(blastRadius.statusCode).toBe(200);
    expect(blastRadius.json()).toMatchObject({
      blastRadius: { score: 21, decision: "REVIEW_REQUIRED" },
    });
    await app.close();
  });
});
