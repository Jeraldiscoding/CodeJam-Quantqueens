import { randomUUID } from "node:crypto";
import type { AgentRuntimeMediator, AgentRuntimePlan } from "./agent-runtime-mediator.js";
import type { AgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { demoAgents } from "./demo-graph.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { RunPolicyGate } from "./run-policy-gate.js";
import type { KnowledgeObservationService } from "./knowledge-observation.js";
import {
  appendRequiredRunEvent,
  type AppendRunEvent,
  type RunEventActor,
  type RunTimeline,
} from "./run-timeline.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
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
const isActiveRun = (run: AgentRun) =>
  run.status === "queued" ||
  run.status === "running" ||
  run.status === "awaiting_approval";
const legacyDemoInstructions =
  "Explain graph relationships clearly. Treat graph context as risk evidence, not permission to access anything beyond approved tools.";

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly activeProtectedActions = new Map<string, Set<Promise<void>>>();
  private readonly cancellationRequests = new Set<string>();
  private runtimeMediator: AgentRuntimeMediator | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly graphProvisioner?: AgentGraphProvisioner,
    private readonly runPolicyGate?: RunPolicyGate,
    private readonly knowledgeObserver?: KnowledgeObservationService,
    private readonly runTimeline?: RunTimeline,
  ) {}

  /** Production wiring installs this after ResourceGateway is constructed. */
  setRuntimeMediator(mediator: AgentRuntimeMediator): void {
    this.runtimeMediator = mediator;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    const initialSnapshot = this.store.snapshot();
    const interruptedRuns = initialSnapshot.runs.filter(
      (run) =>
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "awaiting_approval",
    );
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
    for (const run of interruptedRuns) {
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_CANCELLED",
        actor: this.agentActor(run.agentId, undefined, run.originPrincipalId),
        agentId: run.agentId,
        outcome: "cancelled",
        reasonCode: "SERVER_RESTARTED",
        reason: "The server restarted while this run was active.",
      });
    }
    if (this.runTimeline) {
      for (const run of initialSnapshot.runs.filter(
        (item) =>
          item.kind === "managed_action" &&
          (item.status === "completed" || item.status === "failed") &&
          item.completedAt !== null,
      )) {
        const terminalType = run.status === "completed" ? "RUN_COMPLETED" : "RUN_FAILED";
        const existing = (await this.runTimeline.list(run.id)).some(
          (event) => event.type === terminalType,
        );
        if (existing) continue;
        const agentName = initialSnapshot.agents.find((agent) => agent.id === run.agentId)?.name;
        const reason = run.status === "completed"
          ? run.output ?? "The managed action completed."
          : run.error ?? "The managed action did not complete.";
        await this.appendManagedTerminalEvent(run, agentName, reason);
      }
    }
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

    // A deleted Agent must not orphan or erase evidence. Finish any paused or
    // queued Run explicitly, then retain its compact metadata as the durable
    // authorization anchor used by the Run and timeline APIs.
    const nonTerminalRuns = this.store.snapshot().runs.filter(
      (run) =>
        run.agentId === id &&
        (run.status === "queued" ||
          run.status === "running" ||
          run.status === "awaiting_approval"),
    );
    for (const run of nonTerminalRuns) {
      const completedAt = now();
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_CANCELLED",
        occurredAt: completedAt,
        actor: this.agentActor(id, agent.name, run.originPrincipalId),
        agentId: id,
        outcome: "cancelled",
        reasonCode: "AGENT_DELETED",
        reason: "The Run was cancelled because its Agent was deleted; its audit history was retained.",
      });
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (!storedRun) return;
        storedRun.status = "cancelled";
        storedRun.error = "Run cancelled because its Agent was deleted";
        storedRun.completedAt = completedAt;
      });
    }

    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    // Keep the cancellation barrier raised until the durable Agent status is
    // stopped. Protected actions that began first are drained; actions that
    // arrive after this point fail before policy can create an execution
    // claim. Consequently stop never returns while an older action can still
    // reach its effect boundary.
    this.cancellationRequests.add(id);
    try {
      await this.drainExecutions(id);
      return await this.setStatus(id, "stopped");
    } finally {
      this.cancellationRequests.delete(id);
    }
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

  /**
   * Covers the small interval before a managed Run exists as well as the
   * complete middleware request. This prevents stop/start from allowing an
   * already-admitted request to resume under a newly-ready Agent.
   */
  beginManagedActionRequest(agentId: string): () => void {
    return this.beginAgentOperation(
      agentId,
      "Start the Agent before requesting an action",
    );
  }

  beginAgentProtectedAction(agentId: string): () => void {
    return this.beginAgentOperation(
      agentId,
      "The acting Agent is stopped and is not eligible to act",
    );
  }

  /**
   * Registers a protected action synchronously, before ResourceGateway's first
   * asynchronous boundary. stopAgent() holds its cancellation barrier while it
   * waits for every registered action, closing the stop/policy/claim race.
   */
  beginProtectedAction(runId: string): () => void {
    const run = this.getRun(runId);
    this.assertProtectedActionMayExecute(runId);
    return this.registerProtectedAction(run.agentId);
  }

  /**
   * Rechecks the in-memory stop barrier immediately before an execution claim.
   * The registered action lease makes this check race-safe: if stop starts just
   * after it, stop must still wait for the claim/effect path to finish.
   */
  assertProtectedActionMayExecute(runId: string): void {
    const run = this.getRun(runId);
    if (!isActiveRun(run)) {
      throw new HttpError(409, `Run ${run.id} is ${run.status} and cannot take new actions`);
    }
    this.assertAgentProtectedActionMayExecute(run.agentId);
  }

  assertAgentProtectedActionMayExecute(agentId: string): void {
    const agent = this.getAgent(agentId);
    if (this.cancellationRequests.has(agentId)) {
      throw new HttpError(409, "This Agent is stopping and cannot start a protected action");
    }
    if (agent.status === "stopped") {
      throw new HttpError(409, "This Agent is stopped and is not eligible to act");
    }
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    origin?: AuthenticatedPrincipal,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const release = this.beginAgentOperation(
      agentId,
      "Start the Agent before sending a message",
    );
    try {
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
      kind: "codex",
      ...(origin ? { originPrincipalId: origin.id } : {}),
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
      const activeRun = database.runs.find(
        (item) => item.agentId === agentId && isActiveRun(item),
      );
      if (activeRun?.status === "awaiting_approval") {
        throw new HttpError(
          409,
          "This Agent has a run waiting on a human approval. Approve or reject it first.",
        );
      }
      if (activeRun) {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
      try {
        await this.appendTimelineEvent({
        runId,
        type: "RUN_CREATED",
        occurredAt: timestamp,
        actor: this.runCreatedActor(agentId, agentAtStart.name, origin),
        agentId,
        outcome: "pending",
        reasonCode: "RUN_ACCEPTED",
        reason: "The request was accepted and queued for this Agent.",
        });
      } catch (error) {
        // The Run has not started yet, so compensate the JSON lifecycle write and
        // fail closed when its required audit record cannot be created.
        await this.store.mutate((database) => {
        const inserted = database.runs.find((item) => item.id === runId);
        if (!inserted || inserted.status !== "queued") return;
        database.runs = database.runs.filter((item) => item.id !== runId);
        database.messages = database.messages.filter((item) => item.id !== message.id);
        const storedAgent = database.agents.find((item) => item.id === agentId);
        const anotherActiveRun = database.runs.some(
          (item) => item.agentId === agentId && isActiveRun(item),
        );
        if (storedAgent?.status === "busy" && !anotherActiveRun) {
          storedAgent.status = agentAtStart.status;
          storedAgent.lastError = "Run timeline persistence failed; the run was not started";
          storedAgent.updatedAt = now();
        }
        });
        throw new HttpError(
          503,
          `Run timeline persistence failed; the run was not started: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (this.knowledgeObserver) {
        await this.captureKnowledge(agentId, runId, "prompt", prompt);
      }
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
    } finally {
      release();
    }
  }

  /** Creates a narrow Agent Run whose protected effect is brokered by ResourceGateway. */
  async createManagedActionRun(
    agentId: string,
    prompt: string,
    origin: AuthenticatedPrincipal,
  ): Promise<AgentRun> {
    const timestamp = now();
    const run: AgentRun = {
      id: randomUUID(),
      agentId,
      status: "running",
      policy: null,
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
      kind: "managed_action",
      originPrincipalId: origin.id,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agentId);
      if (!stored) throw new HttpError(404, "Agent not found");
      if (stored.status === "stopped") {
        throw new HttpError(409, "Start the Agent before requesting an action");
      }
      const activeRun = database.runs.find(
        (item) => item.agentId === agentId && isActiveRun(item),
      );
      if (activeRun?.status === "awaiting_approval") {
        throw new HttpError(
          409,
          "This Agent has a run waiting on a human approval. Approve or reject it first.",
        );
      }
      if (stored.status === "busy" || activeRun) {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      const snapshot = structuredClone(stored);
      stored.status = "busy";
      stored.lastError = null;
      stored.updatedAt = timestamp;
      return snapshot;
    });
    try {
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_CREATED",
        occurredAt: timestamp,
        actor: {
          principalId: origin.id,
          kind: origin.kind,
          displayName: origin.displayName,
          originPrincipalId: origin.id,
          agentId,
        },
        agentId,
        outcome: "pending",
        reasonCode: "MANAGED_ACTION_RUN_CREATED",
        reason: `${origin.displayName} started a protected action Run for this Agent.`,
        metadata: { runKind: "managed_action" },
      });
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_STARTED",
        occurredAt: timestamp,
        actor: this.agentActor(agentId, agentAtStart.name, origin),
        agentId,
        outcome: "pending",
        reasonCode: "MANAGED_ACTION_RUNTIME_STARTED",
        reason: "The managed action entered the protected middleware path.",
      });
    } catch (error) {
      await this.store.mutate((database) => {
        const inserted = database.runs.find((item) => item.id === run.id);
        const canCompensate =
          inserted?.agentId === agentId &&
          inserted.kind === "managed_action" &&
          inserted.status === "running";
        if (!canCompensate) return;
        database.runs = database.runs.filter((item) => item.id !== run.id);
        const stored = database.agents.find((item) => item.id === agentId);
        const anotherActiveRun = database.runs.some(
          (item) => item.agentId === agentId && isActiveRun(item),
        );
        if (stored?.status === "busy" && !anotherActiveRun) {
          stored.status = agentAtStart.status;
          stored.lastError = "Managed action timeline persistence failed; the action was not started";
          stored.updatedAt = now();
        }
      });
      throw new HttpError(503, `Managed action timeline persistence failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return run;
  }

  async finishManagedActionRun(
    runId: string,
    outcome: "completed" | "failed" | "awaiting_approval",
    reason: string,
  ): Promise<AgentRun> {
    const run = this.getRun(runId);
    if (run.kind !== "managed_action") throw new HttpError(409, "This is not a managed action Run");
    const finalized = await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId)!;
      const agent = database.agents.find((item) => item.id === run.agentId)!;
      const terminal = storedRun.status === "completed" ||
        storedRun.status === "failed" || storedRun.status === "cancelled";
      if (terminal) {
        if (storedRun.status !== outcome) {
          throw new HttpError(
            409,
            `Run ${runId} is already ${storedRun.status} and cannot be relabelled ${outcome}`,
          );
        }
        const storedReason = outcome === "completed" ? storedRun.output : storedRun.error;
        if (storedReason !== reason || !storedRun.completedAt) {
          throw new HttpError(409, `Run ${runId} terminal evidence does not match this retry`);
        }
        return { run: structuredClone(storedRun), agentName: agent.name };
      }
      const timestamp = now();
      storedRun.status = outcome;
      if (outcome === "completed") {
        storedRun.output = reason;
        storedRun.error = null;
      }
      if (outcome === "failed") {
        storedRun.error = reason;
        storedRun.output = null;
      }
      storedRun.completedAt = outcome === "awaiting_approval" ? null : timestamp;
      const anotherActiveRun = database.runs.some(
        (item) =>
          item.id !== storedRun.id &&
          item.agentId === storedRun.agentId &&
          isActiveRun(item),
      );
      if (agent.status !== "stopped" && !anotherActiveRun) {
        agent.status = "ready";
        agent.lastError = outcome === "failed" ? reason : null;
        agent.updatedAt = timestamp;
      }
      return { run: structuredClone(storedRun), agentName: agent.name };
    });
    if (outcome !== "awaiting_approval") {
      await this.appendManagedTerminalEvent(finalized.run, finalized.agentName, reason);
    }
    return this.getRun(runId);
  }

  private async appendManagedTerminalEvent(
    run: AgentRun,
    agentName: string | undefined,
    reason: string,
  ): Promise<void> {
    if (!this.runTimeline || !run.completedAt) return;
    const completed = run.status === "completed";
    await appendRequiredRunEvent(this.runTimeline, {
      id: `run-event:managed-terminal:${run.id}`,
      runId: run.id,
      type: completed ? "RUN_COMPLETED" : "RUN_FAILED",
      occurredAt: run.completedAt,
      actor: this.agentActor(run.agentId, agentName, run.originPrincipalId),
      agentId: run.agentId,
      outcome: completed ? "succeeded" : "failed",
      reasonCode: completed
        ? "MANAGED_ACTION_RUN_COMPLETED"
        : "MANAGED_ACTION_RUN_BLOCKED",
      reason,
    });
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
  async resumeRun(runId: string, reviewer?: AuthenticatedPrincipal): Promise<AgentRun> {
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
    if (run.pendingAction) {
      return this.resumeMediatedAction(run, agent);
    }
    const release = this.beginAgentOperation(
      agent.id,
      "Start the Agent before resuming this run",
    );
    try {
      await this.runPolicyGate.authorizeResume({
        runId: run.id,
        agentId: agent.id,
        prompt: run.prompt,
      });

      await this.appendTimelineEvent({
      runId: run.id,
      type: "APPROVAL_RESOLVED",
      actor: reviewer
        ? this.humanActor(reviewer, agent.id, run.originPrincipalId)
        : this.agentActor(agent.id, agent.name, run.originPrincipalId),
      agentId: agent.id,
      outcome: "allowed",
      reasonCode: "APPROVAL_CONSUMED",
      reason: "A reviewer approved this run and the approval was validated for the current graph.",
      ...(run.policy?.decisionId
        ? { decision: {
            decisionId: run.policy.decisionId,
            layer: "approval",
            result: "approved",
            reasonCode: "APPROVAL_CONSUMED",
          } as const }
        : {}),
      });

      const agentAtStart = await this.store.mutate((database) => {
        const storedAgent = database.agents.find((item) => item.id === agent.id);
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (!storedAgent) throw new HttpError(404, "Agent not found");
        if (!storedRun || storedRun.status !== "awaiting_approval") {
          throw new HttpError(409, "This Run is no longer waiting for approval");
        }
        if (storedAgent.status === "stopped") {
          throw new HttpError(409, "Start the Agent before resuming this run");
        }
        if (storedAgent.status === "busy") {
          throw new HttpError(409, "This Agent is already running");
        }
        const competingRun = database.runs.find(
          (item) => item.id !== run.id && item.agentId === agent.id && isActiveRun(item),
        );
        if (competingRun) {
          throw new HttpError(409, "This Agent already has another active Run");
        }
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
    } finally {
      release();
    }
  }

  private async resumeMediatedAction(run: AgentRun, agent: Agent): Promise<AgentRun> {
    if (!this.runtimeMediator) {
      throw new HttpError(503, "Protected-action mediation is unavailable");
    }
    const release = this.beginAgentOperation(
      agent.id,
      "Start the Agent before resuming this protected action",
    );
    try {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const storedAgent = database.agents.find((item) => item.id === agent.id);
        if (!storedRun || storedRun.status !== "awaiting_approval" || !storedRun.pendingAction) {
          throw new HttpError(409, "This protected action is no longer waiting for approval");
        }
        if (!storedAgent || storedAgent.status === "stopped") {
          throw new HttpError(409, "Start the Agent before resuming this protected action");
        }
        storedAgent.status = "busy";
        storedAgent.lastError = null;
        storedAgent.updatedAt = now();
      });
      const result = await this.runtimeMediator.resume({ run: this.getRun(run.id) });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id)!;
        const storedAgent = database.agents.find((item) => item.id === agent.id)!;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.error = null;
        storedRun.completedAt = completedAt;
        delete storedRun.pendingAction;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        storedAgent.status = "ready";
        storedAgent.lastError = null;
        storedAgent.updatedAt = completedAt;
      });
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_COMPLETED",
        occurredAt: completedAt,
        actor: this.agentActor(agent.id, agent.name, run.originPrincipalId),
        agentId: agent.id,
        outcome: "succeeded",
        reasonCode: "APPROVED_PROTECTED_ACTION_COMPLETED",
        reason: "The approved model-proposed action completed through the Resource Gateway.",
      });
      return this.getRun(run.id);
    } catch (error) {
      const completedAt = now();
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const storedAgent = database.agents.find((item) => item.id === agent.id);
        if (storedRun && storedRun.status === "awaiting_approval") {
          storedRun.status = "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          delete storedRun.pendingAction;
        }
        if (storedAgent && storedAgent.status !== "stopped") {
          storedAgent.status = "ready";
          storedAgent.lastError = message;
          storedAgent.updatedAt = completedAt;
        }
      });
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_FAILED",
        occurredAt: completedAt,
        actor: this.agentActor(agent.id, agent.name, run.originPrincipalId),
        agentId: agent.id,
        outcome: "failed",
        reasonCode: "APPROVED_PROTECTED_ACTION_FAILED",
        reason: message,
      });
      throw error;
    } finally {
      release();
    }
  }

  async rejectPendingMediatedAction(
    runId: string,
    reason: string,
  ): Promise<AgentRun | null> {
    const run = this.getRun(runId);
    if (run.status !== "awaiting_approval" || !run.pendingAction) return null;
    const completedAt = now();
    const response = `${run.pendingAction.modelOutput}\n\nMiddleware result: rejected by a human reviewer. Nothing changed.`;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id)!;
      const agent = database.agents.find((item) => item.id === run.agentId)!;
      storedRun.status = "failed";
      storedRun.error = `A reviewer rejected this protected action: ${reason}`;
      storedRun.completedAt = completedAt;
      delete storedRun.pendingAction;
      database.messages.push({
        id: randomUUID(),
        agentId: run.agentId,
        runId: run.id,
        role: "assistant",
        content: response,
        createdAt: completedAt,
      });
      if (agent.status !== "stopped") {
        agent.status = "ready";
        agent.lastError = null;
        agent.updatedAt = completedAt;
      }
    });
    await this.appendTimelineEvent({
      runId: run.id,
      type: "RUN_FAILED",
      occurredAt: completedAt,
      actor: this.agentActor(run.agentId, undefined, run.originPrincipalId),
      agentId: run.agentId,
      outcome: "failed",
      reasonCode: "APPROVAL_REJECTED",
      reason: `A reviewer rejected this protected action: ${reason}`,
    });
    return this.getRun(run.id);
  }

  /**
   * Closes a paused Run after a human refused it. Called by the approval
   * routes so a rejection actually ends the Run instead of leaving it hanging.
   */
  async rejectPendingRun(
    runId: string,
    reason: string,
    reviewer?: AuthenticatedPrincipal,
  ): Promise<AgentRun | null> {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run || run.status !== "awaiting_approval") return null;
    await this.appendTimelineEvent({
      runId,
      type: "APPROVAL_RESOLVED",
      actor: reviewer
        ? this.humanActor(reviewer, run.agentId, run.originPrincipalId)
        : this.agentActor(run.agentId, undefined, run.originPrincipalId),
      agentId: run.agentId,
      outcome: "blocked",
      reasonCode: "APPROVAL_REJECTED",
      reason,
      ...(run.policy?.decisionId
        ? { decision: {
            decisionId: run.policy.decisionId,
            layer: "approval",
            result: "rejected",
            reasonCode: "APPROVAL_REJECTED",
          } as const }
        : {}),
    });
    await this.finishBlockedRun(run.agentId, runId, run.policy ?? null, reason);
    return this.getRun(runId);
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    options: { skipPolicyGate?: boolean } = {},
  ): Promise<void> {
    const startedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt ??= startedAt;
      }
    });

    try {
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_STARTED",
        occurredAt: startedAt,
        actor: this.agentActor(agentAtStart.id, agentAtStart.name, run.originPrincipalId),
        agentId: agentAtStart.id,
        outcome: "pending",
        reasonCode: options.skipPolicyGate ? "RUN_RESUMED" : "RUN_STARTED",
        reason: options.skipPolicyGate
          ? "The approved run resumed and entered the Agent runtime."
          : "The run entered the Agent runtime.",
      });
      await this.appendTimelineEvent({
        runId: run.id,
        type: "AGENT_STARTED",
        occurredAt: startedAt,
        actor: this.agentActor(agentAtStart.id, agentAtStart.name, run.originPrincipalId),
        agentId: agentAtStart.id,
        outcome: "pending",
        reasonCode: "AGENT_EXECUTION_STARTED",
        reason: `${agentAtStart.name} started working on the run.`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = "failed";
          storedRun.error = `Run timeline persistence failed; execution was not started: ${detail}`;
          storedRun.completedAt = now();
        }
        if (agent && agent.status !== "stopped") {
          agent.status = "ready";
          agent.lastError = `Run timeline persistence failed; execution was not started: ${detail}`;
          agent.updatedAt = now();
        }
      });
      return;
    }

    let runtimePlan: AgentRuntimePlan | null = null;
    if (this.runtimeMediator) {
      try {
        runtimePlan = await this.runtimeMediator.prepare({ agent: agentAtStart, run });
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        await this.finishBlockedRun(
          agentAtStart.id,
          run.id,
          null,
          `Protected-action planning failed closed before Codex started: ${detail}`,
        );
        return;
      }
    }

    if (!options.skipPolicyGate) {
      const gated = await this.applyRunPolicy(agentAtStart, run, runtimePlan?.mode);
      if (!gated) return;
    }

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: runtimePlan?.prompt ?? this.runtimePrompt(run),
        threadId: agentAtStart.codexThreadId,
        ...(runtimePlan ? { sandboxModeOverride: runtimePlan.sandboxMode } : {}),
      });
      const mediated = runtimePlan && this.runtimeMediator
        ? await this.runtimeMediator.mediate({
            agent: agentAtStart,
            run,
            plan: runtimePlan,
            modelOutput: result.output,
          })
        : { output: result.output };
      if (mediated.approval) {
        const approval = mediated.approval;
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (!storedRun || !agent) return;
          storedRun.status = "awaiting_approval";
          storedRun.policy = approval.policy;
          storedRun.pendingAction = approval.pendingAction;
          storedRun.usage = result.usage;
          storedRun.error = null;
          agent.status = "ready";
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = now();
        });
        return;
      }
      const completedAt = now();
      await this.captureKnowledge(agentAtStart.id, run.id, "run_output", mediated.output);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = mediated.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: mediated.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      await this.appendTimelineEvent({
        runId: run.id,
        type: "RUN_COMPLETED",
        occurredAt: completedAt,
        actor: this.agentActor(agentAtStart.id, agentAtStart.name, run.originPrincipalId),
        agentId: agentAtStart.id,
        outcome: "succeeded",
        reasonCode: "RUN_COMPLETED",
        reason: "The Agent completed the run successfully.",
        metadata: result.usage ? { usage: result.usage } : {},
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
      await this.appendTimelineEvent({
        runId: run.id,
        type: cancelled ? "RUN_CANCELLED" : "RUN_FAILED",
        occurredAt: completedAt,
        actor: this.agentActor(agentAtStart.id, agentAtStart.name, run.originPrincipalId),
        agentId: agentAtStart.id,
        outcome: cancelled ? "cancelled" : "failed",
        reasonCode: cancelled ? "RUN_CANCELLED" : "RUNNER_FAILED",
        reason: message,
      });
    }
  }

  private async captureKnowledge(
    agentId: string,
    runId: string,
    sourceKind: "prompt" | "run_output",
    text: string,
  ): Promise<void> {
    if (!this.knowledgeObserver) return;
    try {
      await this.knowledgeObserver.observeText({ agentId, runId, sourceKind, text });
    } catch {
      // Learning is supplementary evidence. A failed extraction must never
      // block or fail the user's Agent run.
    }
  }

  /**
   * Runs the pre-run policy check. Returns false when the Run must not reach
   * the runner, having already recorded the outcome on the Run itself.
   */
  private async applyRunPolicy(
    agentAtStart: Agent,
    run: AgentRun,
    executionMode?: AgentRuntimePlan["mode"],
  ): Promise<boolean> {
    if (!this.runPolicyGate) return true;

    let summary: RunPolicySummary;
    try {
      summary = await this.runPolicyGate.evaluateRun({
        runId: run.id,
        agentId: agentAtStart.id,
        prompt: run.prompt,
        ...(executionMode ? { executionMode } : {}),
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
      await this.appendPolicyDecision(
        agentAtStart,
        run.id,
        summary,
        "allowed",
        run.originPrincipalId,
      );
      return true;
    }

    if (summary.result === "DENY") {
      const denialDetail = summary.reasonCode === "RISK_ABOVE_DENY_THRESHOLD"
        ? `blast radius ${summary.riskScore} exceeds the deny threshold of ${summary.denyThreshold}`
        : summary.intentExplanation;
      await this.appendPolicyDecision(
        agentAtStart,
        run.id,
        summary,
        "blocked",
        run.originPrincipalId,
      );
      await this.finishBlockedRun(
        agentAtStart.id,
        run.id,
        summary,
        `Policy denied this run (${summary.reasonCode}): ${denialDetail}.`,
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
    await this.appendPolicyDecision(
      agentAtStart,
      run.id,
      summary,
      "warned",
      run.originPrincipalId,
    );
    await this.appendTimelineEvent({
      runId: run.id,
      type: "APPROVAL_PAUSED",
      actor: this.agentActor(agentAtStart.id, agentAtStart.name, run.originPrincipalId),
      agentId: agentAtStart.id,
      outcome: "warned",
      reasonCode: summary.reasonCode,
      reason: summary.intentExplanation,
      ...(summary.decisionId
        ? { decision: {
            decisionId: summary.decisionId,
            layer: "approval",
            result: "pending",
            reasonCode: summary.reasonCode,
          } as const }
        : {}),
    });
    return false;
  }

  private async finishBlockedRun(
    agentId: string,
    runId: string,
    summary: RunPolicySummary | null,
    message: string,
  ): Promise<void> {
    const runAtFinish = this.getRun(runId);
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
    await this.appendTimelineEvent({
      runId,
      type: "RUN_FAILED",
      occurredAt: completedAt,
      actor: this.agentActor(agentId, undefined, runAtFinish.originPrincipalId),
      agentId,
      outcome: "failed",
      reasonCode: summary?.reasonCode ?? "RUN_BLOCKED",
      reason: message,
      ...(summary?.decisionId
        ? { decision: {
            decisionId: summary.decisionId,
            layer: "risk",
            result: "BLOCK",
            reasonCode: summary.reasonCode,
          } as const }
        : {}),
    });
  }

  private async appendPolicyDecision(
    agent: Agent,
    runId: string,
    summary: RunPolicySummary,
    outcome: "allowed" | "warned" | "blocked",
    originPrincipalId?: string,
  ): Promise<void> {
    await this.appendTimelineEvent({
      runId,
      type: "RISK_DECIDED",
      occurredAt: summary.evaluatedAt,
      actor: this.agentActor(agent.id, agent.name, originPrincipalId),
      agentId: agent.id,
      outcome,
      reasonCode: summary.reasonCode,
      reason: summary.result === "ALLOW"
        ? "The current policy and graph context allowed the run to continue."
        : summary.intentExplanation,
      decision: {
        ...(summary.decisionId ? { decisionId: summary.decisionId } : {}),
        layer: "risk",
        result: summary.result,
        reasonCode: summary.reasonCode,
      },
      metadata: {
        riskScore: summary.riskScore,
        reviewThreshold: summary.reviewThreshold,
        denyThreshold: summary.denyThreshold,
        factors: summary.riskFactors.map((factor) => ({
          id: factor.id,
          label: factor.label,
          riskWeight: factor.riskWeight,
          classification: factor.classification,
          path: factor.path,
        })),
      },
    });
  }

  private appendTimelineEvent(input: AppendRunEvent): Promise<unknown> {
    return this.runTimeline?.append(input) ?? Promise.resolve();
  }

  private agentActor(
    agentId: string,
    displayName?: string,
    origin?: AuthenticatedPrincipal | string,
  ): RunEventActor {
    const originPrincipalId = typeof origin === "string" ? origin : origin?.id;
    return {
      principalId: `agent:${agentId}`,
      kind: "agent",
      agentId,
      ...(originPrincipalId ? { originPrincipalId } : {}),
      ...(typeof origin === "object" ? { originDisplayName: origin.displayName } : {}),
      ...(displayName ? { displayName } : {}),
    };
  }

  private runCreatedActor(
    agentId: string,
    agentName: string,
    origin?: AuthenticatedPrincipal,
  ): RunEventActor {
    if (!origin) return this.agentActor(agentId, agentName);
    return this.humanActor(origin, agentId, origin.id);
  }

  private humanActor(
    principal: AuthenticatedPrincipal,
    agentId: string,
    originPrincipalId?: string,
  ): RunEventActor {
    return {
      principalId: principal.id,
      kind: principal.kind,
      displayName: principal.displayName,
      originPrincipalId: originPrincipalId ?? principal.id,
      ...(originPrincipalId === undefined || originPrincipalId === principal.id
        ? { originDisplayName: principal.displayName }
        : {}),
      agentId,
    };
  }

  private runtimePrompt(run: AgentRun): string {
    const policy = this.getRun(run.id).policy;
    if (policy?.intent !== "informational") return run.prompt;
    return [
      "Request mode: explanation only.",
      "Answer the user's question without editing files or running mutating commands.",
      "Keep the answer focused on the Agent's user-facing purpose. Do not present internal guardrails as responsibilities unless asked.",
      "",
      "User request:",
      run.prompt,
    ].join("\n");
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      const executingRun = database.runs.find(
        (run) =>
          run.agentId === id &&
          (run.status === "queued" || run.status === "running"),
      );
      if (status === "ready" && (agent.status === "busy" || executingRun)) {
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
      await this.drainExecutions(agentId);
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  private async drainExecutions(agentId: string): Promise<void> {
    await this.runner.cancel(agentId);
    // A request lease may hand off to activeExecutions while stop is already
    // waiting. Re-snapshot until both registries are empty so that handoff
    // cannot escape the drain.
    for (;;) {
      const executions: Promise<void>[] = [];
      const runnerExecution = this.activeExecutions.get(agentId);
      if (runnerExecution) executions.push(runnerExecution);
      executions.push(...(this.activeProtectedActions.get(agentId) ?? []));
      if (executions.length === 0) return;
      await Promise.all(executions);
    }
  }

  private beginAgentOperation(agentId: string, stoppedMessage: string): () => void {
    const agent = this.getAgent(agentId);
    if (this.cancellationRequests.has(agentId)) {
      throw new HttpError(409, "This Agent is stopping and cannot start new work");
    }
    if (agent.status === "stopped") {
      throw new HttpError(409, stoppedMessage);
    }
    return this.registerProtectedAction(agentId);
  }

  private registerProtectedAction(agentId: string): () => void {
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const active = this.activeProtectedActions.get(agentId) ?? new Set<Promise<void>>();
    active.add(completion);
    this.activeProtectedActions.set(agentId, active);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.delete(completion);
      if (active.size === 0) this.activeProtectedActions.delete(agentId);
      settle();
    };
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
      const existing = this.store.snapshot().agents.find((agent) => agent.id === demo.id);
      if (existing) {
        if (existing.instructions === legacyDemoInstructions) {
          const upgraded = await this.store.mutate((database) => {
            const agent = database.agents.find((item) => item.id === demo.id)!;
            agent.instructions = demo.instructions;
            agent.updatedAt = now();
            return structuredClone(agent);
          });
          await this.workspaces.writeInstructions(upgraded);
        }
        continue;
      }
      const timestamp = now();
      const demoAgent: Agent = {
        id: demo.id,
        name: demo.name,
        description: demo.description,
        instructions: demo.instructions,
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
