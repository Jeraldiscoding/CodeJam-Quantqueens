import { describe, expect, it } from "vitest";
import { InMemoryGraphStore } from "./in-memory-graph-store.js";
import { KnowledgeGraphError, KnowledgeGraphService } from "./knowledge-graph.js";
import type { GraphEdge, GraphNode } from "./graph-types.js";

const agentId = "2a53b5e4-b334-4e10-b91f-ae1e24775567";
const timestamp = "2026-08-29T10:00:00.000Z";

function node(
  id: string,
  type: GraphNode["type"],
  label: string,
  riskWeight = 0,
): GraphNode {
  return {
    id,
    type,
    label,
    riskLevel: riskWeight >= 10 ? "critical" : riskWeight >= 7 ? "high" : "low",
    riskWeight,
    classification: riskWeight >= 10 ? "restricted" : "internal",
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  relation: GraphEdge["relation"],
  status: GraphEdge["status"] = "authorized",
): GraphEdge {
  return { id, sourceId, targetId, relation, status, metadata: {}, createdAt: timestamp };
}

function makeGraph(extraEdges: readonly GraphEdge[] = []): InMemoryGraphStore {
  const agent = `agent:${agentId}`;
  const config = "asset:deployment-config";
  const service = "asset:production-service";
  const dataset = "asset:customer-dataset";
  return new InMemoryGraphStore(
    [
      node("human:alice", "human", "Alice"),
      node(agent, "agent", "Release Agent"),
      node(config, "asset", "Deployment configuration", 4),
      node(service, "asset", "Production service", 7),
      node(dataset, "asset", "Customer dataset", 10),
      node("data_category:pii", "data_category", "PII"),
    ],
    [
      edge("edge-owns", "human:alice", agent, "OWNS"),
      edge("edge-can-write", agent, config, "CAN_WRITE"),
      edge("edge-deploys", config, service, "DEPLOYS_TO"),
      edge("edge-processes", service, dataset, "PROCESSES"),
      edge("edge-contains", dataset, "data_category:pii", "CONTAINS"),
      ...extraEdges,
    ],
  );
}

describe("KnowledgeGraphService", () => {
  it("returns the multi-hop impact path and scores each asset once", async () => {
    const graph = new KnowledgeGraphService(makeGraph());

    const result = await graph.calculateBlastRadius(agentId);

    expect(result.score).toBe(21);
    expect(result.decision).toBe("REVIEW_REQUIRED");
    expect(result.targets.map((target) => target.node.id)).toEqual([
      "asset:deployment-config",
      "asset:production-service",
      "asset:customer-dataset",
    ]);
    expect(result.paths.at(-1)).toEqual({
      nodeIds: [
        `agent:${agentId}`,
        "asset:deployment-config",
        "asset:production-service",
        "asset:customer-dataset",
      ],
      edgeIds: ["edge-can-write", "edge-deploys", "edge-processes"],
    });
  });

  it("keeps ownership and audit evidence out of impact scoring", async () => {
    const graph = new KnowledgeGraphService(
      makeGraph([
        edge(
          "edge-denied",
          `agent:${agentId}`,
          "asset:customer-dataset",
          "DENIED",
          "denied",
        ),
      ]),
    );

    const result = await graph.getAgentGraph(agentId);
    const blastRadius = await graph.calculateBlastRadius(agentId);

    expect(result.owners.map((owner) => owner.label)).toEqual(["Alice"]);
    expect(result.activity.denied.map((item) => item.id)).toEqual(["edge-denied"]);
    expect(blastRadius.score).toBe(21);
  });

  it("does not double-count an asset when an impact graph contains a cycle", async () => {
    const graph = new KnowledgeGraphService(
      makeGraph([
        edge(
          "edge-cycle",
          "asset:customer-dataset",
          "asset:deployment-config",
          "DEPLOYS_TO",
        ),
      ]),
    );

    await expect(graph.calculateBlastRadius(agentId)).resolves.toMatchObject({ score: 21 });
  });

  it("does not double-count a target reached by multiple direct capabilities", async () => {
    const graph = new KnowledgeGraphService(
      makeGraph([
        edge(
          "edge-can-read-config",
          `agent:${agentId}`,
          "asset:deployment-config",
          "CAN_READ",
        ),
      ]),
    );

    const result = await graph.calculateBlastRadius(agentId);
    expect(result.score).toBe(21);
    expect(result.targets.map((target) => target.node.id)).toEqual([
      "asset:deployment-config",
      "asset:production-service",
      "asset:customer-dataset",
    ]);
  });

  it("rejects a missing Agent graph node", async () => {
    const graph = new KnowledgeGraphService(makeGraph());

    await expect(graph.getAgentGraph("b4cd7c1a-d20c-4af0-a66a-fdb0855ae3ef")).rejects.toEqual(
      new KnowledgeGraphError(
        "GRAPH_AGENT_NOT_FOUND",
        "Graph Agent b4cd7c1a-d20c-4af0-a66a-fdb0855ae3ef was not found",
      ),
    );
  });
});
