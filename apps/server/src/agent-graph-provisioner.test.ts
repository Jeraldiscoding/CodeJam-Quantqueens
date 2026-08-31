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
      { relation: "CAN_WRITE", targetId: "asset:staging-config" },
      { relation: "CAN_READ", targetId: "asset:alice-private-records" },
    ]);
    await expect(store.getNode("asset:alice-private-records")).resolves.toMatchObject({
      metadata: { ownerId: "human:alice", adapterKind: "managed_state" },
    });
    await expect(store.getNode("asset:bob-private-records")).resolves.toMatchObject({
      metadata: { ownerId: "human:bob", adapterKind: "managed_state" },
    });
    await expect(store.getIncomingEdges("asset:alice-private-records")).resolves.toEqual([
      expect.objectContaining({
        sourceId: "human:alice",
        relation: "OWNS",
      }),
      expect.objectContaining({
        sourceId: `agent:${demoAgents.releaseGuardian.id}`,
        relation: "CAN_READ",
      }),
    ]);
    await expect(store.getIncomingEdges("asset:bob-private-records")).resolves.toEqual([
      expect.objectContaining({ sourceId: "human:bob", relation: "OWNS" }),
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

  it("attaches an optional server-attested owner without granting a capability", async () => {
    const store = new InMemoryGraphStore();
    const provisioner = new DemoAgentGraphProvisioner(store, {
      id: "human:alice",
      label: "Alice",
    });
    const graph = new KnowledgeGraphService(store);

    await provisioner.provisionAgent({ id: unconfiguredAgentId, name: "Owned Agent" });
    await provisioner.provisionAgent({ id: unconfiguredAgentId, name: "Owned Agent" });
    await new DemoAgentGraphProvisioner(store, {
      id: "human:bob",
      label: "Bob",
    }).provisionAgent({ id: unconfiguredAgentId, name: "Owned Agent after restart" });

    await expect(graph.ownersOfAgent(unconfiguredAgentId)).resolves.toMatchObject([
      { id: "human:alice", type: "human" },
    ]);
    await expect(store.getNode("human:bob")).resolves.toBeNull();
    await expect(graph.listCapabilities(unconfiguredAgentId)).resolves.toEqual([]);
    await expect(store.getIncomingEdges(`agent:${unconfiguredAgentId}`)).resolves.toMatchObject([
      {
        sourceId: "human:alice",
        relation: "OWNS",
        status: "authorized",
        metadata: { accountabilityOnly: true },
      },
    ]);
  });
});
