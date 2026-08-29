import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { GraphEdge, GraphEdgeRelation, GraphNode, GraphStore } from "./graph-types.js";
import { graphCapabilities } from "./knowledge-graph.js";

const impactRelations = new Set<GraphEdgeRelation>(["DEPLOYS_TO", "PROCESSES", "CONTAINS"]);
const editableRelations = new Set<GraphEdgeRelation>([
  "OWNS",
  ...graphCapabilities,
  ...impactRelations,
]);

export interface CreateGraphNodeInput {
  type: "human" | "asset" | "data_category";
  label: string;
  riskLevel: GraphNode["riskLevel"];
  riskWeight: number;
  classification: GraphNode["classification"];
  metadata?: Record<string, unknown> | undefined;
}

export interface CreateGraphRelationshipInput {
  sourceId: string;
  targetId: string;
  relation: GraphEdgeRelation;
}

const slug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "node";

function validateMetadata(metadata: Record<string, unknown>): void {
  const unsafeKey = Object.keys(metadata).find((key) =>
    /(secret|token|password|credential|api.?key)/i.test(key),
  );
  if (unsafeKey) {
    throw new HttpError(400, `Metadata field ${unsafeKey} looks like a secret and is not allowed`);
  }
}

/**
 * Writes explicit, validated graph facts. It never infers authority from a
 * prompt and it limits an Agent editor to that Agent's connected subgraph.
 */
export class GraphConfigurationService {
  constructor(private readonly store: GraphStore) {}

  async createNode(input: CreateGraphNodeInput): Promise<GraphNode> {
    const metadata = input.metadata ?? {};
    validateMetadata(metadata);
    const timestamp = new Date().toISOString();
    const node: GraphNode = {
      id: `${input.type}:${slug(input.label)}-${randomUUID().slice(0, 8)}`,
      type: input.type,
      label: input.label.trim(),
      riskLevel: input.riskLevel,
      riskWeight: input.riskWeight,
      classification: input.classification,
      metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.createNode(node);
    return node;
  }

  async createRelationship(
    agentId: string,
    input: CreateGraphRelationshipInput,
  ): Promise<GraphEdge> {
    if (!editableRelations.has(input.relation)) {
      throw new HttpError(400, `${input.relation} cannot be configured manually`);
    }
    const agentNodeId = `agent:${agentId}`;
    const [agent, source, target] = await Promise.all([
      this.store.getNode(agentNodeId),
      this.store.getNode(input.sourceId),
      this.store.getNode(input.targetId),
    ]);
    if (!agent || agent.type !== "agent") throw new HttpError(404, "Graph Agent not found");
    if (!source || !target) throw new HttpError(404, "Both relationship nodes must exist");

    await this.assertRelationshipIsAllowed(agentNodeId, source, target, input.relation);
    const edge: GraphEdge = {
      id: `edge:${randomUUID()}`,
      sourceId: source.id,
      targetId: target.id,
      relation: input.relation,
      status: "authorized",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    await this.store.createEdge(edge);
    return edge;
  }

  private async assertRelationshipIsAllowed(
    agentNodeId: string,
    source: GraphNode,
    target: GraphNode,
    relation: GraphEdgeRelation,
  ): Promise<void> {
    if (relation === "OWNS") {
      if (source.type !== "human" || target.id !== agentNodeId) {
        throw new HttpError(400, "OWNS must connect a human to the selected Agent");
      }
      return;
    }

    if (graphCapabilities.includes(relation as (typeof graphCapabilities)[number])) {
      if (source.id !== agentNodeId || target.type !== "asset") {
        throw new HttpError(400, "A capability must connect the selected Agent directly to an asset");
      }
      return;
    }

    if (relation === "CONTAINS") {
      if (source.type !== "asset" || target.type !== "data_category") {
        throw new HttpError(400, "CONTAINS must connect an asset to a data category");
      }
    } else if (source.type !== "asset" || target.type !== "asset") {
      throw new HttpError(400, `${relation} must connect one asset to another asset`);
    }

    const reachable = await this.reachableFrom(agentNodeId);
    if (!reachable.has(source.id)) {
      throw new HttpError(
        400,
        "The relationship source must already be connected to this Agent. Add its direct permission or upstream relationship first.",
      );
    }
  }

  private async reachableFrom(agentNodeId: string): Promise<Set<string>> {
    const reachable = new Set<string>([agentNodeId]);
    const queue = [agentNodeId];
    while (queue.length > 0) {
      const sourceId = queue.shift()!;
      const edges = await this.store.getOutgoingEdges(sourceId, {
        relations: [...graphCapabilities, "DEPLOYS_TO", "PROCESSES", "CONTAINS"],
        statuses: ["authorized"],
      });
      for (const edge of edges) {
        if (reachable.has(edge.targetId)) continue;
        reachable.add(edge.targetId);
        queue.push(edge.targetId);
      }
    }
    return reachable;
  }
}
