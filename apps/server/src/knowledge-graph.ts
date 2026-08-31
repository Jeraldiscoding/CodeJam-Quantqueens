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
    public readonly code: "GRAPH_AGENT_NOT_FOUND" | "GRAPH_RESOURCE_NOT_FOUND" | "GRAPH_TRAVERSAL_LIMIT",
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

export interface ResourceImpact {
  resource: GraphNode;
  blastRadius: number;
  score: number;
  sensitiveTargets: GraphNode[];
  targets: ImpactTarget[];
}

export interface AffectingAgent {
  agent: GraphNode;
  capabilityEdge: GraphEdge;
  path: GraphPath;
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

  /** Explicit human owners constrain who may operate through this Agent. */
  async ownersOfAgent(agentId: string): Promise<GraphNode[]> {
    const agent = await this.requireAgent(agentId);
    return this.getOwners(agent.id);
  }

  /** Explicit human owners constrain access even when an Agent has a capability. */
  async ownersOfResource(resourceId: string): Promise<GraphNode[]> {
    const resource = await this.store.getNode(resourceId);
    if (!resource || resource.type !== "asset") {
      throw new KnowledgeGraphError(
        "GRAPH_RESOURCE_NOT_FOUND",
        `Graph resource ${resourceId} was not found`,
      );
    }
    return this.getOwners(resource.id);
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

  /** Resources reachable from explicit capabilities plus bounded impact topology. */
  async reachableResources(agentId: string): Promise<ImpactTarget[]> {
    const graph = await this.getAgentGraph(agentId);
    return graph.reachableNodes
      .filter((node) => node.type === "asset")
      .map((node) => ({ node, path: graph.paths.find((path) => path.nodeIds.at(-1) === node.id)! }))
      .sort((left, right) => left.node.id.localeCompare(right.node.id));
  }

  /** Bounded downstream dependency context used directly by risk evaluation. */
  async downstreamDependents(resourceId: string): Promise<ResourceImpact> {
    const resource = await this.store.getNode(resourceId);
    if (!resource || resource.type !== "asset") {
      throw new KnowledgeGraphError("GRAPH_RESOURCE_NOT_FOUND", `Graph resource ${resourceId} was not found`);
    }
    const targets: ImpactTarget[] = [{ node: resource, path: { nodeIds: [resource.id], edgeIds: [] } }];
    const paths = new Map<string, GraphPath>([[resource.id, targets[0]!.path]]);
    const visitedNodes = new Set([resource.id]);
    const visitedEdges = new Set<string>();
    const queue = [resource];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentPath = paths.get(current.id)!;
      const outgoing = sortEdges(await this.store.getOutgoingEdges(current.id, {
        relations: impactRelations,
        statuses: ["authorized"],
      }));
      for (const edge of outgoing) {
        this.registerEdge(edge, visitedEdges);
        const next = await this.store.getNode(edge.targetId);
        if (!next || visitedNodes.has(next.id)) continue;
        this.registerNode(next, visitedNodes);
        const path = { nodeIds: [...currentPath.nodeIds, next.id], edgeIds: [...currentPath.edgeIds, edge.id] };
        paths.set(next.id, path);
        if (next.type === "asset") targets.push({ node: next, path });
        queue.push(next);
      }
    }
    // Keep the requested resource first. Several consumers present the first
    // item as the action target and the remainder as counterfactual downstream
    // impact; sorting the whole array silently turned whichever asset happened
    // to be lexicographically first into the apparent root.
    const orderedTargets = [
      targets[0]!,
      ...targets.slice(1).sort((left, right) => left.node.id.localeCompare(right.node.id)),
    ];
    return {
      resource,
      blastRadius: orderedTargets.length,
      score: orderedTargets.reduce((total, target) => total + target.node.riskWeight, 0),
      sensitiveTargets: orderedTargets.map((target) => target.node)
        .filter((node) => node.classification === "restricted" || node.riskLevel === "critical")
        .sort((left, right) => left.id.localeCompare(right.id)),
      targets: orderedTargets,
    };
  }

  async inboundDependencies(resourceId: string): Promise<GraphEdge[]> {
    const resource = await this.store.getNode(resourceId);
    if (!resource || resource.type !== "asset") {
      throw new KnowledgeGraphError("GRAPH_RESOURCE_NOT_FOUND", `Graph resource ${resourceId} was not found`);
    }
    return sortEdges(await this.store.getIncomingEdges(resourceId, {
      relations: impactRelations,
      statuses: ["authorized"],
    }));
  }

  /** Reverse traversal from a resource to direct Agent capabilities. */
  async agentsAffectingResource(resourceId: string): Promise<AffectingAgent[]> {
    const resource = await this.store.getNode(resourceId);
    if (!resource || resource.type !== "asset") {
      throw new KnowledgeGraphError("GRAPH_RESOURCE_NOT_FOUND", `Graph resource ${resourceId} was not found`);
    }
    const reversePath = new Map<string, GraphPath>([[resource.id, { nodeIds: [resource.id], edgeIds: [] }]]);
    const visitedNodes = new Set([resource.id]);
    const visitedEdges = new Set<string>();
    const queue = [resource];
    const results: AffectingAgent[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const tail = reversePath.get(current.id)!;
      const incoming = sortEdges(await this.store.getIncomingEdges(current.id, {
        relations: [...capabilityRelations, ...impactRelations],
        statuses: ["authorized"],
      }));
      for (const edge of incoming) {
        this.registerEdge(edge, visitedEdges);
        const source = await this.store.getNode(edge.sourceId);
        if (!source) continue;
        if (source.type === "agent" && capabilityRelations.includes(edge.relation as CapabilityRelation)) {
          results.push({
            agent: source,
            capabilityEdge: edge,
            path: { nodeIds: [source.id, ...tail.nodeIds], edgeIds: [edge.id, ...tail.edgeIds] },
          });
          continue;
        }
        if (source.type !== "asset" || visitedNodes.has(source.id)) continue;
        this.registerNode(source, visitedNodes);
        reversePath.set(source.id, { nodeIds: [source.id, ...tail.nodeIds], edgeIds: [edge.id, ...tail.edgeIds] });
        queue.push(source);
      }
    }
    return results.sort((left, right) => left.agent.id.localeCompare(right.agent.id) || left.capabilityEdge.id.localeCompare(right.capabilityEdge.id));
  }

  async relevantAgentResourcePath(agentId: string, resourceId: string): Promise<GraphPath | null> {
    const match = (await this.agentsAffectingResource(resourceId)).find(
      (entry) => entry.agent.id === `agent:${agentId}`,
    );
    return match?.path ?? null;
  }

  async runsRelatedToResource(resourceId: string): Promise<string[]> {
    const edges = await this.store.getIncomingEdges(resourceId, {
      relations: ["ATTEMPTED", "TOUCHED", "DENIED"],
      statuses: activityStatuses,
    });
    return [...new Set(edges.flatMap((edge) => edge.runId ? [edge.runId] : []))].sort();
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
    const resourceOwners = await Promise.all(
      graph.reachableNodes
        .filter((node) => node.type === "asset")
        .sort(byId)
        .map(async (resource) => ({
          resourceId: resource.id,
          ownerIds: (await this.getOwners(resource.id)).map((owner) => owner.id),
        })),
    );
    return sha256Hex(
      canonicalize({
        agentNodeId: graph.agent.id,
        owners: graph.owners.map((owner) => owner.id).sort(),
        resourceOwners,
        nodes: [graph.agent, ...graph.reachableNodes]
          .map((node) => ({
            id: node.id,
            type: node.type,
            riskLevel: node.riskLevel,
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
    return [...new Map(
      owners
        .filter((node): node is GraphNode => node?.type === "human")
        .map((node) => [node.id, node]),
    ).values()].sort((left, right) => left.id.localeCompare(right.id));
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
