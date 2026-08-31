import { randomUUID } from "node:crypto";
import type { GraphClassification, GraphNode, GraphStore } from "./graph-types.js";
import { inferPromptClassification } from "./prompt-intelligence.js";

export const observationRelations = [
  "DEPLOYS_TO",
  "PROCESSES",
  "CONTAINS",
  "READS_FROM",
  "CALLS",
  "DEPENDS_ON",
] as const;
export type ObservationRelation = (typeof observationRelations)[number];
export type ObservationState = "observed" | "confirmed" | "rejected";
export type ObservationSourceKind = "prompt" | "run_output";

export interface GraphObservation {
  id: string;
  agentNodeId: string;
  runId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: ObservationRelation;
  state: ObservationState;
  confidence: number;
  sourceKind: ObservationSourceKind;
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeObservationStore {
  getAll(): Promise<GraphObservation[]>;
  getForAgent(agentNodeId: string): Promise<GraphObservation[]>;
  getOutgoing(
    agentNodeId: string,
    sourceNodeId: string,
    states?: readonly ObservationState[],
  ): Promise<GraphObservation[]>;
  get(id: string): Promise<GraphObservation | null>;
  upsert(observation: GraphObservation): Promise<GraphObservation>;
  setState(id: string, state: ObservationState, updatedAt: string): Promise<GraphObservation>;
}

interface RelationshipCandidate {
  sourceLabel: string;
  targetLabel: string;
  relation: ObservationRelation;
  evidence: string;
  confidence: number;
}

const resourceSuffix = "(?:api|service|database|dataset|configuration|config|bucket|repository|repo|system|application|app|table|queue|topic|cluster|ledger|files?)";
const resourcePhrase = `([a-z0-9][a-z0-9 _-]{0,70}?${resourceSuffix})`;
const dataPhrase = "([a-z0-9][a-z0-9 _-]{0,70}?(?:data|records?|orders?|emails?|pii|personal information|customer information))";

const patterns: Array<{
  expression: RegExp;
  relation: ObservationRelation;
  confidence: number;
}> = [
  { expression: new RegExp(`\\b${resourcePhrase}\\s+(?:deploys?|is deployed)\\s+(?:to|on)\\s+${resourcePhrase}`, "i"), relation: "DEPLOYS_TO", confidence: 0.9 },
  { expression: new RegExp(`\\bdeploy\\s+${resourcePhrase}\\s+(?:to|on)\\s+${resourcePhrase}`, "i"), relation: "DEPLOYS_TO", confidence: 0.88 },
  { expression: new RegExp(`\\b${resourcePhrase}\\s+(?:reads?|queries?|loads?)\\s+from\\s+${resourcePhrase}`, "i"), relation: "READS_FROM", confidence: 0.9 },
  { expression: new RegExp(`\\b${resourcePhrase}\\s+(?:calls?|invokes?|triggers?)\\s+${resourcePhrase}`, "i"), relation: "CALLS", confidence: 0.86 },
  { expression: new RegExp(`\\b${resourcePhrase}\\s+(?:depends?|relies?)\\s+on\\s+${resourcePhrase}`, "i"), relation: "DEPENDS_ON", confidence: 0.86 },
  { expression: new RegExp(`\\b${resourcePhrase}\\s+(?:processes?|handles?)\\s+${dataPhrase}`, "i"), relation: "PROCESSES", confidence: 0.84 },
  { expression: new RegExp(`\\b${resourcePhrase}\\s+(?:contains?|stores?|holds?)\\s+${dataPhrase}`, "i"), relation: "CONTAINS", confidence: 0.88 },
];

function cleanLabel(value: string): string {
  const cleaned = value
    .replace(/^(?:please|the|a|an|our|my|this|that)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function extractRelationshipCandidates(
  text: string,
  sourceKind: ObservationSourceKind,
): RelationshipCandidate[] {
  const sentences = text.split(/(?<=[.!?\n])\s+/).map((part) => part.trim()).filter(Boolean);
  const candidates: RelationshipCandidate[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    for (const pattern of patterns) {
      const match = sentence.match(pattern.expression);
      if (!match?.[1] || !match[2]) continue;
      const sourceLabel = cleanLabel(match[1]);
      const targetLabel = cleanLabel(match[2]);
      if (sourceLabel.toLowerCase() === targetLabel.toLowerCase()) continue;
      const key = `${sourceLabel.toLowerCase()}|${pattern.relation}|${targetLabel.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        sourceLabel,
        targetLabel,
        relation: pattern.relation,
        evidence: sentence.slice(0, 500),
        confidence: Math.max(0, pattern.confidence - (sourceKind === "run_output" ? 0.08 : 0)),
      });
    }
  }
  return candidates.slice(0, 12);
}

const riskByClassification: Record<GraphClassification, { riskLevel: GraphNode["riskLevel"]; riskWeight: number }> = {
  public: { riskLevel: "low", riskWeight: 0 },
  internal: { riskLevel: "low", riskWeight: 2 },
  confidential: { riskLevel: "high", riskWeight: 7 },
  restricted: { riskLevel: "critical", riskWeight: 10 },
};

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "resource";

export class KnowledgeObservationService {
  constructor(
    private readonly graphStore: GraphStore,
    private readonly observations: KnowledgeObservationStore,
  ) {}

  async observeText(input: {
    agentId: string;
    runId?: string;
    sourceKind: ObservationSourceKind;
    text: string;
  }): Promise<GraphObservation[]> {
    const agentNodeId = `agent:${input.agentId}`;
    if (!(await this.graphStore.getNode(agentNodeId))) return [];
    const results: GraphObservation[] = [];
    for (const candidate of extractRelationshipCandidates(input.text, input.sourceKind)) {
      const source = await this.findOrCreateNode(candidate.sourceLabel, "asset", input, candidate.evidence);
      const targetType = candidate.relation === "CONTAINS" ? "data_category" : "asset";
      const target = await this.findOrCreateNode(candidate.targetLabel, targetType, input, candidate.evidence);
      const timestamp = new Date().toISOString();
      results.push(await this.observations.upsert({
        id: `observation:${randomUUID()}`,
        agentNodeId,
        ...(input.runId ? { runId: input.runId } : {}),
        sourceNodeId: source.id,
        targetNodeId: target.id,
        relation: candidate.relation,
        state: "observed",
        confidence: candidate.confidence,
        sourceKind: input.sourceKind,
        evidence: candidate.evidence,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
    return results;
  }

  listAll(): Promise<GraphObservation[]> {
    return this.observations.getAll();
  }

  listForAgent(agentId: string): Promise<GraphObservation[]> {
    return this.observations.getForAgent(`agent:${agentId}`);
  }

  resolve(agentId: string, observationId: string, state: "confirmed" | "rejected"): Promise<GraphObservation> {
    return this.requireOwned(agentId, observationId).then((observation) =>
      this.observations.setState(observation.id, state, new Date().toISOString()),
    );
  }

  private async requireOwned(agentId: string, observationId: string): Promise<GraphObservation> {
    const observation = await this.observations.get(observationId);
    if (!observation || observation.agentNodeId !== `agent:${agentId}`) {
      throw new Error("Knowledge observation not found");
    }
    return observation;
  }

  private async findOrCreateNode(
    label: string,
    type: "asset" | "data_category",
    input: { agentId: string; sourceKind: ObservationSourceKind },
    evidence: string,
  ): Promise<GraphNode> {
    const existing = (await this.graphStore.getAllNodes()).find(
      (node) => node.type === type && node.label.toLowerCase() === label.toLowerCase(),
    );
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const classification = inferPromptClassification(label, evidence);
    const risk = type === "data_category"
      ? { riskLevel: "low" as const, riskWeight: 0 }
      : riskByClassification[classification];
    const node: GraphNode = {
      id: `${type}:${slug(label)}-${randomUUID().slice(0, 8)}`,
      type,
      label,
      classification,
      ...risk,
      metadata: {
        knowledgeStatus: "inferred",
        firstObservedByAgentId: input.agentId,
        sourceKind: input.sourceKind,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.graphStore.createNode(node);
    return node;
  }
}
