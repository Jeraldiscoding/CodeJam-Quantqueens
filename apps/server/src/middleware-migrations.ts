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
  {
    version: 4,
    name: "create_run_event_timeline",
    sql: `
      CREATE TABLE run_event_sequences (
        run_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 1)
      ) STRICT;

      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'RUN_CREATED', 'RUN_STARTED', 'RUN_COMPLETED', 'RUN_FAILED',
            'RUN_CANCELLED', 'AGENT_STARTED', 'AGENT_DELEGATED',
            'DELEGATION_REVOKED', 'ACTION_REQUESTED',
            'RESOURCE_ACCESS_ATTEMPTED', 'AUTHORIZATION_DECIDED',
            'RISK_DECIDED', 'ACTION_ALLOWED', 'ACTION_WARNED',
            'ACTION_BLOCKED', 'ACTION_COMPLETED', 'ACTION_FAILED',
            'CIRCUIT_BREAKER_TRANSITIONED', 'APPROVAL_PAUSED',
            'APPROVAL_RESOLVED'
          )
        ),
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL CHECK (
          json_valid(actor_json) AND json_type(actor_json) = 'object'
        ),
        agent_id TEXT,
        action_json TEXT CHECK (
          action_json IS NULL OR
          (json_valid(action_json) AND json_type(action_json) = 'object')
        ),
        resource_json TEXT CHECK (
          resource_json IS NULL OR
          (json_valid(resource_json) AND json_type(resource_json) = 'object')
        ),
        decision_json TEXT CHECK (
          decision_json IS NULL OR
          (json_valid(decision_json) AND json_type(decision_json) = 'object')
        ),
        delegation_json TEXT CHECK (
          delegation_json IS NULL OR
          (json_valid(delegation_json) AND json_type(delegation_json) = 'object')
        ),
        correlation_id TEXT,
        causation_id TEXT,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('pending', 'allowed', 'warned', 'blocked', 'succeeded', 'failed', 'cancelled')
        ),
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(reason) <= 1000),
        metadata_json TEXT NOT NULL CHECK (
          json_valid(metadata_json)
          AND json_type(metadata_json) = 'object'
          AND length(metadata_json) <= 8192
        ),
        UNIQUE(run_id, sequence)
      ) STRICT;

      CREATE INDEX run_events_run_sequence_idx
        ON run_events(run_id, sequence);
      CREATE INDEX run_events_resource_idx
        ON run_events(json_extract(resource_json, '$.resourceId'), event_type, occurred_at);
      CREATE INDEX run_events_agent_idx
        ON run_events(agent_id, event_type, occurred_at);
    `,
  },
  {
    version: 5,
    name: "create_integrated_security_runtime",
    sql: `
      CREATE TABLE identity_principals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'system')),
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'approver', 'admin')),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE delegations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        origin_principal_id TEXT NOT NULL,
        parent_agent_id TEXT NOT NULL,
        child_agent_id TEXT NOT NULL,
        parent_delegation_id TEXT REFERENCES delegations(id) ON DELETE RESTRICT,
        depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 8),
        requested_scope_json TEXT NOT NULL CHECK (
          json_valid(requested_scope_json) AND json_type(requested_scope_json) = 'array'
        ),
        effective_scope_json TEXT NOT NULL CHECK (
          json_valid(effective_scope_json) AND json_type(effective_scope_json) = 'array'
        ),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        reason TEXT NOT NULL DEFAULT '',
        CHECK (parent_agent_id <> child_agent_id),
        CHECK (
          (status = 'active' AND revoked_at IS NULL)
          OR (status <> 'active' AND revoked_at IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX delegations_run_idx ON delegations(run_id, created_at, id);
      CREATE INDEX delegations_child_idx ON delegations(child_agent_id, status, created_at, id);
      CREATE INDEX delegations_parent_idx ON delegations(parent_agent_id, status, created_at, id);

      CREATE TABLE authorization_decisions (
        id TEXT PRIMARY KEY,
        policy_decision_id TEXT NOT NULL UNIQUE
          REFERENCES policy_decisions(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL,
        origin_principal_id TEXT NOT NULL,
        actor_agent_id TEXT NOT NULL,
        delegation_id TEXT REFERENCES delegations(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'approver', 'admin')),
        capability_relation TEXT NOT NULL CHECK (
          capability_relation IN ('CAN_READ', 'CAN_WRITE', 'CAN_CALL', 'CAN_USE')
        ),
        target_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        result TEXT NOT NULL CHECK (result IN ('ALLOW', 'DENY')),
        reason_code TEXT NOT NULL,
        matched_capability_id TEXT REFERENCES graph_edges(id) ON DELETE RESTRICT,
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND json_type(evidence_json) = 'object'
        ),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX authorization_decisions_run_idx
        ON authorization_decisions(run_id, created_at, id);

      CREATE TABLE behavioral_baselines (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        minimum_history INTEGER NOT NULL CHECK (minimum_history >= 1),
        eligible_run_count INTEGER NOT NULL CHECK (eligible_run_count >= 0),
        source_run_ids_json TEXT NOT NULL CHECK (
          json_valid(source_run_ids_json) AND json_type(source_run_ids_json) = 'array'
        ),
        normal_scope_json TEXT NOT NULL CHECK (
          json_valid(normal_scope_json) AND json_type(normal_scope_json) = 'array'
        ),
        typical_blast_radius INTEGER NOT NULL CHECK (typical_blast_radius >= 0),
        maximum_blast_radius INTEGER NOT NULL CHECK (maximum_blast_radius >= 0),
        typical_delegation_depth INTEGER NOT NULL CHECK (typical_delegation_depth >= 0),
        inclusion_policy TEXT NOT NULL,
        calculated_at TEXT NOT NULL,
        UNIQUE(agent_id, revision)
      ) STRICT;
      CREATE INDEX behavioral_baselines_agent_idx
        ON behavioral_baselines(agent_id, revision DESC);

      CREATE TABLE circuit_breakers (
        scope_type TEXT NOT NULL CHECK (scope_type = 'agent'),
        scope_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('NORMAL', 'WARN', 'TRIPPED')),
        version INTEGER NOT NULL CHECK (version >= 1),
        reason_code TEXT NOT NULL,
        explanation TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK (
          json_valid(evidence_json) AND json_type(evidence_json) = 'object'
        ),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope_type, scope_id)
      ) STRICT;

      CREATE TABLE risk_decisions (
        id TEXT PRIMARY KEY,
        policy_decision_id TEXT NOT NULL UNIQUE
          REFERENCES policy_decisions(id) ON DELETE RESTRICT,
        authorization_decision_id TEXT NOT NULL UNIQUE
          REFERENCES authorization_decisions(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL,
        actor_agent_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        result TEXT NOT NULL CHECK (result IN ('ALLOW', 'WARN', 'BLOCK')),
        reason_code TEXT NOT NULL,
        score INTEGER NOT NULL CHECK (score >= 0),
        warn_threshold INTEGER NOT NULL CHECK (warn_threshold >= 0),
        block_threshold INTEGER NOT NULL CHECK (block_threshold >= warn_threshold),
        graph_revision TEXT NOT NULL,
        baseline_id TEXT REFERENCES behavioral_baselines(id) ON DELETE RESTRICT,
        baseline_revision INTEGER,
        breaker_state TEXT NOT NULL CHECK (breaker_state IN ('NORMAL', 'WARN', 'TRIPPED')),
        breaker_version INTEGER NOT NULL CHECK (breaker_version >= 1),
        factors_json TEXT NOT NULL CHECK (
          json_valid(factors_json) AND json_type(factors_json) = 'array'
        ),
        explanation TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX risk_decisions_run_idx ON risk_decisions(run_id, created_at, id);

      CREATE TABLE managed_resource_state (
        resource_id TEXT PRIMARY KEY REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        value_digest TEXT NOT NULL CHECK (
          length(value_digest) = 64 AND value_digest NOT GLOB '*[^0-9a-f]*'
        ),
        last_operation_id TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "bind_managed_effects_to_claims",
    sql: `
      CREATE TABLE managed_resource_action_receipts (
        decision_id TEXT PRIMARY KEY
          REFERENCES policy_decisions(id) ON DELETE RESTRICT,
        operation_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        agent_node_id TEXT NOT NULL
          REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        capability_relation TEXT NOT NULL CHECK (
          capability_relation IN ('CAN_READ', 'CAN_WRITE')
        ),
        resource_id TEXT NOT NULL
          REFERENCES graph_nodes(id) ON DELETE RESTRICT,
        payload_digest TEXT NOT NULL CHECK (
          length(payload_digest) = 64
          AND payload_digest NOT GLOB '*[^0-9a-f]*'
        ),
        resource_revision INTEGER NOT NULL CHECK (resource_revision >= 0),
        resource_value_digest TEXT CHECK (
          resource_value_digest IS NULL OR (
            length(resource_value_digest) = 64
            AND resource_value_digest NOT GLOB '*[^0-9a-f]*'
          )
        ),
        resource_last_operation_id TEXT,
        resource_updated_at TEXT,
        applied_at TEXT NOT NULL,
        CHECK (
          (resource_revision = 0
            AND resource_value_digest IS NULL
            AND resource_last_operation_id IS NULL
            AND resource_updated_at IS NULL)
          OR
          (resource_revision > 0
            AND resource_value_digest IS NOT NULL
            AND resource_last_operation_id IS NOT NULL
            AND resource_updated_at IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX managed_resource_action_receipts_resource_idx
        ON managed_resource_action_receipts(resource_id, applied_at, decision_id);
    `,
  },
  {
    version: 7,
    name: "bound_behavior_history_windows",
    sql: `
      ALTER TABLE behavioral_baselines
        ADD COLUMN history_window_run_limit INTEGER NOT NULL DEFAULT 20
          CHECK (history_window_run_limit BETWEEN 1 AND 1000);
      ALTER TABLE behavioral_baselines
        ADD COLUMN history_window_run_count INTEGER NOT NULL DEFAULT 0
          CHECK (
            history_window_run_count >= 0
            AND history_window_run_count <= history_window_run_limit
          );
      ALTER TABLE behavioral_baselines
        ADD COLUMN history_window_start_at TEXT;
      ALTER TABLE behavioral_baselines
        ADD COLUMN history_window_end_at TEXT;
    `,
  },
];
