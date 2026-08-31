import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./graph-types.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";

const createdAt = "2026-08-30T01:00:00.000Z";
const later = "2026-08-30T01:01:00.000Z";

let root: string;
let filePath: string;
let database: MiddlewareDatabase;
let store: SqliteGraphStore;
const openDatabases: MiddlewareDatabase[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "launchpad-sqlite-graph-test-"));
  filePath = path.join(root, "middleware.db");
  database = new MiddlewareDatabase(filePath);
  openDatabases.push(database);
  await database.initialize();
  store = new SqliteGraphStore(database);
});

afterEach(async () => {
  for (const item of openDatabases.splice(0).reverse()) item.close();
  await rm(root, { recursive: true, force: true });
});

function node(
  id: string,
  type: GraphNode["type"],
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    label: id,
    riskLevel: "low",
    riskWeight: 0,
    classification: "internal",
    metadata: {},
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function edge(
  id: string,
  sourceId: string,
  targetId: string,
  relation: GraphEdge["relation"],
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    id,
    sourceId,
    targetId,
    relation,
    status: "authorized",
    metadata: {},
    createdAt,
    ...overrides,
  };
}

async function seedNodes(): Promise<{
  human: GraphNode;
  agent: GraphNode;
  assetA: GraphNode;
  assetB: GraphNode;
  category: GraphNode;
}> {
  const fixtures = {
    human: node("human:alice", "human"),
    agent: node("agent:test", "agent"),
    assetA: node("asset:alpha", "asset", { riskWeight: 4 }),
    assetB: node("asset:beta", "asset", { riskWeight: 7 }),
    category: node("data_category:pii", "data_category", {
      classification: "restricted",
    }),
  };
  for (const fixture of Object.values(fixtures)) await store.createNode(fixture);
  return fixtures;
}

async function reopen(): Promise<void> {
  database.close();
  database = new MiddlewareDatabase(filePath);
  openDatabases.push(database);
  await database.initialize();
  store = new SqliteGraphStore(database);
}

describe("SqliteGraphStore", () => {
  it("creates, reads, and upserts nodes while preserving identity and creation time", async () => {
    const original = node("agent:builder", "agent", {
      label: "Builder",
      metadata: { owner: { team: "platform" }, scopes: ["read", "write"] },
    });
    await store.createNode(original);

    await expect(store.getNode(original.id)).resolves.toEqual(original);
    await expect(store.getNode("agent:missing")).resolves.toBeNull();
    await expect(store.createNode(original)).rejects.toMatchObject({ code: "CONFLICT" });

    const updated: GraphNode = {
      ...original,
      label: "Release Builder",
      riskLevel: "high",
      riskWeight: 9,
      classification: "confidential",
      metadata: { owner: { team: "release" } },
      createdAt: later,
      updatedAt: later,
    };
    await store.upsertNode(updated);
    const expected = { ...updated, createdAt: original.createdAt };
    await expect(store.getNode(original.id)).resolves.toEqual(expected);

    const detached = await store.getNode(original.id);
    (detached!.metadata.owner as { team: string }).team = "mutated outside the store";
    await expect(store.getNode(original.id)).resolves.toEqual(expected);

    await expect(
      store.upsertNode({ ...updated, type: "asset" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const insertedByUpsert = node("asset:inserted-by-upsert", "asset");
    await store.upsertNode(insertedByUpsert);
    await reopen();
    await expect(store.getNode(original.id)).resolves.toEqual(expected);
    await expect(store.getNode(insertedByUpsert.id)).resolves.toEqual(insertedByUpsert);
  });

  it("queries edges by direction, Run, filters, and deterministic creation order", async () => {
    const { human, agent, assetA, assetB } = await seedNodes();
    const edges = [
      edge("edge:z-can-write", agent.id, assetA.id, "CAN_WRITE"),
      edge("edge:a-can-read", agent.id, assetB.id, "CAN_READ"),
      edge("edge:owns", human.id, agent.id, "OWNS"),
      edge("edge:owns-asset", human.id, assetA.id, "OWNS"),
      edge("edge:impact", assetA.id, assetB.id, "DEPLOYS_TO", { createdAt: later }),
      edge("edge:b-denied", agent.id, assetA.id, "DENIED", {
        status: "denied",
        runId: "run:one",
        createdAt: later,
      }),
      edge("edge:a-attempted", agent.id, assetA.id, "ATTEMPTED", {
        status: "attempted",
        runId: "run:one",
        createdAt: later,
      }),
    ];
    for (const fixture of edges) await store.createEdge(fixture);

    await expect(store.getAllNodes()).resolves.toHaveLength(5);
    await expect(store.getAllEdges()).resolves.toHaveLength(edges.length);

    await expect(store.getOutgoingEdges(agent.id)).resolves.toMatchObject([
      { id: "edge:a-can-read" },
      { id: "edge:z-can-write" },
      { id: "edge:a-attempted" },
      { id: "edge:b-denied" },
    ]);
    await expect(store.getIncomingEdges(agent.id)).resolves.toMatchObject([
      { id: "edge:owns" },
    ]);
    await expect(store.getIncomingEdges(assetA.id, {
      relations: ["OWNS"],
      statuses: ["authorized"],
    })).resolves.toMatchObject([{ id: "edge:owns-asset", sourceId: human.id }]);
    await expect(
      store.getOutgoingEdges(agent.id, {
        relations: ["CAN_WRITE", "DENIED"],
        statuses: ["authorized", "denied"],
      }),
    ).resolves.toMatchObject([{ id: "edge:z-can-write" }, { id: "edge:b-denied" }]);
    await expect(
      store.getOutgoingEdges(agent.id, { relations: [] }),
    ).resolves.toEqual([]);
    await expect(
      store.getOutgoingEdges(agent.id, { statuses: [] }),
    ).resolves.toEqual([]);
    await expect(store.getEdgesForRun("run:one")).resolves.toMatchObject([
      { id: "edge:a-attempted" },
      { id: "edge:b-denied" },
    ]);

    const authorized = await store.getOutgoingEdges(agent.id, {
      relations: ["CAN_READ"],
    });
    expect(Object.hasOwn(authorized[0]!, "runId")).toBe(false);

    await expect(store.createEdge(edges[0]!)).rejects.toMatchObject({ code: "CONFLICT" });
    await store.upsertEdge({ ...edges[0]!, createdAt: later });
    await expect(
      store.upsertEdge({ ...edges[0]!, targetId: assetB.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await reopen();
    await expect(store.getEdgesForRun("run:one")).resolves.toMatchObject([
      { id: "edge:a-attempted", runId: "run:one" },
      { id: "edge:b-denied", runId: "run:one" },
    ]);
    await expect(store.getOutgoingEdges(assetA.id)).resolves.toMatchObject([
      { id: "edge:impact" },
    ]);
  });

  it("rejects unsafe nodes, malformed edges, and unsupported filters without partial writes", async () => {
    const { human, agent, assetA, assetB } = await seedNodes();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalidNodes: GraphNode[] = [
      node("asset:bad-weight", "asset", { riskWeight: 101 }),
      node("asset:bad-type", "service" as GraphNode["type"]),
      node("asset:bad-time", "asset", { createdAt: "not-a-time" }),
      node("asset:backwards-time", "asset", { updatedAt: "2026-08-29T23:59:59.000Z" }),
      node("asset:secret", "asset", { metadata: { nested: { api_key: "do-not-store" } } }),
      node("asset:not-json", "asset", { metadata: circular }),
    ];
    for (const invalid of invalidNodes) {
      await expect(store.createNode(invalid)).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(store.getNode(invalid.id)).resolves.toBeNull();
    }

    const invalidEdges: GraphEdge[] = [
      edge("edge:missing-target", agent.id, "asset:missing", "CAN_READ"),
      edge("edge:wrong-source", human.id, assetA.id, "CAN_WRITE"),
      edge("edge:wrong-owner-source", agent.id, assetA.id, "OWNS"),
      edge("edge:audit-without-run", agent.id, assetA.id, "ATTEMPTED", {
        status: "attempted",
      }),
      edge("edge:authorized-with-run", agent.id, assetA.id, "CAN_READ", {
        runId: "run:unexpected",
      }),
      edge("edge:wrong-impact-target", assetA.id, agent.id, "DEPLOYS_TO"),
      edge("edge:secret-metadata", agent.id, assetB.id, "CAN_READ", {
        metadata: { authToken: "do-not-store" },
      }),
    ];
    for (const invalid of invalidEdges) {
      await expect(store.createEdge(invalid)).rejects.toMatchObject({ code: "VALIDATION" });
    }

    await expect(
      store.getOutgoingEdges(agent.id, {
        relations: ["CAN_DELETE" as GraphEdge["relation"]],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.getOutgoingEdges(" ")).rejects.toMatchObject({ code: "VALIDATION" });

    const edgeCount = database.connection
      .prepare("SELECT COUNT(*) AS count FROM graph_edges")
      .get() as { count: number };
    expect(edgeCount.count).toBe(0);
  });
});
