import type {
  GraphEdge,
  GraphEdgeRelation,
  GraphEdgeStatus,
  GraphNode,
  GraphStore,
} from "./graph-types.js";
import { canonicalize, sha256Hex } from "./policy-hash.js";
import type { CapabilityRelation } from "./policy-store.js";
import type { GraphObservation, KnowledgeObservationStore } from "./knowledge-observation.js";

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
  observationEdges: GraphObservation[];
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

/**
 * The impact of one specific permitted action, rather than everything the
 * Agent can reach. The Resource Gateway scores this narrower surface so that a
 * low-risk action is not blocked by an unrelated high-risk capability.
 */
export interface ActionImpact {
  agent: GraphNode;
  target: GraphNode;
  capabilityEdge: GraphEdge;
  score: number;
  targets: ImpactTarget[];
}

interface TraversalResult {
  capabilityEdges: GraphEdge[];
  impactEdges: GraphEdge[];
  observationEdges: GraphObservation[];
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
    private readonly observations?: KnowledgeObservationStore,
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
      observationEdges: traversal.observationEdges,
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

  /**
   * Lists the exact direct capabilities an Agent holds. Nothing here is
   * inferred: only stored, authorized Agent-to-asset permission edges count.
   */
  async listCapabilities(agentId: string): Promise<GraphEdge[]> {
    const agent = await this.requireAgent(agentId);
    return sortEdges(
      await this.store.getOutgoingEdges(agent.id, {
        relations: capabilityRelations,
        statuses: ["authorized"],
      }),
    );
  }

  /**
   * Scores one protected action. Returns null when the Agent holds no exact
   * authorized capability of that relation to that asset; proximity in the
   * graph never substitutes for the permission itself.
   */
  async calculateActionImpact(
    agentId: string,
    capability: CapabilityRelation,
    targetNodeId: string,
  ): Promise<ActionImpact | null> {
    const agent = await this.requireAgent(agentId);
    const capabilityEdge = sortEdges(
      await this.store.getOutgoingEdges(agent.id, {
        relations: [capability],
        statuses: ["authorized"],
      }),
    ).find((edge) => edge.targetId === targetNodeId);
    if (!capabilityEdge) return null;

    const target = await this.store.getNode(targetNodeId);
    if (!target || target.type !== "asset") return null;

    const reachable: GraphNode[] = [target];
    const pathsByNodeId = new Map<string, GraphPath>([
      [target.id, { nodeIds: [agent.id, target.id], edgeIds: [capabilityEdge.id] }],
    ]);
    const visitedNodeIds = new Set<string>([agent.id, target.id]);
    const visitedEdgeIds = new Set<string>([capabilityEdge.id]);
    const queue: GraphNode[] = [target];

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
        const next = await this.store.getNode(edge.targetId);
        if (!next || visitedNodeIds.has(next.id)) continue;
        this.registerNode(next, visitedNodeIds);
        reachable.push(next);
        pathsByNodeId.set(next.id, {
          nodeIds: [...currentPath.nodeIds, next.id],
          edgeIds: [...currentPath.edgeIds, edge.id],
        });
        queue.push(next);
      }
      const inferred = await this.observations?.getOutgoing(
        agent.id,
        current.id,
        ["observed", "confirmed"],
      ) ?? [];
      for (const observation of inferred) {
        this.registerEdge(observation, visitedEdgeIds);
        const next = await this.store.getNode(observation.targetNodeId);
        if (!next || visitedNodeIds.has(next.id)) continue;
        this.registerNode(next, visitedNodeIds);
        reachable.push(next);
        pathsByNodeId.set(next.id, {
          nodeIds: [...currentPath.nodeIds, next.id],
          edgeIds: [...currentPath.edgeIds, observation.id],
        });
        queue.push(next);
      }
    }

    const targets = reachable
      .filter((node) => node.type === "asset" && node.riskWeight > 0)
      .map((node) => ({ node, path: pathsByNodeId.get(node.id)! }));

    return {
      agent,
      target,
      capabilityEdge,
      score: targets.reduce((total, item) => total + item.node.riskWeight, 0),
      targets,
    };
  }

  /**
   * A content hash of the Agent's authorized subgraph. An approval is bound to
   * this value, so editing a permission or an asset's risk weight invalidates
   * any approval that was granted against the older topology.
   */
  async getAgentGraphRevision(agentId: string): Promise<string> {
    const graph = await this.getAgentGraph(agentId);
    const byId = (left: { id: string }, right: { id: string }) =>
      left.id.localeCompare(right.id);
    return sha256Hex(
      canonicalize({
        agentNodeId: graph.agent.id,
        owners: graph.owners.map((owner) => owner.id).sort(),
        nodes: [graph.agent, ...graph.reachableNodes]
          .map((node) => ({
            id: node.id,
            type: node.type,
            riskWeight: node.riskWeight,
            classification: node.classification,
          }))
          .sort(byId),
        edges: [...graph.capabilityEdges, ...graph.impactEdges]
          .map((edge) => ({
            id: edge.id,
            sourceId: edge.sourceId,
            targetId: edge.targetId,
            relation: edge.relation,
          }))
          .sort(byId),
        observations: graph.observationEdges
          .map((observation) => ({
            id: observation.id,
            sourceNodeId: observation.sourceNodeId,
            targetNodeId: observation.targetNodeId,
            relation: observation.relation,
            state: observation.state,
            confidence: observation.confidence,
          }))
          .sort(byId),
      }),
    );
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
    const observationEdges: GraphObservation[] = [];
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
      const inferred = await this.observations?.getOutgoing(
        agent.id,
        current.id,
        ["observed", "confirmed"],
      ) ?? [];
      for (const observation of inferred) {
        this.registerEdge(observation, visitedEdgeIds);
        observationEdges.push(observation);
        const target = await this.store.getNode(observation.targetNodeId);
        if (!target || visitedNodeIds.has(target.id)) continue;
        this.registerNode(target, visitedNodeIds);
        reachableNodes.push(target);
        pathsByNodeId.set(target.id, {
          nodeIds: [...currentPath.nodeIds, target.id],
          edgeIds: [...currentPath.edgeIds, observation.id],
        });
        queue.push(target);
      }
    }

    return { capabilityEdges, impactEdges, observationEdges, reachableNodes, pathsByNodeId };
  }

  private registerNode(node: GraphNode, visitedNodeIds: Set<string>): void {
    visitedNodeIds.add(node.id);
    if (visitedNodeIds.size > MAX_TRAVERSED_NODES) {
      throw new KnowledgeGraphError("GRAPH_TRAVERSAL_LIMIT", "Graph traversal exceeded 32 nodes");
    }
  }

  private registerEdge(edge: { id: string }, visitedEdgeIds: Set<string>): void {
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
