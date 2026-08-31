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
  createdAt: string;
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
