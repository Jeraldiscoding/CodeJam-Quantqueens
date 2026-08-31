import type { Agent, AgentRun, Message, RunTimelineItem, SystemInfo } from "./types";

export interface GraphNode {
  id: string;
  type: "human" | "agent" | "asset" | "data_category" | "run";
  label: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskWeight: number;
  classification: "public" | "internal" | "confidential" | "restricted";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  status: "authorized" | "attempted" | "actual" | "denied";
  runId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface GraphObservation {
  id: string;
  agentNodeId: string;
  runId?: string;
  sourceNodeId: string;
  targetNodeId: string;
  relation: "DEPLOYS_TO" | "PROCESSES" | "CONTAINS" | "READS_FROM" | "CALLS" | "DEPENDS_ON";
  state: "observed" | "confirmed" | "rejected";
  confidence: number;
  sourceKind: "prompt" | "run_output";
  evidence: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGraph {
  agent: GraphNode;
  owners: GraphNode[];
  capabilityEdges: GraphEdge[];
  impactEdges: GraphEdge[];
  observationEdges: GraphObservation[];
  activity: Record<"attempted" | "actual" | "denied", GraphEdge[]>;
  reachableNodes: GraphNode[];
  paths: Array<{ nodeIds: string[]; edgeIds: string[] }>;
}

export interface BlastRadius {
  agentId: string;
  score: number;
  threshold: number;
  decision: "ALLOW" | "REVIEW_REQUIRED";
  targets: Array<{ node: GraphNode; path: { nodeIds: string[]; edgeIds: string[] } }>;
  paths: Array<{ nodeIds: string[]; edgeIds: string[] }>;
}

export interface GraphCatalog {
  nodes: GraphNode[];
  edges: GraphEdge[];
  observations: GraphObservation[];
}

export interface PromptGraphSuggestion {
  existingNodeId: string | null;
  label: string;
  capability: "CAN_READ" | "CAN_WRITE" | "CAN_CALL" | "CAN_USE";
  classification: GraphNode["classification"];
  rationale: string;
}

export interface PromptAnalysis {
  intent: "informational" | "action" | "suspicious";
  reasonCode: string;
  explanation: string;
  signals: string[];
  suggestions: PromptGraphSuggestion[];
}

export interface BehavioralBaseline {
  id: string;
  revision: number;
  minimumHistory: number;
  historyWindowRunLimit: number;
  historyWindowRunCount: number;
  historyWindowStartAt: string | null;
  historyWindowEndAt: string | null;
  eligibleRunCount: number;
  sourceRunIds: string[];
  normalScope: Array<{ capability: string; targetNodeId: string }>;
  typicalBlastRadius: number;
  maximumBlastRadius: number;
  calculatedAt: string;
}

export interface CircuitBreaker {
  state: "NORMAL" | "WARN" | "TRIPPED";
  version: number;
  reasonCode: string;
  explanation: string;
  updatedAt: string;
}

export interface ManagedActionResult {
  run: AgentRun;
  outcome: {
    status: "executed" | "approval_required" | "denied";
    authorization?: { result: "ALLOW" | "DENY"; reasonCode: string };
    risk?: {
      result: "ALLOW" | "WARN" | "BLOCK";
      explanation: string;
      factors: Array<{ code: string; explanation: string }>;
    };
    result?: { summary: string };
  };
}

export type ManagedCapability = "CAN_READ" | "CAN_WRITE" | "CAN_CALL" | "CAN_USE";

export interface ManagedActionOptions {
  capability?: ManagedCapability;
  /**
   * Deliberately untrusted demo input. The server schema discards this field
   * and resolves the authenticated principal from the request context.
   */
  claimedPrincipalId?: string;
}

export interface ResourceImpact {
  blastRadius: number;
  targets: Array<{
    node: GraphNode;
    path: { nodeIds: string[]; edgeIds: string[] };
  }>;
}

export interface SafetyEvidence {
  schemaVersion: 1;
  run: {
    id: string;
    agentId: string;
    status: AgentRun["status"];
    createdAt: string;
    completedAt: string | null;
  };
  action: {
    operationId: string;
    capability: string;
    resourceId: string;
    resourceLabel: string;
  };
  identity: {
    originPrincipalId: string;
    rootAgentId: string;
    actorAgentId: string;
    delegationChain: Array<{
      id: string;
      parentAgentId: string;
      childAgentId: string;
      depth: number;
      effectiveCapabilities: string[];
    }>;
  };
  verdict: {
    permission: "ALLOW" | "DENY";
    safety: "ALLOW" | "WARN" | "BLOCK" | "NOT_EVALUATED";
    effect: "COMPLETED" | "PREVENTED" | "WAITING_FOR_REVIEW" | "FAILED" | "UNKNOWN";
    explanation: string;
  };
  historicalContext: null | {
    baselineId: string;
    revision: number;
    sourceRunIds: string[];
    trustedRunCount: number;
    normalScope: Array<{ capability: string; targetNodeId: string }>;
    maximumBlastRadius: number;
    factors: Array<{ code: string; explanation: string; contribution: number }>;
  };
  impactAtDecision: {
    blastRadius: number;
    targets: Array<{ id: string; label: string; path: string[] }>;
  };
  effectEvidence: {
    policyClaimed: boolean;
    completionEventRecorded: boolean;
    durableStateLastOperationId: string | null;
    durableStateChangedByThisAction: boolean;
  };
  timeline: { eventCount: number; firstSequence: number; lastSequence: number };
  coverage: {
    scope: "managed_resource_actions";
    label: string;
    guarantee: string;
    limitation: string;
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

async function managedActionRequest(
  agentId: string,
  targetNodeId: string,
  content: string,
  options: ManagedActionOptions = {},
): Promise<ManagedActionResult> {
  const response = await fetch(`/api/agents/${agentId}/managed-actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    },
    body: JSON.stringify({
      capability: options.capability ?? "CAN_WRITE",
      targetNodeId,
      payload: { content, source: "protected-action-center" },
      ...(options.claimedPrincipalId
        ? { claimedPrincipalId: options.claimedPrincipalId }
        : {}),
    }),
  });
  const data = (await response.json().catch(() => ({}))) as ManagedActionResult & { error?: string };
  // A circuit-breaker denial is a successful, explainable protected outcome.
  if (!response.ok && response.status !== 403) {
    throw new ApiError(data.error ?? "Managed action request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  wholeGraph: () => request<{ graph: GraphCatalog }>("/api/graph", {
    // The Network Graph has an explicit refresh control. Do not let the
    // browser satisfy that refresh from a cached response.
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  }),
  graph: (id: string) => request<{ graph: AgentGraph }>("/api/agents/" + id + "/graph"),
  blastRadius: (id: string) =>
    request<{ blastRadius: BlastRadius }>("/api/agents/" + id + "/blast-radius"),
  createGraphNode: (body: {
    type: "human" | "asset" | "data_category";
    label: string;
    classification: GraphNode["classification"];
  }) =>
    request<{ node: GraphNode }>("/api/graph/nodes", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  createGraphRelationship: (
    agentId: string,
    body: { sourceId: string; targetId: string; relation: string },
  ) =>
    request<{ edge: GraphEdge }>(`/api/agents/${agentId}/graph/relationships`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  analyzePrompt: (agentId: string, prompt: string) =>
    request<{ analysis: PromptAnalysis }>(`/api/agents/${agentId}/prompt-analysis`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  confirmPromptSuggestion: (agentId: string, suggestion: PromptGraphSuggestion) =>
    request<{ result: { node: GraphNode; edge: GraphEdge } }>(
      `/api/agents/${agentId}/graph/suggestions/confirm`,
      {
        method: "POST",
        body: JSON.stringify({
          ...(suggestion.existingNodeId ? { existingNodeId: suggestion.existingNodeId } : {}),
          label: suggestion.label,
          capability: suggestion.capability,
          classification: suggestion.classification,
        }),
      },
    ),
  observations: (agentId: string) =>
    request<{ observations: GraphObservation[] }>(`/api/agents/${agentId}/observations`),
  resolveObservation: (
    agentId: string,
    observationId: string,
    resolution: "confirm" | "reject",
  ) => request<{ observation: GraphObservation }>(
    `/api/agents/${agentId}/observations/${observationId}/${resolution}`,
    { method: "POST" },
  ),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runEvents: (id: string) =>
    request<{ events: RunTimelineItem[] }>(`/api/runs/${id}/events`),
  behaviorBaseline: (agentId: string) =>
    request<{ baseline: BehavioralBaseline }>(`/api/agents/${agentId}/behavior-baseline`),
  latestSafetyEvidence: (agentId: string) =>
    request<{ evidence: SafetyEvidence | null }>(`/api/agents/${agentId}/safety-evidence/latest`),
  circuitBreaker: (agentId: string) =>
    request<{ circuitBreaker: CircuitBreaker }>(`/api/agents/${agentId}/circuit-breaker`),
  resetCircuitBreaker: (agentId: string, reason: string) =>
    request<{ circuitBreaker: CircuitBreaker }>(`/api/agents/${agentId}/circuit-breaker/reset`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  resourceImpact: (resourceId: string) =>
    request<{ downstream: ResourceImpact }>(`/api/graph/resources/${resourceId}/impact`),
  managedAction: (
    agentId: string,
    targetNodeId: string,
    content: string,
    options?: ManagedActionOptions,
  ) => managedActionRequest(agentId, targetNodeId, content, options),
  approveRequest: (approvalId: string, reason: string) =>
    request<{ approvalRequest: { id: string; status: string } }>(
      `/api/policy/approvals/${approvalId}/approve`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  rejectRequest: (approvalId: string, reason: string) =>
    request<{ approvalRequest: { id: string; status: string } }>(
      `/api/policy/approvals/${approvalId}/reject`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  resumeRun: (runId: string) =>
    request<{ run: AgentRun }>(`/api/runs/${runId}/resume`, { method: "POST" }),
};
