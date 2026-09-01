import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./graph-types.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { extractRelationshipCandidates, KnowledgeObservationService } from "./knowledge-observation.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteKnowledgeObservationStore } from "./sqlite-knowledge-observation-store.js";

const openDatabases: MiddlewareDatabase[] = [];
const directories: string[] = [];
const timestamp = "2026-08-31T12:00:00.000Z";

afterEach(async () => {
  for (const database of openDatabases.splice(0).reverse()) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const node = (id: string, type: GraphNode["type"], label: string): GraphNode => ({
  id, type, label, riskLevel: "low", riskWeight: 0, classification: "internal",
  metadata: {}, createdAt: timestamp, updatedAt: timestamp,
});

describe("knowledge observations", () => {
  it("extracts explicit semantic relationships without inferring permission", () => {
    expect(extractRelationshipCandidates(
      "Checkout API reads from Orders database. Orders database contains customer emails.",
      "prompt",
    )).toMatchObject([
      { sourceLabel: "Checkout API", targetLabel: "Orders database", relation: "READS_FROM" },
      { sourceLabel: "Orders database", targetLabel: "Customer emails", relation: "CONTAINS" },
    ]);
  });

  it("extracts natural model phrasing with articles and explanatory clauses", () => {
    expect(extractRelationshipCandidates(
      "The Checkout API calls the Fraud Service as part of validating incoming purchase transactions.\nThe Fraud Service processes customer records to run identity and risk checks before a checkout is completed.",
      "run_output",
    )).toMatchObject([
      { sourceLabel: "Checkout API", targetLabel: "Fraud Service", relation: "CALLS" },
      { sourceLabel: "Fraud Service", targetLabel: "Customer records", relation: "PROCESSES" },
    ]);
  });

  it("quarantines pending evidence, reuses nodes, and only affects risk after confirmation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-observation-test-"));
    directories.push(root);
    const database = new MiddlewareDatabase(path.join(root, "middleware.db"));
    openDatabases.push(database);
    await database.initialize();
    const graphStore = new SqliteGraphStore(database);
    const observationStore = new SqliteKnowledgeObservationStore(database);
    const learner = new KnowledgeObservationService(graphStore, observationStore);
    const agent = node("agent:test-agent", "agent", "Test Agent");
    const checkout = node("asset:checkout-api", "asset", "Checkout API");
    await graphStore.createNode(agent);
    await graphStore.createNode(checkout);
    const permission: GraphEdge = {
      id: "edge:can-call-checkout", sourceId: agent.id, targetId: checkout.id,
      relation: "CAN_CALL", status: "authorized", metadata: {}, createdAt: timestamp,
    };
    await graphStore.createEdge(permission);

    const learned = await learner.observeText({
      agentId: "test-agent",
      runId: "run:test",
      sourceKind: "prompt",
      text: "Checkout API reads from customer Orders database.",
    });
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ relation: "READS_FROM", state: "observed", sourceNodeId: checkout.id });
    expect((await graphStore.getAllEdges()).filter((edge) => edge.relation.startsWith("CAN_"))).toEqual([permission]);

    const graph = new KnowledgeGraphService(graphStore, 20, observationStore);
    await expect(graph.calculateBlastRadius("test-agent")).resolves.toMatchObject({ score: 0 });
    await learner.resolve("test-agent", learned[0]!.id, "confirmed");
    await expect(graph.calculateBlastRadius("test-agent")).resolves.toMatchObject({ score: 10 });
    await learner.resolve("test-agent", learned[0]!.id, "rejected");
    await expect(graph.calculateBlastRadius("test-agent")).resolves.toMatchObject({ score: 0 });
  });

  it("keeps learned relationships scoped to the Agent that observed them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-observation-isolation-test-"));
    directories.push(root);
    const database = new MiddlewareDatabase(path.join(root, "middleware.db"));
    openDatabases.push(database);
    await database.initialize();
    const graphStore = new SqliteGraphStore(database);
    const observationStore = new SqliteKnowledgeObservationStore(database);
    const learner = new KnowledgeObservationService(graphStore, observationStore);
    const agentA = node("agent:agent-a", "agent", "Agent A");
    const agentB = node("agent:agent-b", "agent", "Agent B");
    const checkout = node("asset:shared-checkout-api", "asset", "Checkout API");
    await graphStore.createNode(agentA);
    await graphStore.createNode(agentB);
    await graphStore.createNode(checkout);
    for (const agent of [agentA, agentB]) {
      await graphStore.createEdge({
        id: `edge:${agent.id}:can-call-checkout`,
        sourceId: agent.id,
        targetId: checkout.id,
        relation: "CAN_CALL",
        status: "authorized",
        metadata: {},
        createdAt: timestamp,
      });
    }

    const [observation] = await learner.observeText({
      agentId: "agent-a",
      runId: "run:agent-a",
      sourceKind: "prompt",
      text: "Checkout API reads from customer Orders database.",
    });

    const graph = new KnowledgeGraphService(graphStore, 20, observationStore);
    await expect(graph.calculateBlastRadius("agent-a")).resolves.toMatchObject({ score: 0 });
    await expect(graph.calculateBlastRadius("agent-b")).resolves.toMatchObject({ score: 0 });
    await learner.resolve("agent-a", observation!.id, "confirmed");
    await expect(graph.calculateBlastRadius("agent-a")).resolves.toMatchObject({ score: 10 });
    await expect(graph.calculateBlastRadius("agent-b")).resolves.toMatchObject({ score: 0 });
  });
});
