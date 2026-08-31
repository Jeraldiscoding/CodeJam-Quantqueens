import type { CapabilityRelation } from "./policy-store.js";

export const principalRoles = ["viewer", "operator", "approver", "admin"] as const;
export type PrincipalRole = (typeof principalRoles)[number];

export interface AuthenticatedPrincipal {
  id: string;
  kind: "human" | "system";
  displayName: string;
  role: PrincipalRole;
  authenticationSource: "bearer_token" | "local_loopback" | "system";
}

export interface DelegationScope {
  capability: CapabilityRelation;
  targetNodeId: string;
}

export interface DelegationRecord {
  id: string;
  runId: string;
  originPrincipalId: string;
  parentAgentId: string;
  childAgentId: string;
  parentDelegationId?: string;
  depth: number;
  requestedScope: DelegationScope[];
  effectiveScope: DelegationScope[];
  status: "active" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  reason: string;
}

export interface ExecutionIdentity {
  principal: AuthenticatedPrincipal;
  runId: string;
  rootAgentId: string;
  actorAgentId: string;
  actorAgentNodeId: string;
  /** Human-readable Agent label; originPrincipal display stays separate. */
  actorAgentDisplayName?: string;
  delegation?: DelegationRecord;
  delegationChain: DelegationRecord[];
}

export interface AuthorizationDecision {
  id: string;
  policyDecisionId: string;
  runId: string;
  originPrincipalId: string;
  actorAgentId: string;
  delegationId?: string;
  role: PrincipalRole;
  capability: CapabilityRelation;
  targetNodeId: string;
  result: "ALLOW" | "DENY";
  reasonCode: string;
  matchedCapabilityId?: string;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface RiskFactor {
  code:
    | "NOVEL_RESOURCE"
    | "BLAST_RADIUS_EXPANSION"
    | "SENSITIVE_RESOURCE"
    | "SENSITIVE_DOWNSTREAM"
    | "DELEGATION_DEPTH"
    | "BREAKER_WARN_PENDING"
    | "BREAKER_ALREADY_TRIPPED";
  expected: string | number | boolean | null;
  observed: string | number | boolean;
  contribution: number;
  explanation: string;
  path?: string[];
}

export interface BehavioralBaseline {
  id: string;
  agentId: string;
  revision: number;
  minimumHistory: number;
  /** Maximum number of recent completed Runs whose events may be aggregated. */
  historyWindowRunLimit: number;
  /** Number of completed Runs actually inspected in this immutable window. */
  historyWindowRunCount: number;
  historyWindowStartAt: string | null;
  historyWindowEndAt: string | null;
  eligibleRunCount: number;
  sourceRunIds: string[];
  normalScope: DelegationScope[];
  typicalBlastRadius: number;
  maximumBlastRadius: number;
  typicalDelegationDepth: number;
  inclusionPolicy: string;
  calculatedAt: string;
}

export interface CircuitBreakerRecord {
  scopeType: "agent";
  scopeId: string;
  state: "NORMAL" | "WARN" | "TRIPPED";
  version: number;
  reasonCode: string;
  explanation: string;
  evidence: Record<string, unknown>;
  updatedAt: string;
}

export interface RiskDecision {
  id: string;
  policyDecisionId: string;
  authorizationDecisionId: string;
  runId: string;
  actorAgentId: string;
  targetNodeId: string;
  result: "ALLOW" | "WARN" | "BLOCK";
  reasonCode: string;
  score: number;
  warnThreshold: number;
  blockThreshold: number;
  graphRevision: string;
  baselineId?: string;
  baselineRevision?: number;
  breakerState: CircuitBreakerRecord["state"];
  breakerVersion: number;
  factors: RiskFactor[];
  explanation: string;
  createdAt: string;
}

export interface ManagedResourceState {
  resourceId: string;
  revision: number;
  valueDigest: string;
  lastOperationId: string;
  updatedAt: string;
}
