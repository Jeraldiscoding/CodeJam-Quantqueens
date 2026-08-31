import { describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { RunTimeline } from "./run-timeline.js";

const runId = "123e4567-e89b-42d3-a456-426614174000";

describe("Run timeline API", () => {
  it("authorizes through the Run lookup and returns the server-projected sequence order", async () => {
    const service = {
      getRun: (id: string) => {
        if (id !== runId) throw new Error("missing");
        return { id };
      },
    } as unknown as AgentService;
    const timeline: RunTimeline = {
      append: async () => { throw new Error("not used"); },
      list: async () => [
        {
          id: "event:2",
          schemaVersion: 1,
          runId,
          sequence: 2,
          type: "RUN_COMPLETED",
          occurredAt: "2026-08-31T11:59:59.000Z",
          actor: { principalId: "agent:release", kind: "agent", displayName: "Release Agent" },
          agentId: "release",
          outcome: "succeeded",
          reasonCode: "RUN_COMPLETED",
          reason: "Complete.",
          metadata: {},
        },
        {
          id: "event:1",
          schemaVersion: 1,
          runId,
          sequence: 1,
          type: "ACTION_BLOCKED",
          occurredAt: "2026-08-31T12:00:00.000Z",
          actor: { principalId: "agent:release", kind: "agent", displayName: "Release Agent" },
          agentId: "release",
          action: { operation: "write" },
          resource: { resourceId: "asset:shared", label: "shared configuration" },
          outcome: "blocked",
          reasonCode: "UNUSUAL_BLAST_RADIUS",
          reason: "This new target could affect four other Agents.",
          metadata: {},
        },
      ],
    };
    const app = await createApp(
      loadConfig({ NODE_ENV: "test" }),
      service,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      timeline,
    );

    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}/events` });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toEqual([
      expect.objectContaining({
        sequence: 1,
        summary: expect.stringContaining("blocked before anything changed"),
      }),
      expect.objectContaining({ sequence: 2, type: "RUN_COMPLETED" }),
    ]);
    await app.close();
  });
});
