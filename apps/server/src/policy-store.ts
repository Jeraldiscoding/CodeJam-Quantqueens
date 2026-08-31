export const capabilityRelations = ["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"] as const;
export type CapabilityRelation = (typeof capabilityRelations)[number];

export const policyResults = ["ALLOW", "DENY", "REVIEW_REQUIRED"] as const;
export type PolicyResult = (typeof policyResults)[number];

export const approvalStatuses = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "consumed",
] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const reviewResolutions = ["approved", "rejected", "expired"] as const;
export type ReviewResolution = (typeof reviewResolutions)[number];

export interface PolicyDecisionRecord {
  id: string;
  operationId: string;
  runId: string;
  agentNodeId: string;
  capabilityRelation: CapabilityRelation;
  targetNodeId: string;
  result: PolicyResult;
  reasonCode: string;
  matchedCapabilityId?: string;
  riskScore: number;
  riskThreshold: number;
  policyVersion: string;
  requestHash: string;
  evidence: Record<string, unknown>;
  expiresAt?: string;
  createdAt: string;
}

export interface ApprovalRequestRecord {
  id: string;
  decisionId: string;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface ApprovalEventRecord {
  id: string;
  approvalRequestId: string;
  eventType: Exclude<ApprovalStatus, "pending">;
  actorPrincipalId: string;
  actorHumanNodeId?: string;
  reason: string;
  createdAt: string;
}

export interface PolicyActionClaim {
  decisionId: string;
  claimedAt: string;
}

export interface RecordedPolicyEvaluation {
  decision: PolicyDecisionRecord;
  approvalRequest?: ApprovalRequestRecord;
}

export interface RecordPolicyEvaluationInput {
  decision: PolicyDecisionRecord;
  approvalRequestId?: string;
}

export interface ResolveReviewInput {
  eventId: string;
  approvalRequestId: string;
  resolution: ReviewResolution;
  actorPrincipalId: string;
  actorHumanNodeId?: string;
  reason?: string;
}

export interface ClaimPolicyActionInput {
  decisionId: string;
  operationId: string;
  requestHash: string;
  approvalEventId?: string;
  actorPrincipalId: string;
  /**
   * When present, the durable principal row is checked inside the same SQLite
   * transaction that creates the one-time claim. This closes the gap between
   * resolving an identity and committing its protected effect authority.
   */
  allowedPrincipalRoles?: Array<"viewer" | "operator" | "approver" | "admin">;
  /**
   * Optional optimistic guard for the Agent-scoped safety state used to make
   * this decision. The governance adapter verifies it inside the same
   * BEGIN IMMEDIATE transaction that creates the one-time execution claim.
   * Callers that do not use the integrated safety runtime remain compatible.
   */
  breakerGuard?: {
    scopeId: string;
    expectedState: "NORMAL" | "WARN" | "TRIPPED";
    expectedVersion: number;
  };
}

export interface GovernanceStore {
  recordEvaluation(input: RecordPolicyEvaluationInput): Promise<RecordedPolicyEvaluation>;
  getDecision(id: string): Promise<PolicyDecisionRecord | null>;
  getDecisionByOperation(operationId: string): Promise<PolicyDecisionRecord | null>;
  getDecisionsForRun(runId: string): Promise<PolicyDecisionRecord[]>;
  getApprovalRequest(id: string): Promise<ApprovalRequestRecord | null>;
  getApprovalForDecision(decisionId: string): Promise<ApprovalRequestRecord | null>;
  listApprovals(status?: ApprovalStatus): Promise<ApprovalRequestRecord[]>;
  getApprovalEvents(approvalRequestId: string): Promise<ApprovalEventRecord[]>;
  resolveReview(input: ResolveReviewInput): Promise<ApprovalEventRecord>;
  claimForExecution(input: ClaimPolicyActionInput): Promise<PolicyActionClaim>;
  rollbackExecutionClaim(decisionId: string, approvalEventId?: string): Promise<void>;
  getActionClaim(decisionId: string): Promise<PolicyActionClaim | null>;
}
