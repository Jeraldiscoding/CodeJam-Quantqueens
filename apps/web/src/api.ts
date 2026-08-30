import type { Agent, AgentRun, Message, SystemInfo } from "./types";

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

export interface AgentGraph {
  agent: GraphNode;
  owners: GraphNode[];
  capabilityEdges: GraphEdge[];
  impactEdges: GraphEdge[];
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
  wholeGraph: () => request<{ graph: GraphCatalog }>("/api/graph"),
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
};
