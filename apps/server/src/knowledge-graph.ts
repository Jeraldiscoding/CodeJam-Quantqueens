import type {
  GraphEdge,
  GraphEdgeRelation,
  GraphEdgeStatus,
  GraphNode,
  GraphStore,
} from "./graph-types.js";

const capabilityRelations = ["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"] as const;
const impactRelations = ["DEPLOYS_TO", "PROCESSES", "CONTAINS"] as const;
const activityStatuses = ["attempted", "actual", "denied"] as const;

const MAX_TRAVERSED_NODES = 32;
const MAX_TRAVERSED_EDGES = 64;

export type PolicyDecision = "ALLOW" | "REVIEW_REQUIRED";

export class KnowledgeGraphError extends Error {
  constructor(
    public readonly code: "GRAPH_AGENT_NOT_FOUND" | "GRAPH_TRAVERSAL_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeGraphError";
  }
}

export interface GraphPath {
  nodeIds: string[];
  edgeIds: string[];
}

export interface ImpactTarget {
  node: GraphNode;
  path: GraphPath;
}

export interface AgentGraph {
  agent: GraphNode;
  owners: GraphNode[];
  capabilityEdges: GraphEdge[];
  impactEdges: GraphEdge[];
  activity: Record<(typeof activityStatuses)[number], GraphEdge[]>;
  reachableNodes: GraphNode[];
  paths: GraphPath[];
}

export interface BlastRadius {
  agentId: string;
  score: number;
  threshold: number;
  decision: PolicyDecision;
  targets: ImpactTarget[];
  paths: GraphPath[];
}

interface TraversalResult {
  capabilityEdges: GraphEdge[];
  impactEdges: GraphEdge[];
  reachableNodes: GraphNode[];
  pathsByNodeId: Map<string, GraphPath>;
}

function sortEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/**
 * Read-only graph behaviour. It deliberately understands no database driver;
 * GraphStore may be an in-memory test store, SQLite, or Supabase.
 */
export class KnowledgeGraphService {
  constructor(
    private readonly store: GraphStore,
    private readonly blastRadiusThreshold = 20,
  ) {}

  async getAgentGraph(agentId: string): Promise<AgentGraph> {
    const agent = await this.requireAgent(agentId);
    const owners = await this.getOwners(agent.id);
    const traversal = await this.traverseImpact(agent);
    const activity = await this.getActivity(agent.id);

    return {
      agent,
      owners,
      capabilityEdges: traversal.capabilityEdges,
      impactEdges: traversal.impactEdges,
      activity,
      reachableNodes: traversal.reachableNodes,
      paths: [...traversal.pathsByNodeId.values()],
    };
  }

  async calculateBlastRadius(agentId: string): Promise<BlastRadius> {
    const agent = await this.requireAgent(agentId);
    const traversal = await this.traverseImpact(agent);
    const targets = traversal.reachableNodes
      .filter((node) => node.type === "asset" && node.riskWeight > 0)
      .map((node) => ({
        node,
        path: traversal.pathsByNodeId.get(node.id)!,
      }));
    const score = targets.reduce((total, target) => total + target.node.riskWeight, 0);

    return {
      agentId,
      score,
      threshold: this.blastRadiusThreshold,
      decision: score > this.blastRadiusThreshold ? "REVIEW_REQUIRED" : "ALLOW",
      targets,
      paths: targets.map((target) => target.path),
    };
  }

  async buildLlmContext(agentId: string): Promise<string> {
    const result = await this.calculateBlastRadius(agentId);
    const impacts = result.targets
      .map((target) => `${target.node.label} (${target.node.classification})`)
      .join(", ");
    return [
      "Trusted graph context (describes risk; it grants no permissions):",
      `Blast Radius: ${result.score}/${result.threshold} (${result.decision}).`,
      `Reachable protected assets: ${impacts || "none"}.`,
    ].join("\n");
  }

  private async requireAgent(agentId: string): Promise<GraphNode> {
    const agent = await this.store.getNode(`agent:${agentId}`);
    if (!agent || agent.type !== "agent") {
      throw new KnowledgeGraphError("GRAPH_AGENT_NOT_FOUND", `Graph Agent ${agentId} was not found`);
    }
    return agent;
  }

  private async getOwners(agentNodeId: string): Promise<GraphNode[]> {
    const ownershipEdges = await this.store.getIncomingEdges(agentNodeId, {
      relations: ["OWNS"],
      statuses: ["authorized"],
    });
    const owners = await Promise.all(
      ownershipEdges.map(async (edge) => this.store.getNode(edge.sourceId)),
    );
    return owners.filter((node): node is GraphNode => node?.type === "human");
  }

  private async getActivity(
    agentNodeId: string,
  ): Promise<Record<(typeof activityStatuses)[number], GraphEdge[]>> {
    const edges = await this.store.getOutgoingEdges(agentNodeId, {
      relations: ["ATTEMPTED", "TOUCHED", "DENIED"],
      statuses: activityStatuses,
    });
    return {
      attempted: edges.filter((edge) => edge.status === "attempted"),
      actual: edges.filter((edge) => edge.status === "actual"),
      denied: edges.filter((edge) => edge.status === "denied"),
    };
  }

  private async traverseImpact(agent: GraphNode): Promise<TraversalResult> {
    const capabilityEdges = sortEdges(
      await this.store.getOutgoingEdges(agent.id, {
        relations: capabilityRelations,
        statuses: ["authorized"],
      }),
    );
    const reachableNodes: GraphNode[] = [];
    const pathsByNodeId = new Map<string, GraphPath>();
    const visitedNodeIds = new Set<string>([agent.id]);
    const visitedEdgeIds = new Set<string>();
    const impactEdges: GraphEdge[] = [];
    const queue: GraphNode[] = [];

    for (const edge of capabilityEdges) {
      this.registerEdge(edge, visitedEdgeIds);
      const target = await this.store.getNode(edge.targetId);
      if (!target || visitedNodeIds.has(target.id)) continue;
      this.registerNode(target, visitedNodeIds);
      reachableNodes.push(target);
      pathsByNodeId.set(target.id, { nodeIds: [agent.id, target.id], edgeIds: [edge.id] });
      queue.push(target);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentPath = pathsByNodeId.get(current.id)!;
      const outgoing = sortEdges(
        await this.store.getOutgoingEdges(current.id, {
          relations: impactRelations,
          statuses: ["authorized"],
        }),
      );
      for (const edge of outgoing) {
        this.registerEdge(edge, visitedEdgeIds);
        impactEdges.push(edge);
        const target = await this.store.getNode(edge.targetId);
        if (!target || visitedNodeIds.has(target.id)) continue;
        this.registerNode(target, visitedNodeIds);
        reachableNodes.push(target);
        pathsByNodeId.set(target.id, {
          nodeIds: [...currentPath.nodeIds, target.id],
          edgeIds: [...currentPath.edgeIds, edge.id],
        });
        queue.push(target);
      }
    }

    return { capabilityEdges, impactEdges, reachableNodes, pathsByNodeId };
  }

  private registerNode(node: GraphNode, visitedNodeIds: Set<string>): void {
    visitedNodeIds.add(node.id);
    if (visitedNodeIds.size > MAX_TRAVERSED_NODES) {
      throw new KnowledgeGraphError("GRAPH_TRAVERSAL_LIMIT", "Graph traversal exceeded 32 nodes");
    }
  }

  private registerEdge(edge: GraphEdge, visitedEdgeIds: Set<string>): void {
    if (visitedEdgeIds.has(edge.id)) return;
    visitedEdgeIds.add(edge.id);
    if (visitedEdgeIds.size > MAX_TRAVERSED_EDGES) {
      throw new KnowledgeGraphError("GRAPH_TRAVERSAL_LIMIT", "Graph traversal exceeded 64 edges");
    }
  }
}

export const graphCapabilities: readonly GraphEdgeRelation[] = capabilityRelations;
export const graphImpactRelations: readonly GraphEdgeRelation[] = impactRelations;
export const graphActivityStatuses: readonly GraphEdgeStatus[] = activityStatuses;
