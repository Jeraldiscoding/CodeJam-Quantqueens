import type {
  AuthenticatedPrincipal,
  AuthorizationDecision,
  BehavioralBaseline,
  CircuitBreakerRecord,
  DelegationRecord,
  ManagedResourceState,
  RiskDecision,
} from "./security-types.js";
import type { CapabilityRelation } from "./policy-store.js";

/**
 * Immutable identity of the already-claimed action presented to the managed
 * resource boundary. SqliteSecurityStore re-resolves every field from its
 * authoritative decision tables before it returns data or mutates state.
 */
export interface ManagedActionClaimContext {
  decisionId: string;
  operationId: string;
  runId: string;
  agentId: string;
  agentNodeId: string;
  capability: CapabilityRelation;
  resourceId: string;
  payloadDigest: string;
  executedAt: string;
}

export interface SecurityStore {
  upsertPrincipal(principal: AuthenticatedPrincipal): Promise<void>;
  getPrincipal(id: string): Promise<AuthenticatedPrincipal | null>;
  createDelegation(record: DelegationRecord): Promise<void>;
  getDelegation(id: string): Promise<DelegationRecord | null>;
  listDelegationsForRun(runId: string): Promise<DelegationRecord[]>;
  listDelegationsForAgent(agentId: string): Promise<DelegationRecord[]>;
  revokeDelegation(id: string, reason: string, revokedAt: string): Promise<DelegationRecord>;
  recordAuthorization(decision: AuthorizationDecision): Promise<void>;
  getAuthorizationForPolicy(policyDecisionId: string): Promise<AuthorizationDecision | null>;
  recordRiskAndTransition(
    decision: Omit<RiskDecision, "breakerState" | "breakerVersion">,
    requestedState: CircuitBreakerRecord["state"],
  ): Promise<{ risk: RiskDecision; breaker: CircuitBreakerRecord; previousState: CircuitBreakerRecord["state"] }>;
  getRiskForPolicy(policyDecisionId: string): Promise<RiskDecision | null>;
  getBreaker(agentId: string): Promise<CircuitBreakerRecord>;
  acknowledgeWarn(agentId: string, reason: string, acknowledgedAt: string): Promise<CircuitBreakerRecord>;
  resetBreaker(agentId: string, reason: string, resetAt: string): Promise<CircuitBreakerRecord>;
  restoreBreaker(
    snapshot: CircuitBreakerRecord,
    expectedVersion: number,
  ): Promise<CircuitBreakerRecord>;
  getLatestBaseline(agentId: string): Promise<BehavioralBaseline | null>;
  getBaseline(id: string): Promise<BehavioralBaseline | null>;
  saveBaseline(baseline: BehavioralBaseline): Promise<BehavioralBaseline>;
  readManagedResourceForClaim(
    input: ManagedActionClaimContext,
  ): Promise<ManagedResourceState | null>;
  applyManagedWrite(input: ManagedActionClaimContext): Promise<ManagedResourceState>;
  getManagedResourceState(resourceId: string): Promise<ManagedResourceState | null>;
}
