import type { Agent, AgentRun, RunPolicySummary } from "./types.js";

export interface AgentRuntimePlan {
  mode: "protected_action_planner";
  prompt: string;
  sandboxMode: "read-only";
  managedResourceIds: string[];
}

export interface AgentRuntimeMediator {
  /** Returns null when this is an ordinary Agent turn. */
  prepare(input: { agent: Agent; run: AgentRun }): Promise<AgentRuntimePlan | null>;

  /** Interprets the model's bounded proposal before the Run is finalized. */
  mediate(input: {
    agent: Agent;
    run: AgentRun;
    plan: AgentRuntimePlan;
    modelOutput: string;
  }): Promise<{
    output: string;
    approval?: {
      policy: RunPolicySummary;
      pendingAction: NonNullable<AgentRun["pendingAction"]>;
    };
  }>;

  resume(input: { run: AgentRun }): Promise<{ output: string }>;
}
