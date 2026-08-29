import type { JsonStore } from "./store.js";
import type { EdgeFilter, GraphEdge, GraphNode, GraphStore } from "./graph-types.js";

const byCreation = <T extends { createdAt: string; id: string }>(left: T, right: T) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

const matches = (edge: GraphEdge, filter?: EdgeFilter) =>
  (!filter?.relations || filter.relations.includes(edge.relation)) &&
  (!filter?.statuses || filter.statuses.includes(edge.status));

/**
 * Local persistent GraphStore for the current app. A Supabase implementation
 * can replace this adapter without changing graph traversal or API behaviour.
 */
export class JsonGraphStore implements GraphStore {
  constructor(private readonly store: JsonStore) {}

  async getNode(id: string): Promise<GraphNode | null> {
    return this.store.snapshot().graphNodes.find((node) => node.id === id) ?? null;
  }

  async getOutgoingEdges(sourceId: string, filter?: EdgeFilter): Promise<GraphEdge[]> {
    return this.store.snapshot().graphEdges
      .filter((edge) => edge.sourceId === sourceId && matches(edge, filter))
      .sort(byCreation);
  }

  async getIncomingEdges(targetId: string, filter?: EdgeFilter): Promise<GraphEdge[]> {
    return this.store.snapshot().graphEdges
      .filter((edge) => edge.targetId === targetId && matches(edge, filter))
      .sort(byCreation);
  }

  async getEdgesForRun(runId: string): Promise<GraphEdge[]> {
    return this.store.snapshot().graphEdges
      .filter((edge) => edge.runId === runId)
      .sort(byCreation);
  }

  async createNode(node: GraphNode): Promise<void> {
    await this.store.mutate((database) => {
      if (database.graphNodes.some((item) => item.id === node.id)) {
        throw new Error(`Graph node ${node.id} already exists`);
      }
      database.graphNodes.push(structuredClone(node));
    });
  }

  async createEdge(edge: GraphEdge): Promise<void> {
    await this.store.mutate((database) => {
      if (database.graphEdges.some((item) => item.id === edge.id)) {
        throw new Error(`Graph edge ${edge.id} already exists`);
      }
      database.graphEdges.push(structuredClone(edge));
    });
  }

  async upsertNode(node: GraphNode): Promise<void> {
    await this.store.mutate((database) => {
      const index = database.graphNodes.findIndex((item) => item.id === node.id);
      if (index < 0) database.graphNodes.push(structuredClone(node));
      else database.graphNodes[index] = structuredClone(node);
    });
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    await this.store.mutate((database) => {
      const index = database.graphEdges.findIndex((item) => item.id === edge.id);
      if (index < 0) database.graphEdges.push(structuredClone(edge));
      else database.graphEdges[index] = structuredClone(edge);
    });
  }
}
