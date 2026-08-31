import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import type { RunTimeline } from "./run-timeline.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import { SqliteRunTimelineStore } from "./sqlite-run-timeline-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];
const databases: MiddlewareDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture(
  runner?: AgentRunner,
  timelineOverride?: RunTimeline | ((database: MiddlewareDatabase) => RunTimeline),
) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-timeline-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "test-model",
  });
  const database = new MiddlewareDatabase(path.join(root, "data", "middleware.db"));
  await database.initialize();
  databases.push(database);
  const timeline = typeof timelineOverride === "function"
    ? timelineOverride(database)
    : timelineOverride ?? new SqliteRunTimelineStore(database);
  const resolvedRunner: AgentRunner = runner ?? {
    run: async (): Promise<RunnerResult> => ({ output: "done", threadId: "thread", usage: null }),
    cancel: async () => false,
    isAvailable: async () => true,
  };
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "launchpad.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    resolvedRunner,
    undefined,
    undefined,
    undefined,
    timeline,
  );
  await service.initialize();
  return { service, timeline, config };
}

describe("AgentService Run timeline", () => {
  it("persists lifecycle facts from creation through completion in sequence order", async () => {
    const { service, timeline } = await fixture();
    const agent = await service.createAgent({ name: "Release Agent" });
    const { run } = await service.sendMessage(agent.id, "prepare staging");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const events = await timeline.list(run.id);
    expect(events.map(({ type }) => type)).toEqual([
      "RUN_CREATED",
      "RUN_STARTED",
      "AGENT_STARTED",
      "RUN_COMPLETED",
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(events.every(({ agentId }) => agentId === agent.id)).toBe(true);
  });

  it("does not start the runner when the required creation event cannot persist", async () => {
    const run = vi.fn(async (): Promise<RunnerResult> => ({ output: "must not run", threadId: null, usage: null }));
    const timeline: RunTimeline = {
      append: async () => { throw new Error("database unavailable"); },
      list: async () => [],
    };
    const { service } = await fixture({
      run,
      cancel: async () => false,
      isAvailable: async () => true,
    }, timeline);
    const agent = await service.createAgent({ name: "Fail closed" });

    await expect(service.sendMessage(agent.id, "do something")).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(run).not.toHaveBeenCalled();
    expect(service.getRuns(agent.id)).toEqual([]);
    expect(service.getMessages(agent.id)).toEqual([]);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("preserves the originating human across every Agent lifecycle fact", async () => {
    const { service, timeline } = await fixture();
    const agent = await service.createAgent({ name: "Attribution Agent" });
    const origin: AuthenticatedPrincipal = {
      id: "human:alice",
      kind: "human",
      displayName: "Alice",
      role: "operator",
      authenticationSource: "bearer_token",
    };
    const { run } = await service.sendMessage(agent.id, "prepare staging", origin);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const events = await timeline.list(run.id);
    expect(events[0]?.actor).toMatchObject({
      principalId: origin.id,
      kind: "human",
      displayName: origin.displayName,
      originPrincipalId: origin.id,
      originDisplayName: origin.displayName,
      agentId: agent.id,
    });
    expect(events.slice(1).every((event) =>
      event.actor.principalId === `agent:${agent.id}` &&
      event.actor.agentId === agent.id &&
      event.actor.originPrincipalId === origin.id)).toBe(true);
  });

  it("records runner failure as a distinct terminal fact", async () => {
    const { service, timeline } = await fixture({
      run: async () => { throw new Error("controlled runner failure"); },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Failure Agent" });
    const { run } = await service.sendMessage(agent.id, "fail safely");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const events = await timeline.list(run.id);
    expect(events.at(-1)).toMatchObject({
      type: "RUN_FAILED",
      outcome: "failed",
      reasonCode: "RUNNER_FAILED",
    });
  });

  it("retains a deleted Agent's Run anchor and ordered audit timeline", async () => {
    const { service, timeline, config } = await fixture();
    const agent = await service.createAgent({ name: "Audited Agent" });
    const { run } = await service.sendMessage(agent.id, "record this work");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const beforeDeletion = await timeline.list(run.id);

    await service.deleteAgent(agent.id);

    expect(() => service.getAgent(agent.id)).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(service.getRun(run.id)).toMatchObject({
      id: run.id,
      agentId: agent.id,
      status: "completed",
      completedAt: expect.any(String),
    });
    expect(await timeline.list(run.id)).toEqual(beforeDeletion);

    const app = await createApp(
      config,
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      timeline,
    );
    const runResponse = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    const eventsResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${run.id}/events`,
    });
    expect(runResponse.statusCode).toBe(200);
    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.json<{ events: Array<{ sequence: number }> }>().events)
      .toHaveLength(beforeDeletion.length);
    await app.close();
  });

  it("repairs one terminal audit interruption without relabelling a completed effect", async () => {
    let backing!: SqliteRunTimelineStore;
    let failTerminalOnce = true;
    const { service, timeline } = await fixture(undefined, (database) => {
      backing = new SqliteRunTimelineStore(database);
      return {
        append: (input) => backing.append(input),
        appendRequired: async (input) => {
          if (input.type === "RUN_COMPLETED" && failTerminalOnce) {
            failTerminalOnce = false;
            throw new Error("terminal audit interrupted");
          }
          return backing.appendRequired(input);
        },
        get: (runId, eventId) => backing.get(runId, eventId),
        list: (runId) => backing.list(runId),
      };
    });
    const agent = await service.createAgent({ name: "Effect Agent" });
    const principal: AuthenticatedPrincipal = {
      id: "human:alice",
      kind: "human",
      displayName: "Alice",
      role: "admin",
      authenticationSource: "system",
    };
    const run = await service.createManagedActionRun(agent.id, "change staging", principal);

    await expect(service.finishManagedActionRun(run.id, "completed", "The real change completed"))
      .rejects.toThrow(/terminal audit interrupted/i);
    const completedAt = service.getRun(run.id).completedAt;
    expect(service.getRun(run.id)).toMatchObject({
      status: "completed",
      output: "The real change completed",
      error: null,
    });
    expect((await timeline.list(run.id)).some((event) => event.type === "RUN_FAILED")).toBe(false);

    // Startup reconciliation consumes the durable completedAt/output anchor
    // and repairs the missing immutable terminal fact.
    await service.initialize();
    await expect(service.finishManagedActionRun(run.id, "completed", "The real change completed"))
      .resolves.toMatchObject({ status: "completed", completedAt });
    const terminal = (await timeline.list(run.id)).filter((event) =>
      event.type === "RUN_COMPLETED" || event.type === "RUN_FAILED");
    expect(terminal).toEqual([
      expect.objectContaining({
        type: "RUN_COMPLETED",
        occurredAt: completedAt,
        reason: "The real change completed",
      }),
    ]);
    await expect(service.finishManagedActionRun(run.id, "failed", "False failure"))
      .rejects.toThrow(/cannot be relabelled/i);
  });
});
