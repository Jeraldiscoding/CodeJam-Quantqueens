import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MiddlewareDatabase } from "./middleware-database.js";
import {
  appendRequiredRunEvent,
  projectRunEvent,
  requireRunEvent,
  requireRunEventEvidence,
  type AppendRunEvent,
  type RequiredRunEvent,
} from "./run-timeline.js";
import { SqliteRunTimelineStore } from "./sqlite-run-timeline-store.js";

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

async function openDatabase(filePath?: string) {
  let resolvedPath = filePath;
  if (!resolvedPath) {
    const root = await mkdtemp(path.join(tmpdir(), "run-timeline-test-"));
    temporaryDirectories.push(root);
    resolvedPath = path.join(root, "middleware.db");
  }
  const database = new MiddlewareDatabase(resolvedPath);
  await database.initialize();
  databases.push(database);
  return { database, filePath: resolvedPath };
}

function event(
  runId: string,
  id: string,
  occurredAt = "2026-08-31T12:00:00.000Z",
): AppendRunEvent {
  return {
    id,
    runId,
    type: "ACTION_REQUESTED",
    occurredAt,
    actor: {
      principalId: "agent:release",
      kind: "agent",
      agentId: "release",
      displayName: "Release Agent",
    },
    agentId: "release",
    action: { operation: "write", capability: "CAN_WRITE" },
    resource: { resourceId: "asset:staging", label: "staging config", kind: "file" },
    outcome: "pending",
    reasonCode: "ACTION_RECEIVED",
    reason: "The resource action entered the protected execution path.",
    metadata: {},
  };
}

describe("SqliteRunTimelineStore", () => {
  it("allocates a unique, strict Run-local order across concurrent writers", async () => {
    const first = await openDatabase();
    const second = await openDatabase(first.filePath);
    const firstStore = new SqliteRunTimelineStore(first.database);
    const secondStore = new SqliteRunTimelineStore(second.database);
    const runId = "run:concurrent";

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? firstStore : secondStore).append(
          event(
            runId,
            `event:${index}`,
            index % 3 === 0
              ? "2026-08-31T12:00:01.000Z"
              : "2026-08-31T11:59:59.000Z",
          ),
        ),
      ),
    );

    const stored = await firstStore.list(runId);
    expect(stored).toHaveLength(40);
    expect(stored.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(new Set(stored.map(({ sequence }) => sequence)).size).toBe(40);
    expect(stored.some((item, index) => index > 0 && item.occurredAt < stored[index - 1]!.occurredAt))
      .toBe(true);
  });

  it("survives all service and database instances being closed", async () => {
    const initial = await openDatabase();
    const timeline = new SqliteRunTimelineStore(initial.database);
    await timeline.append(event("run:restart", "event:before-restart"));
    initial.database.close();
    databases.splice(databases.indexOf(initial.database), 1);

    const restarted = await openDatabase(initial.filePath);
    const events = await new SqliteRunTimelineStore(restarted.database).list("run:restart");

    expect(events).toEqual([
      expect.objectContaining({ id: "event:before-restart", runId: "run:restart", sequence: 1 }),
    ]);
  });

  it("redacts secret-shaped metadata fields and bounds nested content", async () => {
    const { database } = await openDatabase();
    const timeline = new SqliteRunTimelineStore(database);
    const input = event("run:redaction", "event:redacted");
    input.metadata = {
      authorization: "Bearer should-never-persist",
      nested: {
        apiKey: "also-secret",
        note: "x".repeat(900),
      },
      longList: Array.from({ length: 100 }, (_, index) => index),
    };

    const stored = await timeline.append(input);
    const serialized = JSON.stringify(stored.metadata);
    expect(serialized).not.toContain("should-never-persist");
    expect(serialized).not.toContain("also-secret");
    expect(stored.metadata).toMatchObject({
      authorizationRedacted: "[REDACTED]",
      nested: { apiKeyRedacted: "[REDACTED]", note: "x".repeat(500) },
    });
    expect((stored.metadata.longList as unknown[])).toHaveLength(30);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8_192);
  });

  it("redacts secret-shaped values in structured display fields before persistence", async () => {
    const { database } = await openDatabase();
    const timeline = new SqliteRunTimelineStore(database);
    const input = event("run:structured-redaction", "event:structured-redaction");
    input.actor.displayName = "token=actor-secret";
    input.action!.toolName = "password=tool-secret";
    input.resource!.label = "authorization=resource-secret";
    input.reason = "Bearer reason-secret";

    const stored = await timeline.append(input);
    expect(stored.actor.displayName).toBe("token=[REDACTED]");
    expect(stored.action?.toolName).toBe("password=[REDACTED]");
    expect(stored.resource?.label).toBe("authorization=[REDACTED]");
    expect(stored.reason).toBe("Bearer [REDACTED]");

    const row = database.connection
      .prepare(`
        SELECT actor_json, action_json, resource_json, reason
        FROM run_events WHERE id = ?
      `)
      .get(input.id) as {
        actor_json: string;
        action_json: string;
        resource_json: string;
        reason: string;
      };
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain("actor-secret");
    expect(persisted).not.toContain("tool-secret");
    expect(persisted).not.toContain("resource-secret");
    expect(persisted).not.toContain("reason-secret");
  });

  it("rejects secret-shaped values in stable structured references", async () => {
    const { database } = await openDatabase();
    const timeline = new SqliteRunTimelineStore(database);
    const probes: Array<(input: AppendRunEvent) => void> = [
      (input) => { input.actor.principalId = "token=principal-secret"; },
      (input) => { input.actor.originPrincipalId = "password=origin-secret"; },
      (input) => { input.actor.agentId = "authorization=agent-secret"; },
      (input) => { input.actor.parentAgentId = "api_key=parent-secret"; },
      (input) => { input.agentId = "token=top-agent-secret"; },
      (input) => { input.action!.operation = "password=operation-secret"; },
      (input) => { input.action!.capability = "token=capability-secret"; },
      (input) => { input.resource!.resourceId = "secret=resource-id-secret"; },
      (input) => { input.resource!.kind = "authorization=resource-kind-secret"; },
      (input) => {
        input.decision = {
          decisionId: "token=decision-id-secret",
          layer: "risk",
          result: "BLOCK",
          reasonCode: "SAFE_REASON",
        };
      },
      (input) => {
        input.decision = {
          layer: "risk",
          result: "password=decision-result-secret",
          reasonCode: "SAFE_REASON",
        };
      },
      (input) => {
        input.decision = {
          layer: "risk",
          result: "BLOCK",
          reasonCode: "token=decision-reason-secret",
        };
      },
      (input) => {
        input.delegation = {
          delegationId: "token=delegation-secret",
          parentAgentId: "parent",
          childAgentId: "child",
          depth: 1,
          effectiveCapabilities: ["CAN_READ"],
        };
      },
      (input) => {
        input.delegation = {
          delegationId: "delegation:safe",
          parentAgentId: "password=delegation-parent-secret",
          childAgentId: "child",
          depth: 1,
          effectiveCapabilities: ["CAN_READ"],
        };
      },
      (input) => {
        input.delegation = {
          delegationId: "delegation:safe",
          parentAgentId: "parent",
          childAgentId: "authorization=delegation-child-secret",
          depth: 1,
          effectiveCapabilities: ["CAN_READ"],
        };
      },
      (input) => {
        input.delegation = {
          delegationId: "delegation:safe",
          parentAgentId: "parent",
          childAgentId: "child",
          depth: 1,
          effectiveCapabilities: ["token=delegated-capability-secret"],
        };
      },
      (input) => { input.correlationId = "token=correlation-secret"; },
      (input) => { input.causationId = "password=causation-secret"; },
    ];

    for (const [index, mutate] of probes.entries()) {
      const input = event("run:stable-rejection", `event:stable-rejection:${index}`);
      mutate(input);
      await expect(timeline.append(input)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(await timeline.list("run:stable-rejection")).toEqual([]);
  });

  it("rolls back sequence allocation when an event ID conflicts", async () => {
    const { database } = await openDatabase();
    const timeline = new SqliteRunTimelineStore(database);
    await timeline.append(event("run:rollback", "event:duplicate"));
    await expect(timeline.append(event("run:rollback", "event:duplicate"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const next = await timeline.append(event("run:rollback", "event:next"));
    expect(next.sequence).toBe(2);
  });

  it("repairs a deterministic required fact idempotently without allocating another sequence", async () => {
    const first = await openDatabase();
    const second = await openDatabase(first.filePath);
    const firstStore = new SqliteRunTimelineStore(first.database);
    const secondStore = new SqliteRunTimelineStore(second.database);
    const required = event("run:required", "event:required") as RequiredRunEvent;

    const [created, repaired] = await Promise.all([
      appendRequiredRunEvent(firstStore, required),
      appendRequiredRunEvent(secondStore, required),
    ]);

    expect(created.sequence).toBe(1);
    expect(repaired).toEqual(created);
    expect(await requireRunEvent(secondStore, required)).toEqual(created);
    expect(await requireRunEventEvidence(secondStore, {
      runId: required.runId,
      eventId: required.id,
      type: required.type,
      outcome: required.outcome,
    })).toEqual(created);
    expect(await firstStore.list(required.runId)).toHaveLength(1);

    await expect(appendRequiredRunEvent(firstStore, {
      ...required,
      reason: "Conflicting evidence must never replace the first fact.",
    })).rejects.toThrow(/different audit evidence/i);
    await expect(requireRunEventEvidence(firstStore, {
      runId: required.runId,
      eventId: required.id,
      type: "ACTION_ALLOWED",
    })).rejects.toThrow(/does not match its decision evidence/i);
    await expect(requireRunEventEvidence(firstStore, {
      runId: required.runId,
      eventId: "event:missing-required",
      type: "ACTION_ALLOWED",
    })).rejects.toThrow(/execution remains blocked/i);
    expect((await firstStore.append(event(required.runId, "event:after-required"))).sequence).toBe(2);
  });

  it("bounds deeply nested arrays before serialization", async () => {
    const { database } = await openDatabase();
    const timeline = new SqliteRunTimelineStore(database);
    const input = event("run:nested-array", "event:nested-array");
    let nested: unknown = "deep value";
    for (let index = 0; index < 100; index += 1) nested = [nested];
    input.metadata = { nested };

    const stored = await timeline.append(input);
    expect(JSON.stringify(stored.metadata)).toContain("maximum depth reached");
    expect(JSON.stringify(stored.metadata)).not.toContain("deep value");
  });
});

describe("Run timeline projection", () => {
  it("explains an allowed authorization and blocked effect without raw JSON", () => {
    const base = event("run:plain", "event:allowed") as AppendRunEvent & {
      id: string;
      occurredAt: string;
    };
    const allowed = projectRunEvent({
      ...base,
      schemaVersion: 1,
      sequence: 1,
      type: "AUTHORIZATION_DECIDED",
      outcome: "allowed",
      decision: { layer: "authorization", result: "ALLOW" },
      metadata: {},
    });
    const blockedBase = event("run:plain", "event:blocked") as AppendRunEvent & {
      id: string;
      occurredAt: string;
    };
    const blocked = projectRunEvent({
      ...blockedBase,
      schemaVersion: 1,
      sequence: 2,
      type: "ACTION_BLOCKED",
      outcome: "blocked",
      reason: "This shared configuration is new and affects four other Agents.",
      metadata: {},
    });

    expect(allowed.summary).toContain("Release Agent was allowed to change staging config");
    expect(blocked.summary).toContain("blocked before anything changed");
    expect(blocked.summary).toContain("affects four other Agents");
  });

  it("uses a capability verb instead of exposing an operation UUID", () => {
    const base = event("run:plain-operation", "event:plain-operation") as AppendRunEvent & {
      id: string;
      occurredAt: string;
    };
    base.action = {
      operation: "managed:123e4567-e89b-42d3-a456-426614174000",
      capability: "CAN_WRITE",
    };
    const projected = projectRunEvent({
      ...base,
      schemaVersion: 1,
      sequence: 1,
      type: "ACTION_COMPLETED",
      outcome: "succeeded",
      metadata: {},
    });

    expect(projected.summary).toContain("change staging config");
    expect(projected.summary).toContain("managed change took effect");
    expect(projected.summary).not.toContain("123e4567");
  });
});
