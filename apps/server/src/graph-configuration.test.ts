import { describe, expect, it } from "vitest";
import { createUnconfiguredAgentNode } from "./demo-graph.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";

const agentId = "5b4d8100-97c8-4c7f-8c8c-4cf49d9fb5eb";

describe("GraphConfigurationService", () => {
  it("infers asset risk from classification and exposes the whole graph catalog", async () => {
    const store = new InMemoryGraphStore([createUnconfiguredAgentNode(agentId, "Release Agent")]);
    const configuration = new GraphConfigurationService(store);

    const asset = await configuration.createNode({
      type: "asset",
      label: "Restricted ledger",
      classification: "restricted",
    });

    expect(asset).toMatchObject({
      riskLevel: "critical",
      riskWeight: 10,
      metadata: { riskSource: "classification-default" },
    });
    await configuration.createRelationship(agentId, {
      sourceId: `agent:${agentId}`,
      targetId: asset.id,
      relation: "CAN_READ",
    });
    const duplicate = await configuration.createRelationship(agentId, {
      sourceId: `agent:${agentId}`,
      targetId: asset.id,
      relation: "CAN_READ",
    });

    await expect(configuration.getCatalog()).resolves.toMatchObject({
      nodes: [{ id: `agent:${agentId}` }, { id: asset.id }],
      edges: [{ id: duplicate.id }],
    });
  });

  it("builds an explicit permission and impact path without inferring facts", async () => {
    const store = new InMemoryGraphStore([createUnconfiguredAgentNode(agentId, "Release Agent")]);
    const configuration = new GraphConfigurationService(store);

    const config = await configuration.createNode({
      type: "asset", label: "Deployment configuration", riskLevel: "medium", riskWeight: 4,
      classification: "internal", metadata: { kind: "configuration" },
    });
    const production = await configuration.createNode({
      type: "asset", label: "Production service", riskLevel: "high", riskWeight: 7,
      classification: "confidential", metadata: { kind: "service" },
    });
    const customers = await configuration.createNode({
      type: "asset", label: "Customer dataset", riskLevel: "critical", riskWeight: 10,
      classification: "restricted", metadata: { kind: "dataset" },
    });
    const pii = await configuration.createNode({
      type: "data_category", label: "PII", riskLevel: "low", riskWeight: 0,
      classification: "restricted", metadata: { code: "pii" },
    });

    await configuration.createRelationship(agentId, {
      sourceId: `agent:${agentId}`, targetId: config.id, relation: "CAN_WRITE",
    });
    await configuration.createRelationship(agentId, {
      sourceId: config.id, targetId: production.id, relation: "DEPLOYS_TO",
    });
    await configuration.createRelationship(agentId, {
      sourceId: production.id, targetId: customers.id, relation: "PROCESSES",
    });
    await configuration.createRelationship(agentId, {
      sourceId: customers.id, targetId: pii.id, relation: "CONTAINS",
    });

    await expect(new KnowledgeGraphService(store).calculateBlastRadius(agentId)).resolves.toMatchObject({
      score: 21,
      decision: "REVIEW_REQUIRED",
    });
  });

  it("rejects a downstream relationship until its source is connected to the Agent", async () => {
    const store = new InMemoryGraphStore([createUnconfiguredAgentNode(agentId, "New Agent")]);
    const configuration = new GraphConfigurationService(store);
    const source = await configuration.createNode({
      type: "asset", label: "Unconnected config", riskLevel: "low", riskWeight: 0,
      classification: "internal",
    });
    const target = await configuration.createNode({
      type: "asset", label: "Production service", riskLevel: "high", riskWeight: 7,
      classification: "confidential",
    });

    await expect(configuration.createRelationship(agentId, {
      sourceId: source.id, targetId: target.id, relation: "DEPLOYS_TO",
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});
