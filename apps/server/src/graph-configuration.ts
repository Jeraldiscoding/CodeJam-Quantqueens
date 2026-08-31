import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.js";
import type { GraphEdge, GraphEdgeRelation, GraphNode, GraphStore } from "./graph-types.js";
import { graphCapabilities } from "./knowledge-graph.js";
import type { GraphObservation, KnowledgeObservationStore } from "./knowledge-observation.js";
import {
  analyzePromptIntent,
  inferPromptCapability,
  inferPromptClassification,
  inferPromptResource,
  type PromptIntentAnalysis,
} from "./prompt-intelligence.js";
import type { CapabilityRelation } from "./policy-store.js";

const impactRelations = new Set<GraphEdgeRelation>(["DEPLOYS_TO", "PROCESSES", "CONTAINS"]);
const editableRelations = new Set<GraphEdgeRelation>([
  "OWNS",
  ...graphCapabilities,
  ...impactRelations,
]);

export interface CreateGraphNodeInput {
  type: "human" | "asset" | "data_category";
  label: string;
  riskLevel?: GraphNode["riskLevel"] | undefined;
  riskWeight?: number | undefined;
  classification: GraphNode["classification"];
  metadata?: Record<string, unknown> | undefined;
}

export interface CreateGraphRelationshipInput {
  sourceId: string;
  targetId: string;
  relation: GraphEdgeRelation;
}

export interface PromptGraphSuggestion {
  existingNodeId: string | null;
  label: string;
  capability: CapabilityRelation;
  classification: GraphNode["classification"];
  rationale: string;
}

export interface PromptGraphAnalysis extends PromptIntentAnalysis {
  suggestions: PromptGraphSuggestion[];
}

export interface ConfirmPromptGraphSuggestionInput {
  existingNodeId?: string | undefined;
  label: string;
  capability: CapabilityRelation;
  classification: GraphNode["classification"];
}

const slug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "node";

const inferredRiskByClassification: Record<
  GraphNode["classification"],
  { riskLevel: GraphNode["riskLevel"]; riskWeight: number }
> = {
  public: { riskLevel: "low", riskWeight: 0 },
  internal: { riskLevel: "low", riskWeight: 2 },
  confidential: { riskLevel: "high", riskWeight: 7 },
  restricted: { riskLevel: "critical", riskWeight: 10 },
};

export function inferNodeRisk(
  type: CreateGraphNodeInput["type"],
  classification: GraphNode["classification"],
): { riskLevel: GraphNode["riskLevel"]; riskWeight: number } {
  if (type !== "asset") return { riskLevel: "low", riskWeight: 0 };
  return inferredRiskByClassification[classification];
}

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
  constructor(
    private readonly store: GraphStore,
    private readonly observations?: KnowledgeObservationStore,
  ) {}

  async getCatalog(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; observations: GraphObservation[] }> {
    const [nodes, edges, observations] = await Promise.all([
      this.store.getAllNodes(),
      this.store.getAllEdges(),
      this.observations?.getAll() ?? Promise.resolve([]),
    ]);
    return { nodes, edges, observations };
  }

  async analyzePrompt(agentId: string, prompt: string): Promise<PromptGraphAnalysis> {
    const agentNodeId = `agent:${agentId}`;
    const agent = await this.store.getNode(agentNodeId);
    if (!agent || agent.type !== "agent") throw new HttpError(404, "Graph Agent not found");

    const intent = analyzePromptIntent(prompt);
    if (intent.intent === "informational") return { ...intent, suggestions: [] };

    const assets = (await this.store.getAllNodes()).filter((node) => node.type === "asset");
    const mentioned = this.findMentionedAsset(prompt, assets);
    const inferred = inferPromptResource(prompt);
    if (!mentioned && !inferred) return { ...intent, suggestions: [] };

    const target = mentioned ?? null;
    const capability = inferPromptCapability(prompt);
    if (target) {
      const alreadyConnected = (await this.store.getOutgoingEdges(agentNodeId, {
        relations: [capability],
        statuses: ["authorized"],
      })).some((edge) => edge.targetId === target.id);
      if (alreadyConnected) return { ...intent, suggestions: [] };
    }

    const label = target?.label ?? inferred!.label;
    return {
      ...intent,
      suggestions: [{
        existingNodeId: target?.id ?? null,
        label,
        capability,
        classification: target?.classification ?? inferPromptClassification(label, prompt),
        rationale: target
          ? `The prompt refers to the existing ${target.label} asset and implies ${capability.replace("CAN_", "").toLowerCase()} access.`
          : inferred!.rationale,
      }],
    };
  }

  async confirmPromptSuggestion(
    agentId: string,
    input: ConfirmPromptGraphSuggestionInput,
  ): Promise<{ node: GraphNode; edge: GraphEdge }> {
    const existingByLabel = (await this.store.getAllNodes()).find(
      (node) => node.type === "asset" && node.label.toLowerCase() === input.label.trim().toLowerCase(),
    );
    const node = input.existingNodeId
      ? await this.store.getNode(input.existingNodeId)
      : existingByLabel ?? await this.createNode({
          type: "asset",
          label: input.label,
          classification: input.classification,
          metadata: { inferenceSource: "confirmed-prompt" },
        });
    if (!node || node.type !== "asset") throw new HttpError(400, "The suggested resource must be an asset");
    const edge = await this.createRelationship(agentId, {
      sourceId: `agent:${agentId}`,
      targetId: node.id,
      relation: input.capability,
    });
    return { node, edge };
  }

  async createNode(input: CreateGraphNodeInput): Promise<GraphNode> {
    const metadata = input.metadata ?? {};
    validateMetadata(metadata);
    const inferred = inferNodeRisk(input.type, input.classification);
    const riskWasInferred = input.riskLevel === undefined || input.riskWeight === undefined;
    const timestamp = new Date().toISOString();
    const node: GraphNode = {
      id: `${input.type}:${slug(input.label)}-${randomUUID().slice(0, 8)}`,
      type: input.type,
      label: input.label.trim(),
      riskLevel: input.riskLevel ?? inferred.riskLevel,
      riskWeight: input.riskWeight ?? inferred.riskWeight,
      classification: input.classification,
      metadata: riskWasInferred
        ? { ...metadata, riskSource: "classification-default" }
        : metadata,
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
    const existing = (await this.store.getOutgoingEdges(source.id, {
      relations: [input.relation],
      statuses: ["authorized"],
    })).find((edge) => edge.targetId === target.id);
    if (existing) return existing;
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

  private findMentionedAsset(prompt: string, assets: GraphNode[]): GraphNode | null {
    const normalized = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    const generic = new Set(["api", "service", "system", "data", "file", "files"]);
    return [...assets]
      .sort((left, right) => right.label.length - left.label.length)
      .find((asset) => {
        const label = asset.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (normalized.includes(label)) return true;
        const distinctive = label.split(" ").filter((token) => token.length >= 4 && !generic.has(token));
        return distinctive.length > 0 && distinctive.every((token) => normalized.includes(token));
      }) ?? null;
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
