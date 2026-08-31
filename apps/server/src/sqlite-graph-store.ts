import type { MiddlewareDatabase } from "./middleware-database.js";
import {
  assertIsoTimestamp,
  assertNonEmptyText,
  assertOneOf,
  MiddlewareStoreError,
  parseJsonObject,
  rethrowSqliteConstraint,
  serializeSafeJsonObject,
} from "./middleware-validation.js";
import {
  graphClassifications,
  graphEdgeRelations,
  graphEdgeStatuses,
  graphNodeTypes,
  graphRiskLevels,
  type EdgeFilter,
  type GraphEdge,
  type GraphNode,
  type GraphStore,
} from "./graph-types.js";

interface GraphNodeRow {
  id: string;
  type: GraphNode["type"];
  label: string;
  risk_level: GraphNode["riskLevel"];
  risk_weight: number;
  classification: GraphNode["classification"];
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface GraphEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: GraphEdge["relation"];
  status: GraphEdge["status"];
  run_id: string | null;
  metadata_json: string;
  created_at: string;
}

const permissionRelations = new Set<GraphEdge["relation"]>([
  "CAN_READ",
  "CAN_WRITE",
  "CAN_CALL",
  "CAN_USE",
]);
const impactRelations = new Set<GraphEdge["relation"]>([
  "DEPLOYS_TO",
  "PROCESSES",
]);
const auditStatusByRelation: Partial<Record<GraphEdge["relation"], GraphEdge["status"]>> = {
  ATTEMPTED: "attempted",
  TOUCHED: "actual",
  DENIED: "denied",
};

/** SQLite-backed implementation of the persistence-independent GraphStore contract. */
export class SqliteGraphStore implements GraphStore {
  constructor(private readonly database: MiddlewareDatabase) {}

  async getAllNodes(): Promise<GraphNode[]> {
    const rows = this.database.connection
      .prepare("SELECT * FROM graph_nodes ORDER BY created_at, id")
      .all() as GraphNodeRow[];
    return rows.map(toGraphNode);
  }

  async getAllEdges(): Promise<GraphEdge[]> {
    const rows = this.database.connection
      .prepare("SELECT * FROM graph_edges ORDER BY created_at, id")
      .all() as GraphEdgeRow[];
    return rows.map(toGraphEdge);
  }

  async getNode(id: string): Promise<GraphNode | null> {
    assertNonEmptyText(id, "Graph node ID");
    const row = this.getNodeRow(id);
    return row ? toGraphNode(row) : null;
  }

  async getOutgoingEdges(sourceId: string, filter?: EdgeFilter): Promise<GraphEdge[]> {
    assertNonEmptyText(sourceId, "Graph source ID");
    return this.getEdges("source_id", sourceId, filter);
  }

  async getIncomingEdges(targetId: string, filter?: EdgeFilter): Promise<GraphEdge[]> {
    assertNonEmptyText(targetId, "Graph target ID");
    return this.getEdges("target_id", targetId, filter);
  }

  async getEdgesForRun(runId: string): Promise<GraphEdge[]> {
    assertNonEmptyText(runId, "Run ID");
    const rows = this.database.connection
      .prepare("SELECT * FROM graph_edges WHERE run_id = ? ORDER BY created_at, id")
      .all(runId) as GraphEdgeRow[];
    return rows.map(toGraphEdge);
  }

  async createNode(node: GraphNode): Promise<void> {
    const metadataJson = validateNode(node);
    try {
      this.database.connection
        .prepare(`
          INSERT INTO graph_nodes (
            id, type, label, risk_level, risk_weight, classification,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          node.id,
          node.type,
          node.label,
          node.riskLevel,
          node.riskWeight,
          node.classification,
          metadataJson,
          node.createdAt,
          node.updatedAt,
        );
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Graph node ${node.id} already exists`,
        `Graph node ${node.id} violates the graph schema`,
      );
    }
  }

  async createEdge(edge: GraphEdge): Promise<void> {
    const metadataJson = this.validateEdge(edge);
    try {
      this.insertEdge(edge, metadataJson);
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Graph edge ${edge.id} already exists`,
        `Graph edge ${edge.id} violates the graph schema`,
      );
    }
  }

  async upsertNode(node: GraphNode): Promise<void> {
    const metadataJson = validateNode(node);
    const existing = this.getNodeRow(node.id);
    if (existing && existing.type !== node.type) {
      throw new MiddlewareStoreError(
        "CONFLICT",
        `Graph node ${node.id} cannot change type from ${existing.type} to ${node.type}`,
      );
    }

    try {
      this.database.connection
        .prepare(`
          INSERT INTO graph_nodes (
            id, type, label, risk_level, risk_weight, classification,
            metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            risk_level = excluded.risk_level,
            risk_weight = excluded.risk_weight,
            classification = excluded.classification,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `)
        .run(
          node.id,
          node.type,
          node.label,
          node.riskLevel,
          node.riskWeight,
          node.classification,
          metadataJson,
          node.createdAt,
          node.updatedAt,
        );
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Graph node ${node.id} conflicts with an existing node`,
        `Graph node ${node.id} violates the graph schema`,
      );
    }
  }

  async upsertEdge(edge: GraphEdge): Promise<void> {
    const metadataJson = this.validateEdge(edge);
    const existing = this.getEdgeRow(edge.id);
    if (existing) {
      const stored = toGraphEdge(existing);
      if (!sameEdgeFact(stored, edge, metadataJson)) {
        throw new MiddlewareStoreError(
          "CONFLICT",
          `Graph edge ${edge.id} already identifies a different immutable fact`,
        );
      }
      return;
    }

    try {
      this.insertEdge(edge, metadataJson);
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Graph edge ${edge.id} conflicts with an existing edge`,
        `Graph edge ${edge.id} violates the graph schema`,
      );
    }
  }

  private getNodeRow(id: string): GraphNodeRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM graph_nodes WHERE id = ?")
      .get(id) as GraphNodeRow | undefined;
  }

  private getEdgeRow(id: string): GraphEdgeRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM graph_edges WHERE id = ?")
      .get(id) as GraphEdgeRow | undefined;
  }

  private getEdges(
    column: "source_id" | "target_id",
    value: string,
    filter?: EdgeFilter,
  ): GraphEdge[] {
    if (filter?.relations?.length === 0 || filter?.statuses?.length === 0) return [];

    const clauses = [`${column} = ?`];
    const parameters: string[] = [value];
    if (filter?.relations) {
      for (const relation of filter.relations) {
        assertOneOf(relation, graphEdgeRelations, "Graph edge relation filter");
      }
      clauses.push(`relation IN (${filter.relations.map(() => "?").join(", ")})`);
      parameters.push(...filter.relations);
    }
    if (filter?.statuses) {
      for (const status of filter.statuses) {
        assertOneOf(status, graphEdgeStatuses, "Graph edge status filter");
      }
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      parameters.push(...filter.statuses);
    }

    const rows = this.database.connection
      .prepare(`SELECT * FROM graph_edges WHERE ${clauses.join(" AND ")} ORDER BY created_at, id`)
      .all(...parameters) as GraphEdgeRow[];
    return rows.map(toGraphEdge);
  }

  private validateEdge(edge: GraphEdge): string {
    assertNonEmptyText(edge.id, "Graph edge ID");
    assertNonEmptyText(edge.sourceId, "Graph edge source ID");
    assertNonEmptyText(edge.targetId, "Graph edge target ID");
    assertOneOf(edge.relation, graphEdgeRelations, "Graph edge relation");
    assertOneOf(edge.status, graphEdgeStatuses, "Graph edge status");
    assertIsoTimestamp(edge.createdAt, "Graph edge createdAt");
    if (edge.runId !== undefined) assertNonEmptyText(edge.runId, "Graph edge run ID");

    const source = this.getNodeRow(edge.sourceId);
    const target = this.getNodeRow(edge.targetId);
    if (!source || !target) {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `Graph edge ${edge.id} requires existing source and target nodes`,
      );
    }
    assertEdgeShape(edge, source, target);
    return serializeSafeJsonObject(edge.metadata, "Graph edge metadata");
  }

  private insertEdge(edge: GraphEdge, metadataJson: string): void {
    this.database.connection
      .prepare(`
        INSERT INTO graph_edges (
          id, source_id, target_id, relation, status, run_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        edge.id,
        edge.sourceId,
        edge.targetId,
        edge.relation,
        edge.status,
        edge.runId ?? null,
        metadataJson,
        edge.createdAt,
      );
  }
}

function validateNode(node: GraphNode): string {
  assertNonEmptyText(node.id, "Graph node ID");
  assertNonEmptyText(node.label, "Graph node label", 120);
  assertOneOf(node.type, graphNodeTypes, "Graph node type");
  assertOneOf(node.riskLevel, graphRiskLevels, "Graph node risk level");
  assertOneOf(node.classification, graphClassifications, "Graph node classification");
  if (!Number.isInteger(node.riskWeight) || node.riskWeight < 0 || node.riskWeight > 100) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      "Graph node riskWeight must be an integer from 0 through 100",
    );
  }
  assertIsoTimestamp(node.createdAt, "Graph node createdAt");
  assertIsoTimestamp(node.updatedAt, "Graph node updatedAt");
  if (node.updatedAt < node.createdAt) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      "Graph node updatedAt must not be earlier than createdAt",
    );
  }
  return serializeSafeJsonObject(node.metadata, "Graph node metadata");
}

function assertEdgeShape(edge: GraphEdge, source: GraphNodeRow, target: GraphNodeRow): void {
  const auditStatus = auditStatusByRelation[edge.relation];
  if (auditStatus) {
    if (edge.status !== auditStatus || !edge.runId) {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `${edge.relation} must use status ${auditStatus} and include a Run ID`,
      );
    }
    if (source.type !== "agent" || target.type !== "asset") {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `${edge.relation} must connect an Agent to an asset`,
      );
    }
    return;
  }

  if (edge.status !== "authorized" || edge.runId !== undefined) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      `${edge.relation} must be authorized and must not include a Run ID`,
    );
  }
  if (edge.relation === "OWNS") {
    if (source.type !== "human" || (target.type !== "agent" && target.type !== "asset")) {
      throw new MiddlewareStoreError(
        "VALIDATION",
        "OWNS must connect a human to an Agent or asset",
      );
    }
    return;
  }
  if (permissionRelations.has(edge.relation)) {
    if (source.type !== "agent" || target.type !== "asset") {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `${edge.relation} must connect an Agent directly to an asset`,
      );
    }
    return;
  }
  if (impactRelations.has(edge.relation)) {
    if (source.type !== "asset" || target.type !== "asset") {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `${edge.relation} must connect one asset to another asset`,
      );
    }
    return;
  }
  if (edge.relation === "CONTAINS") {
    if (source.type !== "asset" || target.type !== "data_category") {
      throw new MiddlewareStoreError(
        "VALIDATION",
        "CONTAINS must connect an asset to a data category",
      );
    }
    return;
  }
  throw new MiddlewareStoreError("VALIDATION", `Unsupported graph relation ${edge.relation}`);
}

function toGraphNode(row: GraphNodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    riskLevel: row.risk_level,
    riskWeight: row.risk_weight,
    classification: row.classification,
    metadata: parseJsonObject(row.metadata_json, `metadata for graph node ${row.id}`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toGraphEdge(row: GraphEdgeRow): GraphEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
    status: row.status,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    metadata: parseJsonObject(row.metadata_json, `metadata for graph edge ${row.id}`),
    createdAt: row.created_at,
  };
}

function sameEdgeFact(stored: GraphEdge, candidate: GraphEdge, metadataJson: string): boolean {
  return (
    stored.sourceId === candidate.sourceId &&
    stored.targetId === candidate.targetId &&
    stored.relation === candidate.relation &&
    stored.status === candidate.status &&
    stored.runId === candidate.runId &&
    JSON.stringify(stored.metadata) === metadataJson
  );
}
