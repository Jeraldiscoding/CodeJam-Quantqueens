import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import type { RunTimeline } from "./run-timeline.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("seeds the graph demo Agent only when demo data is enabled", async () => {
    const service = await makeService(new FakeRunner(), { SEED_DEMO_DATA: "true" });

    expect(service.listAgents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "d7b3a871-81e1-4965-9a88-bef875c3bb19",
          name: "Release Guardian",
        }),
        expect.objectContaining({
          id: "4d5661a8-49e5-4fe7-b430-cb8fd59e0633",
          name: "Data Steward",
        }),
      ]),
    );
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("atomically accepts only one concurrent managed action Run per Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Managed Concurrent" });
    const principal: AuthenticatedPrincipal = {
      id: "human:operator",
      kind: "human",
      displayName: "Operator",
      role: "operator",
      authenticationSource: "local_loopback",
    };

    const attempts = await Promise.allSettled([
      service.createManagedActionRun(agent.id, "first protected action", principal),
      service.createManagedActionRun(agent.id, "second protected action", principal),
    ]);

    const accepted = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getRuns(agent.id)).toHaveLength(1);
    expect(service.getAgent(agent.id).status).toBe("busy");

    if (accepted[0]?.status === "fulfilled") {
      await service.finishManagedActionRun(accepted[0].value.id, "failed", "test cleanup");
    }
  });

  it("does not launder an unfinished managed Run through stop and restart", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Managed Stop Boundary" });
    const principal: AuthenticatedPrincipal = {
      id: "human:operator",
      kind: "human",
      displayName: "Operator",
      role: "operator",
      authenticationSource: "local_loopback",
    };
    const run = await service.createManagedActionRun(
      agent.id,
      "protected action still in flight",
      principal,
    );

    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "must not create a second Run"))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(service.getRuns(agent.id).filter((item) =>
      item.status === "queued" ||
      item.status === "running" ||
      item.status === "awaiting_approval"
    )).toHaveLength(1);

    await service.finishManagedActionRun(run.id, "failed", "stopped before execution");
    expect(service.getAgent(agent.id).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
  });

  it("does not let managed timeline compensation overwrite a concurrent stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-managed-compensation-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    let timelineEntered!: () => void;
    let releaseTimeline!: () => void;
    const entered = new Promise<void>((resolve) => {
      timelineEntered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseTimeline = resolve;
    });
    const failingTimeline: RunTimeline = {
      append: async () => {
        timelineEntered();
        await barrier;
        throw new Error("timeline unavailable");
      },
      list: async () => [],
    };
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      undefined,
      undefined,
      undefined,
      failingTimeline,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Compensated Stop" });
    const principal: AuthenticatedPrincipal = {
      id: "human:operator",
      kind: "human",
      displayName: "Operator",
      role: "operator",
      authenticationSource: "local_loopback",
    };

    const creating = service.createManagedActionRun(
      agent.id,
      "timeline must exist before effect",
      principal,
    );
    await entered;
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    releaseTimeline();

    await expect(creating).rejects.toMatchObject({ statusCode: 503 });
    expect(service.getAgent(agent.id).status).toBe("stopped");
    expect(service.getRuns(agent.id)).toHaveLength(0);
  });

  it("drains message admission before stop reports the Agent stopped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-stop-admission-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    let enteredCreated!: () => void;
    let releaseCreated!: () => void;
    const createdEntered = new Promise<void>((resolve) => {
      enteredCreated = resolve;
    });
    const createdBarrier = new Promise<void>((resolve) => {
      releaseCreated = resolve;
    });
    let sequence = 0;
    let heldCreated = false;
    const timeline: RunTimeline = {
      append: async (input) => {
        if (input.type === "RUN_CREATED" && !heldCreated) {
          heldCreated = true;
          enteredCreated();
          await createdBarrier;
        }
        return {
          ...input,
          id: input.id ?? `event:${sequence + 1}`,
          schemaVersion: 1,
          sequence: ++sequence,
          occurredAt: input.occurredAt ?? new Date().toISOString(),
          metadata: input.metadata ?? {},
        };
      },
      list: async () => [],
    };
    let runnerCalls = 0;
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      {
        run: async () => {
          runnerCalls += 1;
          return { output: "should not run", threadId: "thread", usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      undefined,
      undefined,
      undefined,
      timeline,
    );
    await service.initialize();
    const agent = await service.createAgent({ name: "Stop During Admission" });

    const sending = service.sendMessage(agent.id, "work admitted before stop");
    await createdEntered;
    let stopResolved = false;
    const stopping = service.stopAgent(agent.id).then((result) => {
      stopResolved = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopResolved).toBe(false);

    releaseCreated();
    const [{ run }, stopped] = await Promise.all([sending, stopping]);
    expect(stopped.status).toBe("stopped");
    expect(service.getRun(run.id).status).toBe("cancelled");
    expect(runnerCalls).toBe(0);
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
