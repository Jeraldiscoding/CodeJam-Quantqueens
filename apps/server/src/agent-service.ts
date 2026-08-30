import { randomUUID } from "node:crypto";
import type { AgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { demoAgents } from "./demo-graph.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { RunPolicyGate } from "./run-policy-gate.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunPolicySummary,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly graphProvisioner?: AgentGraphProvisioner,
    private readonly runPolicyGate?: RunPolicyGate,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (
          run.status === "queued" ||
          run.status === "running" ||
          run.status === "awaiting_approval"
        ) {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    await this.seedDemoAgent();
    await this.reconcileGraphNodes();
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    await this.syncGraphNode(agent);
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    await this.syncGraphNode(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      policy: null,
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const paused = database.runs.find(
        (item) => item.agentId === agentId && item.status === "awaiting_approval",
      );
      if (paused) {
        throw new HttpError(
          409,
          "This Agent has a run waiting on a human approval. Approve or reject it first.",
        );
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  /**
   * Resumes a Run that the policy gate paused. The approval is spent here, and
   * spending it fails if the Agent graph changed after the human approved.
   */
  async resumeRun(runId: string): Promise<AgentRun> {
    const run = this.getRun(runId);
    if (run.status !== "awaiting_approval") {
      throw new HttpError(409, `Run ${runId} is ${run.status} and is not awaiting approval`);
    }
    if (!this.runPolicyGate) {
      throw new HttpError(503, "No policy gate is configured on this server");
    }
    const agent = this.getAgent(run.agentId);
    if (agent.status === "stopped") {
      throw new HttpError(409, "Start the Agent before resuming this run");
    }
    if (agent.status === "busy") {
      throw new HttpError(409, "This Agent is already running");
    }

    await this.runPolicyGate.authorizeResume({
      runId: run.id,
      agentId: agent.id,
      prompt: run.prompt,
    });

    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (!storedAgent) throw new HttpError(404, "Agent not found");
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = now();
      return snapshot;
    });

    const execution = this.executeRun(agentAtStart, run, { skipPolicyGate: true });
    this.activeExecutions.set(agent.id, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agent.id) === execution) {
          this.activeExecutions.delete(agent.id);
        }
      })
      .catch(() => undefined);
    return this.getRun(runId);
  }

  /**
   * Closes a paused Run after a human refused it. Called by the approval
   * routes so a rejection actually ends the Run instead of leaving it hanging.
   */
  async rejectPendingRun(runId: string, reason: string): Promise<AgentRun | null> {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run || run.status !== "awaiting_approval") return null;
    await this.finishBlockedRun(run.agentId, runId, run.policy ?? null, reason);
    return this.getRun(runId);
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    options: { skipPolicyGate?: boolean } = {},
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    if (!options.skipPolicyGate) {
      const gated = await this.applyRunPolicy(agentAtStart, run);
      if (!gated) return;
    }

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  /**
   * Runs the pre-run policy check. Returns false when the Run must not reach
   * the runner, having already recorded the outcome on the Run itself.
   */
  private async applyRunPolicy(agentAtStart: Agent, run: AgentRun): Promise<boolean> {
    if (!this.runPolicyGate) return true;

    let summary: RunPolicySummary;
    try {
      summary = await this.runPolicyGate.evaluateRun({
        runId: run.id,
        agentId: agentAtStart.id,
        prompt: run.prompt,
      });
    } catch (reason) {
      // A policy layer that cannot reach a verdict must fail closed.
      const detail = reason instanceof Error ? reason.message : String(reason);
      await this.finishBlockedRun(
        agentAtStart.id,
        run.id,
        null,
        `Policy evaluation failed, so this run was not started: ${detail}`,
      );
      return false;
    }

    if (summary.result === "ALLOW") {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) storedRun.policy = summary;
      });
      return true;
    }

    if (summary.result === "DENY") {
      await this.finishBlockedRun(
        agentAtStart.id,
        run.id,
        summary,
        `Policy denied this run (${summary.reasonCode}): blast radius ${summary.riskScore} exceeds the deny threshold of ${summary.denyThreshold}.`,
      );
      return false;
    }

    const completedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      if (storedRun) {
        storedRun.status = "awaiting_approval";
        storedRun.policy = summary;
        storedRun.error = null;
      }
      if (agent && agent.status !== "stopped") {
        agent.status = "ready";
        agent.lastError = null;
        agent.updatedAt = completedAt;
      }
    });
    return false;
  }

  private async finishBlockedRun(
    agentId: string,
    runId: string,
    summary: RunPolicySummary | null,
    message: string,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      if (storedRun) {
        storedRun.status = "failed";
        storedRun.error = message;
        storedRun.policy = summary;
        storedRun.completedAt = completedAt;
      }
      if (agent && agent.status !== "stopped") {
        // A refusal is a correct outcome, not an Agent malfunction.
        agent.status = "ready";
        agent.lastError = message;
        agent.updatedAt = completedAt;
      }
    });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private async reconcileGraphNodes(): Promise<void> {
    if (!this.graphProvisioner) return;
    const agents = this.store.snapshot().agents;
    for (const agent of agents) {
      await this.syncGraphNode(agent);
    }
  }

  private async seedDemoAgent(): Promise<void> {
    if (!this.config.seedDemoData) return;
    let seededNewAgent = false;
    for (const demo of Object.values(demoAgents)) {
      if (this.store.snapshot().agents.some((agent) => agent.id === demo.id)) continue;
      const timestamp = now();
      const demoAgent: Agent = {
        id: demo.id,
        name: demo.name,
        description: demo.description,
        instructions:
          "Explain graph relationships clearly. Treat graph context as risk evidence, not permission to access anything beyond approved tools.",
        status: "ready",
        workspacePath: this.workspaces.workspacePath(demo.id),
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await this.workspaces.create(demoAgent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.workspaces.writeInstructions(demoAgent);
      }
      await this.store.mutate((database) => {
        if (!database.agents.some((agent) => agent.id === demo.id)) {
          database.agents.push(demoAgent);
          seededNewAgent = true;
        }
      });
    }
    if (seededNewAgent) {
      await this.store.mutate((database) => {
        const releaseGuardian = database.agents.find(
          (agent) => agent.id === demoAgents.releaseGuardian.id,
        );
        if (releaseGuardian) releaseGuardian.updatedAt = now();
      });
    }
  }

  private async syncGraphNode(agent: Agent): Promise<void> {
    if (!this.graphProvisioner) return;
    try {
      await this.graphProvisioner.provisionAgent(agent);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      await this.store.mutate((database) => {
        const stored = database.agents.find((item) => item.id === agent.id);
        if (stored) {
          stored.lastError = `Knowledge Graph synchronization failed: ${detail}`;
          stored.updatedAt = now();
        }
      });
    }
  }
}
