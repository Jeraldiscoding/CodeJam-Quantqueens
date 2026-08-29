import type { EdgeFilter, GraphEdge, GraphNode, GraphStore } from "./graph-types.js";

const byCreation = <T extends { createdAt: string; id: string }>(left: T, right: T) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

function matches(edge: GraphEdge, filter?: EdgeFilter): boolean {
  return (
    (!filter?.relations || filter.relations.includes(edge.relation)) &&
    (!filter?.statuses || filter.statuses.includes(edge.status))
  );
}

/** Test and demo adapter. Jerome's persistent GraphStore replaces this without changing graph logic. */
export class InMemoryGraphStore implements GraphStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  constructor(nodes: readonly GraphNode[] = [], edges: readonly GraphEdge[] = []) {
    nodes.forEach((node) => this.nodes.set(node.id, structuredClone(node)));
    edges.forEach((edge) => this.edges.set(edge.id, structuredClone(edge)));
  }

  async getNode(id: string): Promise<GraphNode | null> {
    const node = this.nodes.get(id);
    return node ? structuredClone(node) : null;
  }

  async getOutgoingEdges(sourceId: string, filter?: EdgeFilter): Promise<GraphEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.sourceId === sourceId && matches(edge, filter))
      .sort(byCreation)
      .map((edge) => structuredClone(edge));
  }

  async getIncomingEdges(targetId: string, filter?: EdgeFilter): Promise<GraphEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.targetId === targetId && matches(edge, filter))
      .sort(byCreation)
      .map((edge) => structuredClone(edge));
  }

  async getEdgesForRun(runId: string): Promise<GraphEdge[]> {
    return [...this.edges.values()]
      .filter((edge) => edge.runId === runId)
      .sort(byCreation)
      .map((edge) => structuredClone(edge));
  }

  async createNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, structuredClone(node));
  }

  async createEdge(edge: GraphEdge): Promise<void> {
    this.edges.set(edge.id, structuredClone(edge));
  }

  async upsertNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, structuredClone(node));
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    this.edges.set(edge.id, structuredClone(edge));
  }
}
