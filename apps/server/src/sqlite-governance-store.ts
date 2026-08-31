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
  approvalStatuses,
  capabilityRelations,
  policyResults,
  reviewResolutions,
  type ApprovalEventRecord,
  type ApprovalRequestRecord,
  type ClaimPolicyActionInput,
  type GovernanceStore,
  type PolicyActionClaim,
  type PolicyDecisionRecord,
  type RecordedPolicyEvaluation,
  type RecordPolicyEvaluationInput,
  type ResolveReviewInput,
} from "./policy-store.js";

interface PolicyDecisionRow {
  id: string;
  operation_id: string;
  run_id: string;
  agent_node_id: string;
  capability_relation: PolicyDecisionRecord["capabilityRelation"];
  target_node_id: string;
  result: PolicyDecisionRecord["result"];
  reason_code: string;
  matched_capability_id: string | null;
  risk_score: number;
  risk_threshold: number;
  policy_version: string;
  request_hash: string;
  evidence_json: string;
  expires_at: string | null;
  created_at: string;
}

interface ApprovalRequestRow {
  id: string;
  decision_id: string;
  status: ApprovalRequestRecord["status"];
  requested_at: string;
  expires_at: string;
  updated_at: string;
}

interface ApprovalEventRow {
  id: string;
  approval_request_id: string;
  event_type: ApprovalEventRecord["eventType"];
  actor_principal_id: string;
  actor_human_node_id: string | null;
  reason: string;
  created_at: string;
}

interface GraphNodeTypeRow {
  type: string;
}

interface CapabilityEdgeRow {
  source_id: string;
  target_id: string;
  relation: string;
  status: string;
}

interface ClaimRow {
  decision_id: string;
  claimed_at: string;
}

interface IdentityPrincipalRow {
  role: "viewer" | "operator" | "approver" | "admin";
  active: number;
}

interface CircuitBreakerGuardRow {
  state: "NORMAL" | "WARN" | "TRIPPED";
  version: number;
}

/** Durable policy decisions, human-review state, and single-use action claims. */
export class SqliteGovernanceStore implements GovernanceStore {
  constructor(
    private readonly database: MiddlewareDatabase,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async recordEvaluation(
    input: RecordPolicyEvaluationInput,
  ): Promise<RecordedPolicyEvaluation> {
    const evidenceJson = this.validateDecision(input);

    return this.database.transaction(() => {
      const existing = this.getDecisionByOperationRow(input.decision.operationId);
      if (existing) {
        this.assertSameOperation(existing, input.decision);
        return this.readRecordedEvaluation(toPolicyDecision(existing));
      }

      try {
        this.database.connection
          .prepare(`
            INSERT INTO policy_decisions (
              id, operation_id, run_id, agent_node_id, capability_relation,
              target_node_id, result, reason_code, matched_capability_id,
              risk_score, risk_threshold, policy_version, request_hash,
              evidence_json, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            input.decision.id,
            input.decision.operationId,
            input.decision.runId,
            input.decision.agentNodeId,
            input.decision.capabilityRelation,
            input.decision.targetNodeId,
            input.decision.result,
            input.decision.reasonCode,
            input.decision.matchedCapabilityId ?? null,
            input.decision.riskScore,
            input.decision.riskThreshold,
            input.decision.policyVersion,
            input.decision.requestHash,
            evidenceJson,
            input.decision.expiresAt ?? null,
            input.decision.createdAt,
          );

        let approvalRequest: ApprovalRequestRecord | undefined;
        if (input.decision.result === "REVIEW_REQUIRED") {
          approvalRequest = {
            id: input.approvalRequestId!,
            decisionId: input.decision.id,
            status: "pending",
            requestedAt: input.decision.createdAt,
            expiresAt: input.decision.expiresAt!,
            updatedAt: input.decision.createdAt,
          };
          this.insertApprovalRequest(approvalRequest);
        }
        return {
          decision: structuredClone(input.decision),
          ...(approvalRequest ? { approvalRequest } : {}),
        };
      } catch (error) {
        rethrowSqliteConstraint(
          error,
          `Policy decision ${input.decision.id} or operation ${input.decision.operationId} already exists`,
          `Policy decision ${input.decision.id} violates the middleware schema`,
        );
      }
    });
  }

  async getDecision(id: string): Promise<PolicyDecisionRecord | null> {
    assertNonEmptyText(id, "Policy decision ID");
    const row = this.database.connection
      .prepare("SELECT * FROM policy_decisions WHERE id = ?")
      .get(id) as PolicyDecisionRow | undefined;
    return row ? toPolicyDecision(row) : null;
  }

  async getDecisionByOperation(operationId: string): Promise<PolicyDecisionRecord | null> {
    assertNonEmptyText(operationId, "Policy operation ID");
    const row = this.getDecisionByOperationRow(operationId);
    return row ? toPolicyDecision(row) : null;
  }

  async getDecisionsForRun(runId: string): Promise<PolicyDecisionRecord[]> {
    assertNonEmptyText(runId, "Run ID");
    const rows = this.database.connection
      .prepare("SELECT * FROM policy_decisions WHERE run_id = ? ORDER BY created_at, id")
      .all(runId) as PolicyDecisionRow[];
    return rows.map(toPolicyDecision);
  }

  async getApprovalRequest(id: string): Promise<ApprovalRequestRecord | null> {
    assertNonEmptyText(id, "Approval request ID");
    const row = this.getApprovalRequestRow(id);
    return row ? toApprovalRequest(row) : null;
  }

  async getApprovalForDecision(decisionId: string): Promise<ApprovalRequestRecord | null> {
    assertNonEmptyText(decisionId, "Policy decision ID");
    const row = this.database.connection
      .prepare("SELECT * FROM approval_requests WHERE decision_id = ?")
      .get(decisionId) as ApprovalRequestRow | undefined;
    return row ? toApprovalRequest(row) : null;
  }

  async listApprovals(status?: ApprovalRequestRecord["status"]): Promise<ApprovalRequestRecord[]> {
    if (status) assertOneOf(status, approvalStatuses, "Approval status filter");
    const rows = (
      status
        ? this.database.connection
            .prepare(
              "SELECT * FROM approval_requests WHERE status = ? ORDER BY requested_at, id",
            )
            .all(status)
        : this.database.connection
            .prepare("SELECT * FROM approval_requests ORDER BY requested_at, id")
            .all()
    ) as ApprovalRequestRow[];
    return rows.map(toApprovalRequest);
  }

  async getApprovalEvents(approvalRequestId: string): Promise<ApprovalEventRecord[]> {
    assertNonEmptyText(approvalRequestId, "Approval request ID");
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM approval_events
        WHERE approval_request_id = ?
        ORDER BY created_at, id
      `)
      .all(approvalRequestId) as ApprovalEventRow[];
    return rows.map(toApprovalEvent);
  }

  async resolveReview(input: ResolveReviewInput): Promise<ApprovalEventRecord> {
    validateResolution(input);
    return this.database.transaction(() => {
      const createdAt = this.readClock("Approval resolution timestamp");
      const request = this.getApprovalRequestRow(input.approvalRequestId);
      if (!request) {
        throw new MiddlewareStoreError(
          "NOT_FOUND",
          `Approval request ${input.approvalRequestId} was not found`,
        );
      }
      if (request.status !== "pending") {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Approval request ${request.id} is already ${request.status}`,
        );
      }
      if (createdAt < request.requested_at) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Approval request ${request.id} cannot be resolved before it was requested`,
        );
      }
      if (input.resolution === "expired") {
        if (createdAt < request.expires_at) {
          throw new MiddlewareStoreError(
            "INVALID_TRANSITION",
            `Approval request ${request.id} has not expired yet`,
          );
        }
      } else if (createdAt >= request.expires_at) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Approval request ${request.id} expired before it could be resolved`,
        );
      }
      this.validateActorHuman(input.actorHumanNodeId);

      const update = this.database.connection
        .prepare(`
          UPDATE approval_requests
          SET status = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `)
        .run(input.resolution, createdAt, input.approvalRequestId);
      if (update.changes !== 1) {
        throw new MiddlewareStoreError(
          "CONFLICT",
          `Approval request ${request.id} was resolved concurrently`,
        );
      }

      const event = makeApprovalEvent(input, createdAt);
      this.insertApprovalEvent(event);
      return event;
    });
  }

  async claimForExecution(input: ClaimPolicyActionInput): Promise<PolicyActionClaim> {
    assertNonEmptyText(input.decisionId, "Policy decision ID");
    assertNonEmptyText(input.operationId, "Policy operation ID");
    assertRequestHash(input.requestHash);
    assertNonEmptyText(input.actorPrincipalId, "Claim actor principal ID");
    if (input.allowedPrincipalRoles) {
      if (input.allowedPrincipalRoles.length === 0) {
        throw new MiddlewareStoreError(
          "VALIDATION",
          "A protected claim must allow at least one principal role",
        );
      }
      for (const role of input.allowedPrincipalRoles) {
        assertOneOf(role, ["viewer", "operator", "approver", "admin"] as const, "Allowed principal role");
      }
    }
    if (input.breakerGuard) {
      assertNonEmptyText(input.breakerGuard.scopeId, "Circuit-breaker guard scope ID");
      assertOneOf(
        input.breakerGuard.expectedState,
        ["NORMAL", "WARN", "TRIPPED"] as const,
        "Expected circuit-breaker state",
      );
      if (
        !Number.isSafeInteger(input.breakerGuard.expectedVersion) ||
        input.breakerGuard.expectedVersion < 0
      ) {
        throw new MiddlewareStoreError(
          "VALIDATION",
          "Expected circuit-breaker version must be a non-negative safe integer",
        );
      }
    }

    return this.database.transaction(() => {
      const claimedAt = this.readClock("Claim timestamp");
      const row = this.database.connection
        .prepare("SELECT * FROM policy_decisions WHERE id = ?")
        .get(input.decisionId) as PolicyDecisionRow | undefined;
      if (!row) {
        throw new MiddlewareStoreError(
          "NOT_FOUND",
          `Policy decision ${input.decisionId} was not found`,
        );
      }
      if (row.result === "DENY") {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Denied policy decision ${row.id} cannot be claimed for execution`,
        );
      }
      if (row.operation_id !== input.operationId || row.request_hash !== input.requestHash) {
        throw new MiddlewareStoreError(
          "CONFLICT",
          `Policy decision ${row.id} does not match this protected action`,
        );
      }
      if (claimedAt < row.created_at) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Policy decision ${row.id} cannot be claimed before it was created`,
        );
      }
      if (row.expires_at && claimedAt >= row.expires_at) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Policy decision ${row.id} expired before execution`,
        );
      }

      if (input.allowedPrincipalRoles) {
        const principal = this.database.connection
          .prepare("SELECT role, active FROM identity_principals WHERE id = ?")
          .get(input.actorPrincipalId) as IdentityPrincipalRow | undefined;
        if (
          !principal ||
          principal.active !== 1 ||
          !input.allowedPrincipalRoles.includes(principal.role)
        ) {
          throw new MiddlewareStoreError(
            "INVALID_TRANSITION",
            "The authoritative principal role no longer allows this protected action",
          );
        }
      }

      if (input.breakerGuard) {
        const current = this.database.connection
          .prepare(`SELECT state, version FROM circuit_breakers
            WHERE scope_type = 'agent' AND scope_id = ?`)
          .get(input.breakerGuard.scopeId) as CircuitBreakerGuardRow | undefined;
        const currentState = current?.state ?? "NORMAL";
        const currentVersion = current?.version ?? 0;
        if (
          currentState !== input.breakerGuard.expectedState ||
          currentVersion !== input.breakerGuard.expectedVersion
        ) {
          throw new MiddlewareStoreError(
            "INVALID_TRANSITION",
            `Circuit breaker for ${input.breakerGuard.scopeId} changed after policy evaluation`,
          );
        }
      }

      if (row.result === "REVIEW_REQUIRED") {
        const request = this.database.connection
          .prepare("SELECT * FROM approval_requests WHERE decision_id = ?")
          .get(row.id) as ApprovalRequestRow | undefined;
        if (!request || request.status !== "approved") {
          throw new MiddlewareStoreError(
            "INVALID_TRANSITION",
            `Policy decision ${row.id} does not have an approved review`,
          );
        }
        if (claimedAt < request.updated_at) {
          throw new MiddlewareStoreError(
            "INVALID_TRANSITION",
            `Policy decision ${row.id} cannot be claimed before its approval`,
          );
        }
        if (!input.approvalEventId) {
          throw new MiddlewareStoreError(
            "VALIDATION",
            "Claiming an approved review requires an approval event ID",
          );
        }
        assertNonEmptyText(input.approvalEventId, "Approval event ID");
        const consumed = this.database.connection
          .prepare(`
            UPDATE approval_requests
            SET status = 'consumed', updated_at = ?
            WHERE id = ? AND status = 'approved'
          `)
          .run(claimedAt, request.id);
        if (consumed.changes !== 1) {
          throw new MiddlewareStoreError(
            "CONFLICT",
            `Approval request ${request.id} was consumed concurrently`,
          );
        }
        this.insertApprovalEvent({
          id: input.approvalEventId,
          approvalRequestId: request.id,
          eventType: "consumed",
          actorPrincipalId: input.actorPrincipalId,
          reason: "Claimed for one protected action execution",
          createdAt: claimedAt,
        });
      }

      try {
        this.database.connection
          .prepare("INSERT INTO policy_action_claims (decision_id, claimed_at) VALUES (?, ?)")
          .run(row.id, claimedAt);
      } catch (error) {
        rethrowSqliteConstraint(
          error,
          `Policy decision ${row.id} has already been claimed`,
          `Policy decision ${row.id} cannot be claimed`,
        );
      }
      return { decisionId: row.id, claimedAt };
    });
  }

  async getActionClaim(decisionId: string): Promise<PolicyActionClaim | null> {
    assertNonEmptyText(decisionId, "Policy decision ID");
    const row = this.database.connection
      .prepare("SELECT decision_id, claimed_at FROM policy_action_claims WHERE decision_id = ?")
      .get(decisionId) as ClaimRow | undefined;
    return row ? { decisionId: row.decision_id, claimedAt: row.claimed_at } : null;
  }

  async rollbackExecutionClaim(decisionId: string, approvalEventId?: string): Promise<void> {
    assertNonEmptyText(decisionId, "Policy decision ID");
    return this.database.transaction(() => {
      const removed = this.database.connection
        .prepare("DELETE FROM policy_action_claims WHERE decision_id = ?")
        .run(decisionId);
      if (removed.changes !== 1) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Policy decision ${decisionId} has no execution claim to roll back`,
        );
      }
      if (!approvalEventId) return;
      const event = this.database.connection
        .prepare("SELECT * FROM approval_events WHERE id = ? AND event_type = 'consumed'")
        .get(approvalEventId) as ApprovalEventRow | undefined;
      if (!event) {
        throw new MiddlewareStoreError(
          "INVALID_TRANSITION",
          `Approval consumption event ${approvalEventId} was not found`,
        );
      }
      const restored = this.database.connection.prepare(`UPDATE approval_requests
        SET status='approved', updated_at=? WHERE id=? AND status='consumed'`)
        .run(event.created_at, event.approval_request_id);
      if (restored.changes !== 1) {
        throw new MiddlewareStoreError(
          "CONFLICT",
          `Approval request ${event.approval_request_id} changed during claim rollback`,
        );
      }
      this.database.connection.prepare("DELETE FROM approval_events WHERE id = ?").run(approvalEventId);
    });
  }

  private validateDecision(input: RecordPolicyEvaluationInput): string {
    const { decision, approvalRequestId } = input;
    assertNonEmptyText(decision.id, "Policy decision ID");
    assertNonEmptyText(decision.operationId, "Policy operation ID");
    assertNonEmptyText(decision.runId, "Run ID");
    assertNonEmptyText(decision.agentNodeId, "Agent node ID");
    assertNonEmptyText(decision.targetNodeId, "Target node ID");
    assertOneOf(decision.capabilityRelation, capabilityRelations, "Capability relation");
    assertOneOf(decision.result, policyResults, "Policy result");
    assertNonEmptyText(decision.reasonCode, "Policy reason code", 120);
    assertNonEmptyText(decision.policyVersion, "Policy version", 64);
    assertIsoTimestamp(decision.createdAt, "Policy decision createdAt");
    assertRequestHash(decision.requestHash);
    for (const [field, value] of [
      ["riskScore", decision.riskScore],
      ["riskThreshold", decision.riskThreshold],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new MiddlewareStoreError(
          "VALIDATION",
          `Policy ${field} must be a non-negative integer`,
        );
      }
    }

    if (decision.result === "REVIEW_REQUIRED") {
      if (!decision.expiresAt || !approvalRequestId) {
        throw new MiddlewareStoreError(
          "VALIDATION",
          "REVIEW_REQUIRED needs an expiry and approval request ID",
        );
      }
      assertIsoTimestamp(decision.expiresAt, "Policy decision expiresAt");
      assertNonEmptyText(approvalRequestId, "Approval request ID");
      if (decision.expiresAt <= decision.createdAt) {
        throw new MiddlewareStoreError(
          "VALIDATION",
          "Policy decision expiry must be later than its creation time",
        );
      }
    } else if (decision.expiresAt || approvalRequestId) {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `${decision.result} must not create an approval request`,
      );
    }

    const agent = this.getGraphNodeType(decision.agentNodeId);
    const target = this.getGraphNodeType(decision.targetNodeId);
    if (agent !== "agent" || target !== "asset") {
      throw new MiddlewareStoreError(
        "VALIDATION",
        "Policy decisions must connect an existing Agent node to an existing asset node",
      );
    }

    if (decision.result !== "DENY" && !decision.matchedCapabilityId) {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `${decision.result} requires an exact matched capability edge`,
      );
    }
    if (decision.matchedCapabilityId) this.validateMatchedCapability(decision);
    return serializeSafeJsonObject(decision.evidence, "Policy evidence");
  }

  private validateMatchedCapability(decision: PolicyDecisionRecord): void {
    assertNonEmptyText(decision.matchedCapabilityId!, "Matched capability ID");
    const edge = this.database.connection
      .prepare(`
        SELECT source_id, target_id, relation, status
        FROM graph_edges WHERE id = ?
      `)
      .get(decision.matchedCapabilityId!) as CapabilityEdgeRow | undefined;
    if (
      !edge ||
      edge.source_id !== decision.agentNodeId ||
      edge.target_id !== decision.targetNodeId ||
      edge.relation !== decision.capabilityRelation ||
      edge.status !== "authorized"
    ) {
      throw new MiddlewareStoreError(
        "VALIDATION",
        "Matched capability must be the exact authorized Agent-to-asset permission",
      );
    }
  }

  private validateActorHuman(actorHumanNodeId: string | undefined): void {
    if (!actorHumanNodeId) return;
    assertNonEmptyText(actorHumanNodeId, "Approver human node ID");
    if (this.getGraphNodeType(actorHumanNodeId) !== "human") {
      throw new MiddlewareStoreError(
        "VALIDATION",
        `Approver ${actorHumanNodeId} must reference an existing human node`,
      );
    }
  }

  private readClock(field: string): string {
    const timestamp = this.clock();
    assertIsoTimestamp(timestamp, field);
    return timestamp;
  }

  private getGraphNodeType(id: string): string | null {
    const row = this.database.connection
      .prepare("SELECT type FROM graph_nodes WHERE id = ?")
      .get(id) as GraphNodeTypeRow | undefined;
    return row?.type ?? null;
  }

  private getDecisionByOperationRow(operationId: string): PolicyDecisionRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM policy_decisions WHERE operation_id = ?")
      .get(operationId) as PolicyDecisionRow | undefined;
  }

  private getApprovalRequestRow(id: string): ApprovalRequestRow | undefined {
    return this.database.connection
      .prepare("SELECT * FROM approval_requests WHERE id = ?")
      .get(id) as ApprovalRequestRow | undefined;
  }

  private readRecordedEvaluation(decision: PolicyDecisionRecord): RecordedPolicyEvaluation {
    const row = this.database.connection
      .prepare("SELECT * FROM approval_requests WHERE decision_id = ?")
      .get(decision.id) as ApprovalRequestRow | undefined;
    return {
      decision,
      ...(row ? { approvalRequest: toApprovalRequest(row) } : {}),
    };
  }

  private assertSameOperation(existing: PolicyDecisionRow, candidate: PolicyDecisionRecord): void {
    if (
      existing.run_id !== candidate.runId ||
      existing.agent_node_id !== candidate.agentNodeId ||
      existing.capability_relation !== candidate.capabilityRelation ||
      existing.target_node_id !== candidate.targetNodeId ||
      existing.request_hash !== candidate.requestHash
    ) {
      throw new MiddlewareStoreError(
        "CONFLICT",
        `Operation ${candidate.operationId} was already used for a different protected action`,
      );
    }
  }

  private insertApprovalRequest(request: ApprovalRequestRecord): void {
    this.database.connection
      .prepare(`
        INSERT INTO approval_requests (
          id, decision_id, status, requested_at, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        request.id,
        request.decisionId,
        request.status,
        request.requestedAt,
        request.expiresAt,
        request.updatedAt,
      );
  }

  private insertApprovalEvent(event: ApprovalEventRecord): void {
    try {
      this.database.connection
        .prepare(`
          INSERT INTO approval_events (
            id, approval_request_id, event_type, actor_principal_id,
            actor_human_node_id, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          event.id,
          event.approvalRequestId,
          event.eventType,
          event.actorPrincipalId,
          event.actorHumanNodeId ?? null,
          event.reason,
          event.createdAt,
        );
    } catch (error) {
      rethrowSqliteConstraint(
        error,
        `Approval event ${event.id} already exists`,
        `Approval event ${event.id} violates the middleware schema`,
      );
    }
  }
}

function validateResolution(input: ResolveReviewInput): void {
  assertNonEmptyText(input.eventId, "Approval event ID");
  assertNonEmptyText(input.approvalRequestId, "Approval request ID");
  assertOneOf(input.resolution, reviewResolutions, "Approval resolution");
  assertNonEmptyText(input.actorPrincipalId, "Approver principal ID");
  if (input.reason?.trim()) assertNonEmptyText(input.reason, "Approval reason", 500);
}

function makeApprovalEvent(input: ResolveReviewInput, createdAt: string): ApprovalEventRecord {
  return {
    id: input.eventId,
    approvalRequestId: input.approvalRequestId,
    eventType: input.resolution,
    actorPrincipalId: input.actorPrincipalId,
    ...(input.actorHumanNodeId ? { actorHumanNodeId: input.actorHumanNodeId } : {}),
    reason: input.reason?.trim() ?? "",
    createdAt,
  };
}

function assertRequestHash(requestHash: string): void {
  if (!/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new MiddlewareStoreError(
      "VALIDATION",
      "Policy requestHash must be a lowercase SHA-256 hexadecimal digest",
    );
  }
}

function toPolicyDecision(row: PolicyDecisionRow): PolicyDecisionRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    runId: row.run_id,
    agentNodeId: row.agent_node_id,
    capabilityRelation: row.capability_relation,
    targetNodeId: row.target_node_id,
    result: row.result,
    reasonCode: row.reason_code,
    ...(row.matched_capability_id === null ? {} : { matchedCapabilityId: row.matched_capability_id }),
    riskScore: row.risk_score,
    riskThreshold: row.risk_threshold,
    policyVersion: row.policy_version,
    requestHash: row.request_hash,
    evidence: parseJsonObject(row.evidence_json, `evidence for policy decision ${row.id}`),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
  };
}

function toApprovalRequest(row: ApprovalRequestRow): ApprovalRequestRecord {
  assertOneOf(row.status, approvalStatuses, "Stored approval status");
  return {
    id: row.id,
    decisionId: row.decision_id,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function toApprovalEvent(row: ApprovalEventRow): ApprovalEventRecord {
  return {
    id: row.id,
    approvalRequestId: row.approval_request_id,
    eventType: row.event_type,
    actorPrincipalId: row.actor_principal_id,
    ...(row.actor_human_node_id === null ? {} : { actorHumanNodeId: row.actor_human_node_id }),
    reason: row.reason,
    createdAt: row.created_at,
  };
}
