import { describe, expect, it } from "vitest";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { demoAgents } from "./demo-graph.js";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";

const unconfiguredAgentId = "5b4d8100-97c8-4c7f-8c8c-4cf49d9fb5eb";

describe("DemoAgentGraphProvisioner", () => {
  it("creates the Release Guardian demo graph and is safe to repeat", async () => {
    const store = new InMemoryGraphStore();
    const provisioner = new DemoAgentGraphProvisioner(store);

    await provisioner.provisionAgent(demoAgents.releaseGuardian);
    await provisioner.provisionAgent(demoAgents.releaseGuardian);

    const graph = new KnowledgeGraphService(store);
    await expect(graph.calculateBlastRadius(demoAgents.releaseGuardian.id)).resolves.toMatchObject({
      score: 21,
      decision: "REVIEW_REQUIRED",
    });
    await expect(store.getOutgoingEdges(`agent:${demoAgents.releaseGuardian.id}`)).resolves.toMatchObject([
      { relation: "CAN_CALL", targetId: "asset:release-api" },
      { relation: "CAN_WRITE", targetId: "asset:deployment-config" },
    ]);
  });

  it("starts a newly created Agent with identity only and no inferred relationships", async () => {
    const store = new InMemoryGraphStore();
    const provisioner = new DemoAgentGraphProvisioner(store);
    const graph = new KnowledgeGraphService(store);

    await provisioner.provisionAgent({ id: unconfiguredAgentId, name: "New Agent" });

    await expect(store.getNode(`agent:${unconfiguredAgentId}`)).resolves.toMatchObject({
      type: "agent",
      label: "New Agent",
      metadata: { agentId: unconfiguredAgentId },
    });
    await expect(store.getOutgoingEdges(`agent:${unconfiguredAgentId}`)).resolves.toEqual([]);
    await expect(graph.getAgentGraph(unconfiguredAgentId)).resolves.toMatchObject({
      owners: [],
      capabilityEdges: [],
      impactEdges: [],
      reachableNodes: [],
      paths: [],
    });
    await expect(graph.calculateBlastRadius(unconfiguredAgentId)).resolves.toMatchObject({
      score: 0,
      decision: "ALLOW",
    });
  });
});
