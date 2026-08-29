export const graphNodeTypes = ["human", "agent", "asset", "data_category", "run"] as const;
export type GraphNodeType = (typeof graphNodeTypes)[number];

export const graphRiskLevels = ["low", "medium", "high", "critical"] as const;
export type GraphRiskLevel = (typeof graphRiskLevels)[number];

export const graphClassifications = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export type GraphClassification = (typeof graphClassifications)[number];

export const graphEdgeRelations = [
  "OWNS",
  "CAN_READ",
  "CAN_WRITE",
  "CAN_CALL",
  "CAN_USE",
  "DEPLOYS_TO",
  "PROCESSES",
  "CONTAINS",
  "ATTEMPTED",
  "TOUCHED",
  "DENIED",
] as const;
export type GraphEdgeRelation = (typeof graphEdgeRelations)[number];

export const graphEdgeStatuses = ["authorized", "attempted", "actual", "denied"] as const;
export type GraphEdgeStatus = (typeof graphEdgeStatuses)[number];

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  riskLevel: GraphRiskLevel;
  riskWeight: number;
  classification: GraphClassification;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: GraphEdgeRelation;
  status: GraphEdgeStatus;
  runId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EdgeFilter {
  relations?: readonly GraphEdgeRelation[];
  statuses?: readonly GraphEdgeStatus[];
}

export interface GraphStore {
  getNode(id: string): Promise<GraphNode | null>;
  getOutgoingEdges(sourceId: string, filter?: EdgeFilter): Promise<GraphEdge[]>;
  getIncomingEdges(targetId: string, filter?: EdgeFilter): Promise<GraphEdge[]>;
  getEdgesForRun(runId: string): Promise<GraphEdge[]>;
  createNode(node: GraphNode): Promise<void>;
  createEdge(edge: GraphEdge): Promise<void>;
  upsertNode(node: GraphNode): Promise<void>;
  upsertEdge(edge: GraphEdge): Promise<void>;
}
