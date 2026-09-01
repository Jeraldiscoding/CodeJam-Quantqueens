export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/** What the pre-run policy gate decided, stored alongside the Run itself. */
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

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  policy?: RunPolicySummary | null;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  kind?: "codex" | "managed_action";
  originPrincipalId?: string;
  pendingAction?: {
    decisionId: string;
    approvalRequestId: string;
    capability: "CAN_READ" | "CAN_WRITE";
    targetNodeId: string;
    proposalReason: string;
    modelOutput: string;
  };
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /** Narrows one execution without weakening the server-wide sandbox setting. */
  sandboxModeOverride?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
import type { GraphEdge, GraphNode } from "./graph-types.js";
