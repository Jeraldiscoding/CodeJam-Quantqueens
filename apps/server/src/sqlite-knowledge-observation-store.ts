import type { MiddlewareDatabase } from "./middleware-database.js";
import type {
  GraphObservation,
  KnowledgeObservationStore,
  ObservationState,
} from "./knowledge-observation.js";

interface ObservationRow {
  id: string;
  agent_node_id: string;
  run_id: string | null;
  source_node_id: string;
  target_node_id: string;
  relation: GraphObservation["relation"];
  state: GraphObservation["state"];
  confidence: number;
  source_kind: GraphObservation["sourceKind"];
  evidence: string;
  created_at: string;
  updated_at: string;
}

const toObservation = (row: ObservationRow): GraphObservation => ({
  id: row.id,
  agentNodeId: row.agent_node_id,
  ...(row.run_id ? { runId: row.run_id } : {}),
  sourceNodeId: row.source_node_id,
  targetNodeId: row.target_node_id,
  relation: row.relation,
  state: row.state,
  confidence: row.confidence,
  sourceKind: row.source_kind,
  evidence: row.evidence,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteKnowledgeObservationStore implements KnowledgeObservationStore {
  constructor(private readonly database: MiddlewareDatabase) {}

  async getAll(): Promise<GraphObservation[]> {
    return (this.database.connection.prepare("SELECT * FROM graph_observations ORDER BY created_at, id").all() as ObservationRow[]).map(toObservation);
  }

  async getForAgent(agentNodeId: string): Promise<GraphObservation[]> {
    return (this.database.connection.prepare("SELECT * FROM graph_observations WHERE agent_node_id = ? ORDER BY created_at DESC, id").all(agentNodeId) as ObservationRow[]).map(toObservation);
  }

  async getOutgoing(
    agentNodeId: string,
    sourceNodeId: string,
    states: readonly ObservationState[] = ["observed", "confirmed"],
  ): Promise<GraphObservation[]> {
    if (states.length === 0) return [];
    const sql = `SELECT * FROM graph_observations WHERE agent_node_id = ? AND source_node_id = ? AND state IN (${states.map(() => "?").join(", ")}) ORDER BY created_at, id`;
    return (this.database.connection.prepare(sql).all(agentNodeId, sourceNodeId, ...states) as ObservationRow[]).map(toObservation);
  }

  async get(id: string): Promise<GraphObservation | null> {
    const row = this.database.connection.prepare("SELECT * FROM graph_observations WHERE id = ?").get(id) as ObservationRow | undefined;
    return row ? toObservation(row) : null;
  }

  async upsert(observation: GraphObservation): Promise<GraphObservation> {
    this.database.connection.prepare(`
      INSERT INTO graph_observations (
        id, agent_node_id, run_id, source_node_id, target_node_id, relation,
        state, confidence, source_kind, evidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_node_id, source_node_id, target_node_id, relation) DO UPDATE SET
        run_id = COALESCE(excluded.run_id, graph_observations.run_id),
        confidence = MAX(graph_observations.confidence, excluded.confidence),
        source_kind = excluded.source_kind,
        evidence = excluded.evidence,
        updated_at = excluded.updated_at
    `).run(
      observation.id, observation.agentNodeId, observation.runId ?? null,
      observation.sourceNodeId, observation.targetNodeId, observation.relation,
      observation.state, observation.confidence, observation.sourceKind,
      observation.evidence, observation.createdAt, observation.updatedAt,
    );
    const stored = this.database.connection.prepare(`
      SELECT * FROM graph_observations
      WHERE agent_node_id = ? AND source_node_id = ? AND target_node_id = ? AND relation = ?
    `).get(observation.agentNodeId, observation.sourceNodeId, observation.targetNodeId, observation.relation) as ObservationRow;
    return toObservation(stored);
  }

  async setState(id: string, state: ObservationState, updatedAt: string): Promise<GraphObservation> {
    const result = this.database.connection.prepare("UPDATE graph_observations SET state = ?, updated_at = ? WHERE id = ?").run(state, updatedAt, id);
    if (result.changes !== 1) throw new Error("Knowledge observation not found");
    return (await this.get(id))!;
  }
}
