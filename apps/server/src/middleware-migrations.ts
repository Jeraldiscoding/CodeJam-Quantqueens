export interface MiddlewareMigration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrations are immutable once merged. Add a new numbered migration instead
 * of editing an existing one; MiddlewareDatabase verifies their checksums.
 */
export const middlewareMigrations: readonly MiddlewareMigration[] = [
  {
    version: 1,
    name: "create_graph_store",
    sql: `
      CREATE TABLE graph_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (
          type IN ('human', 'agent', 'asset', 'data_category', 'run')
        ),
        label TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK (
          risk_level IN ('low', 'medium', 'high', 'critical')
        ),
        risk_weight INTEGER NOT NULL CHECK (risk_weight BETWEEN 0 AND 100),
        classification TEXT NOT NULL CHECK (
          classification IN ('public', 'internal', 'confidential', 'restricted')
        ),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(metadata_json) AND json_type(metadata_json) = 'object'
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE graph_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        target_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK (
          relation IN (
            'OWNS', 'CAN_READ', 'CAN_WRITE', 'CAN_CALL', 'CAN_USE',
            'DEPLOYS_TO', 'PROCESSES', 'CONTAINS',
            'ATTEMPTED', 'TOUCHED', 'DENIED'
          )
        ),
        status TEXT NOT NULL CHECK (
          status IN ('authorized', 'attempted', 'actual', 'denied')
        ),
        run_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
          json_valid(metadata_json) AND json_type(metadata_json) = 'object'
        ),
        created_at TEXT NOT NULL,
        CHECK (
          (
            relation IN (
              'OWNS', 'CAN_READ', 'CAN_WRITE', 'CAN_CALL', 'CAN_USE',
              'DEPLOYS_TO', 'PROCESSES', 'CONTAINS'
            )
            AND status = 'authorized'
            AND run_id IS NULL
          )
          OR (relation = 'ATTEMPTED' AND status = 'attempted' AND run_id IS NOT NULL)
          OR (relation = 'TOUCHED' AND status = 'actual' AND run_id IS NOT NULL)
          OR (relation = 'DENIED' AND status = 'denied' AND run_id IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX graph_edges_source_idx
        ON graph_edges(source_id, status, created_at);
      CREATE INDEX graph_edges_target_idx
        ON graph_edges(target_id, status, created_at);
      CREATE INDEX graph_edges_run_idx
        ON graph_edges(run_id, created_at);
    `,
  },
  {
    version: 2,
    name: "create_policy_and_approval_store",
    sql: `
      CREATE TABLE policy_decisions (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        agent_node_id TEXT NOT NULL
          REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        capability_relation TEXT NOT NULL CHECK (
          capability_relation IN ('CAN_READ', 'CAN_WRITE', 'CAN_CALL', 'CAN_USE')
        ),
        target_node_id TEXT NOT NULL
          REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        result TEXT NOT NULL CHECK (
          result IN ('ALLOW', 'DENY', 'REVIEW_REQUIRED')
        ),
        reason_code TEXT NOT NULL,
        matched_capability_id TEXT
          REFERENCES graph_edges(id) ON DELETE RESTRICT,
        risk_score INTEGER NOT NULL CHECK (risk_score >= 0),
        risk_threshold INTEGER NOT NULL CHECK (risk_threshold >= 0),
        policy_version TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (
          length(request_hash) = 64
          AND request_hash NOT GLOB '*[^0-9a-f]*'
        ),
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND json_type(evidence_json) = 'object'
        ),
        expires_at TEXT,
        created_at TEXT NOT NULL,
        CHECK (
          (result = 'REVIEW_REQUIRED' AND expires_at IS NOT NULL)
          OR (result <> 'REVIEW_REQUIRED' AND expires_at IS NULL)
        )
      ) STRICT;

      CREATE INDEX policy_decisions_run_idx
        ON policy_decisions(run_id, created_at);
      CREATE INDEX policy_decisions_agent_idx
        ON policy_decisions(agent_node_id, created_at);

      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE
          REFERENCES policy_decisions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')
        ),
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (expires_at > requested_at)
      ) STRICT;

      CREATE INDEX approval_requests_status_idx
        ON approval_requests(status, requested_at);

      CREATE TABLE approval_events (
        id TEXT PRIMARY KEY,
        approval_request_id TEXT NOT NULL
          REFERENCES approval_requests(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (
          event_type IN ('approved', 'rejected', 'expired', 'consumed')
        ),
        actor_principal_id TEXT NOT NULL,
        actor_human_node_id TEXT
          REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX approval_events_request_idx
        ON approval_events(approval_request_id, created_at);

      CREATE TABLE policy_action_claims (
        decision_id TEXT PRIMARY KEY
          REFERENCES policy_decisions(id) ON DELETE RESTRICT,
        claimed_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "create_graph_observation_store",
    sql: `
      CREATE TABLE graph_observations (
        id TEXT PRIMARY KEY,
        agent_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        run_id TEXT,
        source_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        target_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK (
          relation IN ('DEPLOYS_TO', 'PROCESSES', 'CONTAINS', 'READS_FROM', 'CALLS', 'DEPENDS_ON')
        ),
        state TEXT NOT NULL CHECK (state IN ('observed', 'confirmed', 'rejected')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('prompt', 'run_output')),
        evidence TEXT NOT NULL CHECK (length(evidence) BETWEEN 1 AND 500),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(agent_node_id, source_node_id, target_node_id, relation)
      ) STRICT;

      CREATE INDEX graph_observations_agent_idx
        ON graph_observations(agent_node_id, state, created_at);
      CREATE INDEX graph_observations_source_idx
        ON graph_observations(source_node_id, state, created_at);
      CREATE INDEX graph_observations_run_idx
        ON graph_observations(run_id, created_at);
    `,
  },
];
