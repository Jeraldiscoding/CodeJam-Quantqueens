export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunPolicySummary {
  result: "ALLOW" | "DENY" | "REVIEW_REQUIRED";
  reasonCode: string;
  intent: "informational" | "action" | "suspicious";
  intentExplanation: string;
  riskScore: number;
  reviewThreshold: number;
  denyThreshold: number;
  decisionId: string | null;
  approvalRequestId: string | null;
  evaluatedAt: string;
  riskFactors: Array<{
    id: string;
    label: string;
    riskWeight: number;
    classification: string;
    path: string[];
  }>;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  policy?: RunPolicySummary | null;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export type RunEventType =
  | "RUN_CREATED"
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_CANCELLED"
  | "AGENT_STARTED"
  | "AGENT_DELEGATED"
  | "DELEGATION_REVOKED"
  | "ACTION_REQUESTED"
  | "RESOURCE_ACCESS_ATTEMPTED"
  | "AUTHORIZATION_DECIDED"
  | "RISK_DECIDED"
  | "ACTION_ALLOWED"
  | "ACTION_WARNED"
  | "ACTION_BLOCKED"
  | "ACTION_COMPLETED"
  | "ACTION_FAILED"
  | "CIRCUIT_BREAKER_TRANSITIONED"
  | "APPROVAL_PAUSED"
  | "APPROVAL_RESOLVED";

export interface RunTimelineItem {
  id: string;
  schemaVersion: 1;
  runId: string;
  sequence: number;
  type: RunEventType;
  occurredAt: string;
  actor: {
    principalId: string;
    kind: "human" | "agent" | "delegated_agent" | "system";
    displayName?: string;
    originPrincipalId?: string;
    originDisplayName?: string;
    agentId?: string;
    parentAgentId?: string;
  };
  agentId?: string;
  action?: { operation: string; capability?: string; toolName?: string };
  resource?: { resourceId: string; label?: string; kind?: string };
  decision?: {
    decisionId?: string;
    layer: "authorization" | "risk" | "circuit_breaker" | "approval";
    result: string;
    reasonCode?: string;
  };
  delegation?: {
    delegationId: string;
    parentAgentId: string;
    childAgentId: string;
    depth: number;
    effectiveCapabilities: string[];
  };
  correlationId?: string;
  causationId?: string;
  outcome: "pending" | "allowed" | "warned" | "blocked" | "succeeded" | "failed" | "cancelled";
  reasonCode: string;
  reason: string;
  metadata: Record<string, unknown>;
  summary: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
