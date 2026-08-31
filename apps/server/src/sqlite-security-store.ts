import type { MiddlewareDatabase } from "./middleware-database.js";
import { computeRequestHash } from "./policy-hash.js";
import {
  assertIsoTimestamp,
  assertNonEmptyText,
  assertOneOf,
  MiddlewareStoreError,
  parseJsonObject,
  rethrowSqliteConstraint,
  serializeSafeJsonObject,
} from "./middleware-validation.js";
import type { ManagedActionClaimContext, SecurityStore } from "./security-store.js";
import {
  principalRoles,
  type AuthenticatedPrincipal,
  type AuthorizationDecision,
  type BehavioralBaseline,
  type CircuitBreakerRecord,
  type DelegationRecord,
  type DelegationScope,
  type ManagedResourceState,
  type RiskDecision,
  type RiskFactor,
} from "./security-types.js";

interface PrincipalRow { id: string; kind: "human" | "system"; display_name: string; role: AuthenticatedPrincipal["role"]; active: number; }
interface DelegationRow { id: string; run_id: string; origin_principal_id: string; parent_agent_id: string; child_agent_id: string; parent_delegation_id: string | null; depth: number; requested_scope_json: string; effective_scope_json: string; status: DelegationRecord["status"]; expires_at: string; created_at: string; revoked_at: string | null; reason: string; }
interface AuthorizationRow { id: string; policy_decision_id: string; run_id: string; origin_principal_id: string; actor_agent_id: string; delegation_id: string | null; role: AuthorizationDecision["role"]; capability_relation: AuthorizationDecision["capability"]; target_node_id: string; result: AuthorizationDecision["result"]; reason_code: string; matched_capability_id: string | null; evidence_json: string; created_at: string; }
interface BaselineRow { id: string; agent_id: string; revision: number; minimum_history: number; history_window_run_limit: number; history_window_run_count: number; history_window_start_at: string | null; history_window_end_at: string | null; eligible_run_count: number; source_run_ids_json: string; normal_scope_json: string; typical_blast_radius: number; maximum_blast_radius: number; typical_delegation_depth: number; inclusion_policy: string; calculated_at: string; }
interface BreakerRow { scope_type: "agent"; scope_id: string; state: CircuitBreakerRecord["state"]; version: number; reason_code: string; explanation: string; evidence_json: string; updated_at: string; }
interface RiskRow { id: string; policy_decision_id: string; authorization_decision_id: string; run_id: string; actor_agent_id: string; target_node_id: string; result: RiskDecision["result"]; reason_code: string; score: number; warn_threshold: number; block_threshold: number; graph_revision: string; baseline_id: string | null; baseline_revision: number | null; breaker_state: RiskDecision["breakerState"]; breaker_version: number; factors_json: string; explanation: string; created_at: string; }
interface ManagedRow { resource_id: string; revision: number; value_digest: string; last_operation_id: string; updated_at: string; }
interface ManagedPolicyRow {
  id: string;
  operation_id: string;
  run_id: string;
  agent_node_id: string;
  capability_relation: "CAN_READ" | "CAN_WRITE" | "CAN_CALL" | "CAN_USE";
  target_node_id: string;
  result: "ALLOW" | "DENY" | "REVIEW_REQUIRED";
  policy_version: string;
  request_hash: string;
  matched_capability_id: string | null;
  expires_at: string | null;
}
interface ManagedClaimRow { decision_id: string; claimed_at: string; }
interface ManagedReceiptRow {
  decision_id: string;
  operation_id: string;
  run_id: string;
  agent_node_id: string;
  capability_relation: "CAN_READ" | "CAN_WRITE";
  resource_id: string;
  payload_digest: string;
  resource_revision: number;
  resource_value_digest: string | null;
  resource_last_operation_id: string | null;
  resource_updated_at: string | null;
  applied_at: string;
}
interface ManagedNodeRow { type: string; metadata_json: string; }
interface CurrentPrincipalRow { role: AuthenticatedPrincipal["role"]; active: number; }
interface ManagedCapabilityEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  status: string;
  run_id: string | null;
}
interface ManagedOwnerRow { source_id: string; }

const roles = new Set(principalRoles);
const capabilities = new Set(["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"]);
const breakerStates = ["NORMAL", "WARN", "TRIPPED"] as const;

export class SqliteSecurityStore implements SecurityStore {
  constructor(private readonly database: MiddlewareDatabase) {}

  async upsertPrincipal(principal: AuthenticatedPrincipal): Promise<void> {
    assertNonEmptyText(principal.id, "Principal ID");
    assertNonEmptyText(principal.displayName, "Principal display name", 120);
    if (!roles.has(principal.role)) throw new MiddlewareStoreError("VALIDATION", "Unsupported principal role");
    this.database.connection.prepare(`
      INSERT INTO identity_principals (id, kind, display_name, role, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, role=excluded.role,
        active=1, updated_at=excluded.updated_at
    `).run(principal.id, principal.kind, principal.displayName, principal.role, new Date().toISOString(), new Date().toISOString());
  }

  async getPrincipal(id: string): Promise<AuthenticatedPrincipal | null> {
    const row = this.database.connection.prepare("SELECT * FROM identity_principals WHERE id = ? AND active = 1").get(id) as PrincipalRow | undefined;
    return row ? { id: row.id, kind: row.kind, displayName: row.display_name, role: row.role, authenticationSource: "system" } : null;
  }

  async createDelegation(record: DelegationRecord): Promise<void> {
    validateDelegation(record);
    try {
      this.database.connection.prepare(`INSERT INTO delegations (
        id, run_id, origin_principal_id, parent_agent_id, child_agent_id,
        parent_delegation_id, depth, requested_scope_json, effective_scope_json,
        status, expires_at, created_at, revoked_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.runId, record.originPrincipalId, record.parentAgentId,
          record.childAgentId, record.parentDelegationId ?? null, record.depth,
          jsonArray(record.requestedScope, "Requested delegation scope"),
          jsonArray(record.effectiveScope, "Effective delegation scope"), record.status,
          record.expiresAt, record.createdAt, record.revokedAt ?? null, record.reason);
    } catch (error) {
      rethrowSqliteConstraint(error, `Delegation ${record.id} already exists`, `Delegation ${record.id} violates the security schema`);
    }
  }

  async getDelegation(id: string): Promise<DelegationRecord | null> {
    const row = this.database.connection.prepare("SELECT * FROM delegations WHERE id = ?").get(id) as DelegationRow | undefined;
    return row ? toDelegation(row) : null;
  }

  async listDelegationsForRun(runId: string): Promise<DelegationRecord[]> {
    const rows = this.database.connection.prepare("SELECT * FROM delegations WHERE run_id = ? ORDER BY depth, created_at, id").all(runId) as DelegationRow[];
    return rows.map(toDelegation);
  }

  async listDelegationsForAgent(agentId: string): Promise<DelegationRecord[]> {
    const rows = this.database.connection.prepare("SELECT * FROM delegations WHERE parent_agent_id = ? OR child_agent_id = ? ORDER BY created_at, id").all(agentId, agentId) as DelegationRow[];
    return rows.map(toDelegation);
  }

  async revokeDelegation(id: string, reason: string, revokedAt: string): Promise<DelegationRecord> {
    assertNonEmptyText(reason, "Delegation revocation reason", 500);
    assertIsoTimestamp(revokedAt, "Delegation revokedAt");
    return this.database.transaction(() => {
      const changed = this.database.connection.prepare("UPDATE delegations SET status='revoked', revoked_at=?, reason=? WHERE id=? AND status='active'").run(revokedAt, reason, id);
      if (changed.changes !== 1) throw new MiddlewareStoreError("INVALID_TRANSITION", `Delegation ${id} is missing or inactive`);
      const row = this.database.connection.prepare("SELECT * FROM delegations WHERE id=?").get(id) as DelegationRow;
      return toDelegation(row);
    });
  }

  async recordAuthorization(decision: AuthorizationDecision): Promise<void> {
    const evidence = serializeSafeJsonObject(decision.evidence, "Authorization evidence");
    try {
      this.database.connection.prepare(`INSERT INTO authorization_decisions (
        id, policy_decision_id, run_id, origin_principal_id, actor_agent_id,
        delegation_id, role, capability_relation, target_node_id, result,
        reason_code, matched_capability_id, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(decision.id, decision.policyDecisionId, decision.runId, decision.originPrincipalId,
          decision.actorAgentId, decision.delegationId ?? null, decision.role,
          decision.capability, decision.targetNodeId, decision.result, decision.reasonCode,
          decision.matchedCapabilityId ?? null, evidence, decision.createdAt);
    } catch (error) {
      rethrowSqliteConstraint(error, `Authorization decision ${decision.id} already exists`, `Authorization decision ${decision.id} violates the security schema`);
    }
  }

  async getAuthorizationForPolicy(policyDecisionId: string): Promise<AuthorizationDecision | null> {
    const row = this.database.connection.prepare("SELECT * FROM authorization_decisions WHERE policy_decision_id=?").get(policyDecisionId) as AuthorizationRow | undefined;
    return row ? toAuthorization(row) : null;
  }

  async recordRiskAndTransition(
    decision: Omit<RiskDecision, "breakerState" | "breakerVersion">,
    requestedState: CircuitBreakerRecord["state"],
  ): Promise<{ risk: RiskDecision; breaker: CircuitBreakerRecord; previousState: CircuitBreakerRecord["state"] }> {
    assertOneOf(requestedState, breakerStates, "Requested circuit-breaker state");
    return this.database.transaction(() => {
      const stored = this.getBreakerRow(decision.actorAgentId);
      const previousState = stored?.state ?? "NORMAL";
      const state = previousState === "TRIPPED"
        ? "TRIPPED"
        : previousState === "WARN" && requestedState === "NORMAL"
          ? "WARN"
          : requestedState;
      const version = (stored?.version ?? 0) + 1;
      const explanation = decision.explanation;
      const evidence = { decisionId: decision.id, score: decision.score, factors: decision.factors.map((factor) => factor.code) };
      this.database.connection.prepare(`INSERT INTO circuit_breakers (
        scope_type, scope_id, state, version, reason_code, explanation, evidence_json, updated_at
      ) VALUES ('agent', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, scope_id) DO UPDATE SET state=excluded.state,
        version=excluded.version, reason_code=excluded.reason_code,
        explanation=excluded.explanation, evidence_json=excluded.evidence_json,
        updated_at=excluded.updated_at`)
        .run(decision.actorAgentId, state, version, decision.reasonCode, explanation,
          serializeSafeJsonObject(evidence, "Circuit-breaker evidence"), decision.createdAt);

      const risk: RiskDecision = { ...decision, breakerState: state, breakerVersion: version };
      this.database.connection.prepare(`INSERT INTO risk_decisions (
        id, policy_decision_id, authorization_decision_id, run_id, actor_agent_id,
        target_node_id, result, reason_code, score, warn_threshold, block_threshold,
        graph_revision, baseline_id, baseline_revision, breaker_state, breaker_version,
        factors_json, explanation, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(risk.id, risk.policyDecisionId, risk.authorizationDecisionId, risk.runId,
          risk.actorAgentId, risk.targetNodeId, risk.result, risk.reasonCode, risk.score,
          risk.warnThreshold, risk.blockThreshold, risk.graphRevision, risk.baselineId ?? null,
          risk.baselineRevision ?? null, risk.breakerState, risk.breakerVersion,
          jsonArray(risk.factors, "Risk factors"), risk.explanation, risk.createdAt);
      return { risk, breaker: toBreaker(this.getBreakerRow(decision.actorAgentId)!), previousState };
    });
  }

  async getRiskForPolicy(policyDecisionId: string): Promise<RiskDecision | null> {
    const row = this.database.connection.prepare("SELECT * FROM risk_decisions WHERE policy_decision_id=?").get(policyDecisionId) as RiskRow | undefined;
    return row ? toRisk(row) : null;
  }

  async getBreaker(agentId: string): Promise<CircuitBreakerRecord> {
    const row = this.getBreakerRow(agentId);
    return row ? toBreaker(row) : { scopeType: "agent", scopeId: agentId, state: "NORMAL", version: 0, reasonCode: "NO_PRIOR_TRANSITION", explanation: "No safety stop has been triggered.", evidence: {}, updatedAt: new Date(0).toISOString() };
  }

  async acknowledgeWarn(agentId: string, reason: string, acknowledgedAt: string): Promise<CircuitBreakerRecord> {
    assertNonEmptyText(reason, "Circuit-breaker acknowledgement reason", 500);
    assertIsoTimestamp(acknowledgedAt, "Circuit-breaker acknowledgement timestamp");
    return this.database.transaction(() => {
      const stored = this.getBreakerRow(agentId);
      if (!stored || stored.state !== "WARN") {
        throw new MiddlewareStoreError("INVALID_TRANSITION", `Circuit breaker for ${agentId} is not awaiting review`);
      }
      this.database.connection.prepare("UPDATE circuit_breakers SET state='NORMAL', version=?, reason_code='WARN_APPROVED', explanation=?, evidence_json='{}', updated_at=? WHERE scope_type='agent' AND scope_id=? AND state='WARN'")
        .run(stored.version + 1, reason, acknowledgedAt, agentId);
      return toBreaker(this.getBreakerRow(agentId)!);
    });
  }

  async resetBreaker(agentId: string, reason: string, resetAt: string): Promise<CircuitBreakerRecord> {
    assertNonEmptyText(reason, "Circuit-breaker reset reason", 500);
    assertIsoTimestamp(resetAt, "Circuit-breaker reset timestamp");
    return this.database.transaction(() => {
      const stored = this.getBreakerRow(agentId);
      if (!stored) throw new MiddlewareStoreError("NOT_FOUND", `Circuit breaker for ${agentId} was not found`);
      this.database.connection.prepare("UPDATE circuit_breakers SET state='NORMAL', version=?, reason_code='ADMIN_RESET', explanation=?, evidence_json='{}', updated_at=? WHERE scope_type='agent' AND scope_id=?")
        .run(stored.version + 1, reason, resetAt, agentId);
      return toBreaker(this.getBreakerRow(agentId)!);
    });
  }

  async restoreBreaker(
    snapshot: CircuitBreakerRecord,
    expectedVersion: number,
  ): Promise<CircuitBreakerRecord> {
    return this.database.transaction(() => {
      const stored = this.getBreakerRow(snapshot.scopeId);
      if (!stored || stored.version !== expectedVersion) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Circuit breaker for ${snapshot.scopeId} changed while an audit write was being compensated`,
        );
      }
      if (snapshot.version === 0) {
        this.database.connection.prepare(
          "DELETE FROM circuit_breakers WHERE scope_type='agent' AND scope_id=? AND version=?",
        ).run(snapshot.scopeId, expectedVersion);
        return snapshot;
      }
      this.database.connection.prepare(`UPDATE circuit_breakers SET
        state=?, version=?, reason_code=?, explanation=?, evidence_json=?, updated_at=?
        WHERE scope_type='agent' AND scope_id=? AND version=?`)
        .run(
          snapshot.state,
          snapshot.version,
          snapshot.reasonCode,
          snapshot.explanation,
          serializeSafeJsonObject(snapshot.evidence, "Circuit-breaker restore evidence"),
          snapshot.updatedAt,
          snapshot.scopeId,
          expectedVersion,
        );
      return toBreaker(this.getBreakerRow(snapshot.scopeId)!);
    });
  }

  async getLatestBaseline(agentId: string): Promise<BehavioralBaseline | null> {
    const row = this.database.connection.prepare("SELECT * FROM behavioral_baselines WHERE agent_id=? ORDER BY revision DESC LIMIT 1").get(agentId) as BaselineRow | undefined;
    return row ? toBaseline(row) : null;
  }

  async getBaseline(id: string): Promise<BehavioralBaseline | null> {
    assertNonEmptyText(id, "Behavioral baseline ID");
    const row = this.database.connection
      .prepare("SELECT * FROM behavioral_baselines WHERE id=?")
      .get(id) as BaselineRow | undefined;
    return row ? toBaseline(row) : null;
  }

  async saveBaseline(baseline: BehavioralBaseline): Promise<BehavioralBaseline> {
    try {
      this.database.connection.prepare(`INSERT INTO behavioral_baselines (
        id, agent_id, revision, minimum_history, history_window_run_limit,
        history_window_run_count, history_window_start_at, history_window_end_at, eligible_run_count,
        source_run_ids_json, normal_scope_json, typical_blast_radius,
        maximum_blast_radius, typical_delegation_depth, inclusion_policy, calculated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
        .run(baseline.id, baseline.agentId, baseline.revision, baseline.minimumHistory,
          baseline.historyWindowRunLimit, baseline.historyWindowRunCount,
          baseline.historyWindowStartAt, baseline.historyWindowEndAt,
          baseline.eligibleRunCount, jsonArray(baseline.sourceRunIds, "Baseline source Runs"),
          jsonArray(baseline.normalScope, "Baseline normal scope"), baseline.typicalBlastRadius,
          baseline.maximumBlastRadius, baseline.typicalDelegationDepth,
          baseline.inclusionPolicy, baseline.calculatedAt);
      return structuredClone(baseline);
    } catch (error) {
      rethrowSqliteConstraint(error, `Behavioral baseline ${baseline.id} already exists`, `Behavioral baseline ${baseline.id} violates the security schema`);
    }
  }

  async readManagedResourceForClaim(
    input: ManagedActionClaimContext,
  ): Promise<ManagedResourceState | null> {
    validateManagedActionInput(input, "CAN_READ");
    return this.database.transaction(() => {
      this.assertManagedActionClaim(input, "CAN_READ");
      const prior = this.getManagedReceipt(input);
      if (prior) return managedStateFromReceipt(prior);

      const state = this.getManagedRow(input.resourceId);
      this.insertManagedReceipt(input, state);
      return state ? toManaged(state) : null;
    });
  }

  async applyManagedWrite(input: ManagedActionClaimContext): Promise<ManagedResourceState> {
    validateManagedActionInput(input, "CAN_WRITE");
    return this.database.transaction(() => {
      this.assertManagedActionClaim(input, "CAN_WRITE");
      const prior = this.getManagedReceipt(input);
      if (prior) {
        const priorState = managedStateFromReceipt(prior);
        if (!priorState) {
          throw new MiddlewareStoreError(
            "CONFLICT",
            `Managed action ${input.decisionId} already produced a different effect`,
          );
        }
        return priorState;
      }

      const existing = this.getManagedRow(input.resourceId);
      const revision = (existing?.revision ?? 0) + 1;
      this.database.connection.prepare(`INSERT INTO managed_resource_state (
        resource_id, revision, value_digest, last_operation_id, updated_at
      ) VALUES (?, ?, ?, ?, ?) ON CONFLICT(resource_id) DO UPDATE SET
        revision=excluded.revision, value_digest=excluded.value_digest,
        last_operation_id=excluded.last_operation_id, updated_at=excluded.updated_at`)
        .run(
          input.resourceId,
          revision,
          input.payloadDigest,
          input.operationId,
          input.executedAt,
        );
      const state = this.getManagedRow(input.resourceId)!;
      this.insertManagedReceipt(input, state);
      return toManaged(state);
    });
  }

  async getManagedResourceState(resourceId: string): Promise<ManagedResourceState | null> {
    const row = this.database.connection.prepare("SELECT * FROM managed_resource_state WHERE resource_id=?").get(resourceId) as ManagedRow | undefined;
    return row ? toManaged(row) : null;
  }

  private getBreakerRow(agentId: string): BreakerRow | undefined {
    return this.database.connection.prepare("SELECT * FROM circuit_breakers WHERE scope_type='agent' AND scope_id=?").get(agentId) as BreakerRow | undefined;
  }

  /**
   * This check runs inside the same BEGIN IMMEDIATE transaction as the managed
   * access/effect. It intentionally repeats the outer PolicyService checks:
   * the adapter is a privilege boundary and must fail closed if it is called
   * directly, receives a forged GrantedAction, or races a safety transition.
   */
  private assertManagedActionClaim(
    input: ManagedActionClaimContext,
    expectedCapability: "CAN_READ" | "CAN_WRITE",
  ): void {
    const policy = this.database.connection.prepare(`SELECT
      id, operation_id, run_id, agent_node_id, capability_relation,
      target_node_id, result, policy_version, request_hash,
      matched_capability_id, expires_at
      FROM policy_decisions WHERE id=?`).get(input.decisionId) as ManagedPolicyRow | undefined;
    if (!policy) {
      throw new MiddlewareStoreError(
        "NOT_FOUND",
        `Policy decision ${input.decisionId} was not found for the managed action`,
      );
    }
    if (
      policy.operation_id !== input.operationId ||
      policy.run_id !== input.runId ||
      policy.agent_node_id !== input.agentNodeId ||
      input.agentNodeId !== `agent:${input.agentId}` ||
      policy.capability_relation !== expectedCapability ||
      input.capability !== expectedCapability ||
      policy.target_node_id !== input.resourceId
    ) {
      throw new MiddlewareStoreError(
        "CONFLICT",
        `Policy decision ${policy.id} does not authorize this exact managed action`,
      );
    }
    if (policy.result === "DENY") {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Denied policy decision ${policy.id} cannot produce a managed effect`,
      );
    }

    const claim = this.database.connection
      .prepare("SELECT decision_id, claimed_at FROM policy_action_claims WHERE decision_id=?")
      .get(policy.id) as ManagedClaimRow | undefined;
    if (!claim) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Policy decision ${policy.id} has no one-time execution claim`,
      );
    }
    if (input.executedAt < claim.claimed_at) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Managed action ${policy.id} cannot execute before its claim`,
      );
    }
    if (policy.expires_at && input.executedAt >= policy.expires_at) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Managed action ${policy.id} expired before its effect`,
      );
    }

    const authorization = this.database.connection
      .prepare("SELECT * FROM authorization_decisions WHERE policy_decision_id=?")
      .get(policy.id) as AuthorizationRow | undefined;
    if (
      !authorization ||
      authorization.result !== "ALLOW" ||
      authorization.run_id !== policy.run_id ||
      authorization.actor_agent_id !== input.agentId ||
      authorization.capability_relation !== policy.capability_relation ||
      authorization.target_node_id !== policy.target_node_id
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Policy decision ${policy.id} has no correlated ALLOW authorization`,
      );
    }
    this.assertCurrentManagedGraphAuthority(policy, authorization);

    const currentPrincipal = this.database.connection
      .prepare("SELECT role, active FROM identity_principals WHERE id=?")
      .get(authorization.origin_principal_id) as CurrentPrincipalRow | undefined;
    if (
      !currentPrincipal ||
      currentPrincipal.active !== 1 ||
      currentPrincipal.role !== authorization.role
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `The principal for managed action ${policy.id} changed after authorization`,
      );
    }

    if (authorization.delegation_id) {
      this.assertManagedDelegationChain(authorization, input);
    }

    const risk = this.database.connection
      .prepare("SELECT * FROM risk_decisions WHERE policy_decision_id=?")
      .get(policy.id) as RiskRow | undefined;
    if (
      !risk ||
      risk.authorization_decision_id !== authorization.id ||
      risk.run_id !== policy.run_id ||
      risk.actor_agent_id !== input.agentId ||
      risk.target_node_id !== policy.target_node_id ||
      risk.result === "BLOCK"
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Policy decision ${policy.id} has no correlated executable safety decision`,
      );
    }
    const requestHash = computeRequestHash({
      policyVersion: policy.policy_version,
      runId: policy.run_id,
      agentNodeId: policy.agent_node_id,
      capability: policy.capability_relation,
      targetNodeId: policy.target_node_id,
      graphRevision: risk.graph_revision,
      payloadDigest: input.payloadDigest,
    });
    if (requestHash !== policy.request_hash) {
      throw new MiddlewareStoreError(
        "CONFLICT",
        `Policy decision ${policy.id} does not match this managed payload`,
      );
    }

    const resource = this.database.connection
      .prepare("SELECT type, metadata_json FROM graph_nodes WHERE id=?")
      .get(input.resourceId) as ManagedNodeRow | undefined;
    const resourceMetadata = resource
      ? parseJsonObject(resource.metadata_json, "managed resource metadata")
      : null;
    if (
      !resource ||
      resource.type !== "asset" ||
      resourceMetadata?.adapterKind !== "managed_state"
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Resource ${input.resourceId} is not owned by the managed-state adapter`,
      );
    }

    const breaker = this.getBreakerRow(input.agentId);
    if (risk.result === "ALLOW") {
      if (
        policy.result !== "ALLOW" ||
        risk.breaker_state !== "NORMAL" ||
        !breaker ||
        breaker.state !== "NORMAL" ||
        breaker.version !== risk.breaker_version
      ) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Circuit breaker for ${input.agentId} changed after the action was claimed`,
        );
      }
      return;
    }

    if (
      risk.result !== "WARN" ||
      policy.result !== "REVIEW_REQUIRED" ||
      risk.breaker_state !== "WARN" ||
      !breaker ||
      breaker.state !== "NORMAL" ||
      breaker.version !== risk.breaker_version + 1 ||
      breaker.reason_code !== "WARN_APPROVED" ||
      !this.hasConsumedApprovedReview(policy.id)
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Approved safety review for ${policy.id} is missing or stale`,
      );
    }
  }

  private hasConsumedApprovedReview(decisionId: string): boolean {
    const row = this.database.connection.prepare(`SELECT ar.id
      FROM approval_requests ar
      WHERE ar.decision_id=? AND ar.status='consumed'
        AND EXISTS (
          SELECT 1 FROM approval_events approved
          WHERE approved.approval_request_id=ar.id
            AND approved.event_type='approved'
        )
        AND EXISTS (
          SELECT 1 FROM approval_events consumed
          WHERE consumed.approval_request_id=ar.id
            AND consumed.event_type='consumed'
        )`).get(decisionId) as { id: string } | undefined;
    return Boolean(row);
  }

  private assertManagedDelegationChain(
    authorization: AuthorizationRow,
    input: ManagedActionClaimContext,
  ): void {
    const evidence = parseJsonObject(
      authorization.evidence_json,
      "managed authorization evidence",
    );
    const rootAgentId = evidence.rootAgentId;
    const recordedDepth = evidence.delegationDepth;
    if (
      typeof rootAgentId !== "string" ||
      rootAgentId.length === 0 ||
      !Number.isSafeInteger(recordedDepth) ||
      (recordedDepth as number) < 1 ||
      (recordedDepth as number) > 8
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `The delegation chain for managed action ${input.decisionId} is incomplete`,
      );
    }

    const visited = new Set<string>();
    let delegationId: string | null = authorization.delegation_id;
    let expectedChildAgentId = input.agentId;
    let expectedDepth = recordedDepth as number;
    while (delegationId) {
      if (visited.has(delegationId) || visited.size >= 8) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `The delegation chain for managed action ${input.decisionId} is cyclic or too deep`,
        );
      }
      visited.add(delegationId);
      const delegation = this.database.connection
        .prepare("SELECT * FROM delegations WHERE id=?")
        .get(delegationId) as DelegationRow | undefined;
      const scope = delegation
        ? parseArray<DelegationScope>(
            delegation.effective_scope_json,
            "managed delegation effective scope",
          )
        : [];
      if (
        !delegation ||
        delegation.run_id !== authorization.run_id ||
        delegation.origin_principal_id !== authorization.origin_principal_id ||
        delegation.child_agent_id !== expectedChildAgentId ||
        delegation.depth !== expectedDepth ||
        delegation.status !== "active" ||
        input.executedAt >= delegation.expires_at ||
        !scope.some((item) =>
          item.capability === input.capability && item.targetNodeId === input.resourceId)
      ) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `The delegation chain for managed action ${input.decisionId} is no longer active or does not cover this exact action`,
        );
      }

      this.assertCurrentManagedDelegationCapability(
        delegation.parent_agent_id,
        input.capability,
        input.resourceId,
        input.decisionId,
        "Delegating Agent",
      );
      this.assertCurrentManagedDelegationCapability(
        delegation.child_agent_id,
        input.capability,
        input.resourceId,
        input.decisionId,
        "Delegated Agent",
      );
      this.assertCurrentManagedOwnership(
        `agent:${delegation.parent_agent_id}`,
        authorization.origin_principal_id,
        "Delegating Agent",
        input.decisionId,
      );
      this.assertCurrentManagedOwnership(
        `agent:${delegation.child_agent_id}`,
        authorization.origin_principal_id,
        "Delegated Agent",
        input.decisionId,
      );

      if (delegation.parent_delegation_id) {
        if (delegation.depth <= 1) {
          throw new MiddlewareStoreError(
            "INVALID_TRANSITION",
            `The delegation chain for managed action ${input.decisionId} has invalid parent linkage`,
          );
        }
        expectedChildAgentId = delegation.parent_agent_id;
        expectedDepth = delegation.depth - 1;
        delegationId = delegation.parent_delegation_id;
        continue;
      }

      if (
        delegation.depth !== 1 ||
        delegation.parent_agent_id !== rootAgentId ||
        visited.size !== recordedDepth
      ) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `The delegation chain for managed action ${input.decisionId} does not reach its recorded root Agent`,
        );
      }
      delegationId = null;
    }
  }

  private assertCurrentManagedGraphAuthority(
    policy: ManagedPolicyRow,
    authorization: AuthorizationRow,
  ): void {
    if (
      !policy.matched_capability_id ||
      !authorization.matched_capability_id ||
      policy.matched_capability_id !== authorization.matched_capability_id
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `Managed action ${policy.id} has no exact current capability evidence`,
      );
    }
    const capability = this.database.connection.prepare(`SELECT
      id, source_id, target_id, relation, status, run_id
      FROM graph_edges WHERE id=?`).get(
      policy.matched_capability_id,
    ) as ManagedCapabilityEdgeRow | undefined;
    if (
      !capability ||
      capability.source_id !== policy.agent_node_id ||
      capability.target_id !== policy.target_node_id ||
      capability.relation !== policy.capability_relation ||
      capability.status !== "authorized" ||
      capability.run_id !== null
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `The exact capability for managed action ${policy.id} changed after the claim`,
      );
    }

    for (const [targetId, subject] of [
      [policy.agent_node_id, "Agent"],
      [policy.target_node_id, "resource"],
    ] as const) {
      this.assertCurrentManagedOwnership(
        targetId,
        authorization.origin_principal_id,
        subject,
        policy.id,
      );
    }
  }

  private assertCurrentManagedDelegationCapability(
    agentId: string,
    capability: ManagedActionClaimContext["capability"],
    resourceId: string,
    decisionId: string,
    subject: string,
  ): void {
    const current = this.database.connection.prepare(`SELECT id
      FROM graph_edges
      WHERE source_id=? AND target_id=? AND relation=?
        AND status='authorized' AND run_id IS NULL
      ORDER BY id LIMIT 1`).get(
      `agent:${agentId}`,
      resourceId,
      capability,
    ) as { id: string } | undefined;
    if (!current) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `${subject} capability for managed action ${decisionId} changed after the claim`,
      );
    }
  }

  private assertCurrentManagedOwnership(
    targetId: string,
    originPrincipalId: string,
    subject: string,
    decisionId: string,
  ): void {
    const owners = this.database.connection.prepare(`SELECT e.source_id
      FROM graph_edges e
      JOIN graph_nodes owner ON owner.id=e.source_id
      WHERE e.target_id=? AND e.relation='OWNS'
        AND e.status='authorized' AND e.run_id IS NULL
        AND owner.type='human'
      ORDER BY e.source_id`).all(targetId) as ManagedOwnerRow[];
    if (
      owners.length > 0 &&
      !owners.some((owner) => owner.source_id === originPrincipalId)
    ) {
      throw new MiddlewareStoreError(
        "INVALID_TRANSITION",
        `${subject} ownership for managed action ${decisionId} changed after the claim`,
      );
    }
  }

  private getManagedRow(resourceId: string): ManagedRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM managed_resource_state WHERE resource_id=?")
      .get(resourceId) as ManagedRow | undefined;
  }

  private getManagedReceipt(input: ManagedActionClaimContext): ManagedReceiptRow | null {
    const byDecision = this.database.connection
      .prepare("SELECT * FROM managed_resource_action_receipts WHERE decision_id=?")
      .get(input.decisionId) as ManagedReceiptRow | undefined;
    const byOperation = this.database.connection
      .prepare("SELECT * FROM managed_resource_action_receipts WHERE operation_id=?")
      .get(input.operationId) as ManagedReceiptRow | undefined;
    if (byDecision && byOperation && byDecision.decision_id !== byOperation.decision_id) {
      throw new MiddlewareStoreError(
        "CONFLICT",
        `Managed action ${input.operationId} conflicts with an existing effect receipt`,
      );
    }
    const receipt = byDecision ?? byOperation;
    if (!receipt) return null;
    if (
      receipt.decision_id !== input.decisionId ||
      receipt.operation_id !== input.operationId ||
      receipt.run_id !== input.runId ||
      receipt.agent_node_id !== input.agentNodeId ||
      receipt.capability_relation !== input.capability ||
      receipt.resource_id !== input.resourceId ||
      receipt.payload_digest !== input.payloadDigest
    ) {
      throw new MiddlewareStoreError(
        "CONFLICT",
        `Managed action ${input.decisionId} already produced a different effect`,
      );
    }
    return receipt;
  }

  private insertManagedReceipt(
    input: ManagedActionClaimContext,
    state: ManagedRow | undefined,
  ): void {
    try {
      this.database.connection.prepare(`INSERT INTO managed_resource_action_receipts (
        decision_id, operation_id, run_id, agent_node_id, capability_relation,
        resource_id, payload_digest, resource_revision, resource_value_digest,
        resource_last_operation_id, resource_updated_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.decisionId,
        input.operationId,
        input.runId,
        input.agentNodeId,
        input.capability,
        input.resourceId,
        input.payloadDigest,
        state?.revision ?? 0,
        state?.value_digest ?? null,
        state?.last_operation_id ?? null,
        state?.updated_at ?? null,
        input.executedAt,
      );
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Managed action ${input.decisionId} or operation ${input.operationId} already has an effect receipt`,
        `Managed action ${input.decisionId} violates the effect receipt schema`,
      );
    }
  }
}

function jsonArray(value: unknown[], field: string): string {
  serializeSafeJsonObject({ value }, field);
  return JSON.stringify(value);
}
function parseArray<T>(value: string, field: string): T[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`Stored ${field} is not an array`);
  return parsed as T[];
}
function validateScope(scope: DelegationScope[]): void {
  if (scope.length < 1 || scope.length > 30) throw new MiddlewareStoreError("VALIDATION", "Delegation scope must contain 1 through 30 entries");
  for (const item of scope) {
    if (!capabilities.has(item.capability)) throw new MiddlewareStoreError("VALIDATION", "Unsupported delegated capability");
    assertNonEmptyText(item.targetNodeId, "Delegated target node ID");
  }
}
function validateDelegation(record: DelegationRecord): void {
  for (const [value, field] of [[record.id, "Delegation ID"], [record.runId, "Run ID"], [record.originPrincipalId, "Origin principal ID"], [record.parentAgentId, "Parent Agent ID"], [record.childAgentId, "Child Agent ID"]] as const) assertNonEmptyText(value, field);
  assertIsoTimestamp(record.createdAt, "Delegation createdAt");
  assertIsoTimestamp(record.expiresAt, "Delegation expiresAt");
  if (record.expiresAt <= record.createdAt) throw new MiddlewareStoreError("VALIDATION", "Delegation must expire after creation");
  validateScope(record.requestedScope); validateScope(record.effectiveScope);
}
function toDelegation(row: DelegationRow): DelegationRecord { return { id: row.id, runId: row.run_id, originPrincipalId: row.origin_principal_id, parentAgentId: row.parent_agent_id, childAgentId: row.child_agent_id, ...(row.parent_delegation_id ? { parentDelegationId: row.parent_delegation_id } : {}), depth: row.depth, requestedScope: parseArray(row.requested_scope_json, "requested delegation scope"), effectiveScope: parseArray(row.effective_scope_json, "effective delegation scope"), status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}), reason: row.reason }; }
function toAuthorization(row: AuthorizationRow): AuthorizationDecision { return { id: row.id, policyDecisionId: row.policy_decision_id, runId: row.run_id, originPrincipalId: row.origin_principal_id, actorAgentId: row.actor_agent_id, ...(row.delegation_id ? { delegationId: row.delegation_id } : {}), role: row.role, capability: row.capability_relation, targetNodeId: row.target_node_id, result: row.result, reasonCode: row.reason_code, ...(row.matched_capability_id ? { matchedCapabilityId: row.matched_capability_id } : {}), evidence: parseJsonObject(row.evidence_json, "authorization evidence"), createdAt: row.created_at }; }
function toBaseline(row: BaselineRow): BehavioralBaseline { return { id: row.id, agentId: row.agent_id, revision: row.revision, minimumHistory: row.minimum_history, historyWindowRunLimit: row.history_window_run_limit, historyWindowRunCount: row.history_window_run_count, historyWindowStartAt: row.history_window_start_at, historyWindowEndAt: row.history_window_end_at, eligibleRunCount: row.eligible_run_count, sourceRunIds: parseArray(row.source_run_ids_json, "baseline source Runs"), normalScope: parseArray(row.normal_scope_json, "baseline normal scope"), typicalBlastRadius: row.typical_blast_radius, maximumBlastRadius: row.maximum_blast_radius, typicalDelegationDepth: row.typical_delegation_depth, inclusionPolicy: row.inclusion_policy, calculatedAt: row.calculated_at }; }
function toBreaker(row: BreakerRow): CircuitBreakerRecord { return { scopeType: "agent", scopeId: row.scope_id, state: row.state, version: row.version, reasonCode: row.reason_code, explanation: row.explanation, evidence: parseJsonObject(row.evidence_json, "circuit-breaker evidence"), updatedAt: row.updated_at }; }
function toRisk(row: RiskRow): RiskDecision { return { id: row.id, policyDecisionId: row.policy_decision_id, authorizationDecisionId: row.authorization_decision_id, runId: row.run_id, actorAgentId: row.actor_agent_id, targetNodeId: row.target_node_id, result: row.result, reasonCode: row.reason_code, score: row.score, warnThreshold: row.warn_threshold, blockThreshold: row.block_threshold, graphRevision: row.graph_revision, ...(row.baseline_id ? { baselineId: row.baseline_id } : {}), ...(row.baseline_revision === null ? {} : { baselineRevision: row.baseline_revision }), breakerState: row.breaker_state, breakerVersion: row.breaker_version, factors: parseArray<RiskFactor>(row.factors_json, "risk factors"), explanation: row.explanation, createdAt: row.created_at }; }
function toManaged(row: ManagedRow): ManagedResourceState { return { resourceId: row.resource_id, revision: row.revision, valueDigest: row.value_digest, lastOperationId: row.last_operation_id, updatedAt: row.updated_at }; }

function validateManagedActionInput(
  input: ManagedActionClaimContext,
  expectedCapability: "CAN_READ" | "CAN_WRITE",
): void {
  for (const [value, field] of [
    [input.decisionId, "Managed policy decision ID"],
    [input.operationId, "Managed operation ID"],
    [input.runId, "Managed Run ID"],
    [input.agentId, "Managed Agent ID"],
    [input.agentNodeId, "Managed Agent node ID"],
    [input.resourceId, "Managed resource ID"],
  ] as const) assertNonEmptyText(value, field);
  assertIsoTimestamp(input.executedAt, "Managed action executedAt");
  if (input.capability !== expectedCapability) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      `Managed ${expectedCapability === "CAN_WRITE" ? "writes" : "reads"} require ${expectedCapability}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.payloadDigest)) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      "Managed payload digest must be SHA-256 hexadecimal",
    );
  }
}

function managedStateFromReceipt(receipt: ManagedReceiptRow): ManagedResourceState | null {
  if (receipt.resource_revision === 0) return null;
  if (
    !receipt.resource_value_digest ||
    !receipt.resource_last_operation_id ||
    !receipt.resource_updated_at
  ) {
    throw new Error(`Stored managed receipt ${receipt.decision_id} has no resource snapshot`);
  }
  return {
    resourceId: receipt.resource_id,
    revision: receipt.resource_revision,
    valueDigest: receipt.resource_value_digest,
    lastOperationId: receipt.resource_last_operation_id,
    updatedAt: receipt.resource_updated_at,
  };
}
