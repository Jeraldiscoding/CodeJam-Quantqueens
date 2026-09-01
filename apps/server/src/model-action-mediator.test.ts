import { describe, expect, it, vi } from "vitest";
import type { GraphConfigurationService } from "./graph-configuration.js";
import type { GraphNode } from "./graph-types.js";
import { ModelActionMediator, modelActionProposal } from "./model-action-mediator.js";
import type { ResourceGateway } from "./resource-gateway.js";

const resource: GraphNode = {
  id: "asset:staging-config",
  type: "asset",
  label: "Staging configuration",
  riskLevel: "low",
  riskWeight: 0,
  classification: "internal",
  metadata: { adapterKind: "managed_state", kind: "configuration" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const principal = {
  id: "human:alice",
  kind: "human" as const,
  displayName: "Alice",
  role: "admin" as const,
  authenticationSource: "local_loopback" as const,
};

describe("model action mediation", () => {
  it("uses Codex only as a read-only planner and sends its validated proposal to the gateway", async () => {
    const graphConfiguration = {
      getCatalog: vi.fn(async () => ({ nodes: [resource], edges: [], observations: [] })),
    } as unknown as GraphConfigurationService;
    const request = vi.fn(async () => ({
      status: "executed" as const,
      decision: { reasonCode: "WITHIN_RISK_THRESHOLD" },
      result: {
        kind: "write" as const,
        summary: "Updated Staging configuration to managed revision 1",
        detail: {},
      },
    }));
    const mediator = new ModelActionMediator(
      graphConfiguration,
      { request } as unknown as ResourceGateway,
      principal,
    );
    const run = { id: "run:1", prompt: "Update the staging configuration to release 2.4.1." };
    const plan = await mediator.prepare({ agent: { name: "Release Guardian" }, run });

    expect(plan).toMatchObject({
      mode: "protected_action_planner",
      sandboxMode: "read-only",
      managedResourceIds: [resource.id],
    });
    expect(plan!.prompt).toContain("You are the real Codex Agent");
    expect(plan!.prompt).toContain(resource.id);

    const mediated = await mediator.mediate({
      run,
      plan: plan!,
      modelOutput: [
        "I will ask the middleware to update the staging configuration.",
        '<protected_action>{"capability":"CAN_WRITE","targetNodeId":"asset:staging-config","reason":"Apply release 2.4.1 to staging"}</protected_action>',
      ].join("\n"),
    });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id,
      operationId: `model-proposed:${run.id}`,
      capability: "CAN_WRITE",
      targetNodeId: resource.id,
      principal,
    }));
    expect(mediated.output).not.toContain("<protected_action>");
    expect(mediated.output).toContain("Middleware result: Updated Staging configuration");
  });

  it("leaves ordinary conversation on the normal Agent path", async () => {
    const mediator = new ModelActionMediator(
      { getCatalog: async () => ({ nodes: [resource], edges: [], observations: [] }) } as unknown as GraphConfigurationService,
      {} as ResourceGateway,
      principal,
    );
    await expect(mediator.prepare({
      agent: { name: "Release Guardian" },
      run: { prompt: "hi" },
    })).resolves.toBeNull();
  });

  it("rejects malformed, multiple, or unsupported proposals before the gateway", () => {
    expect(() => modelActionProposal.parse("<protected_action>{bad}</protected_action>"))
      .toThrow(/invalid protected-action JSON/i);
    expect(() => modelActionProposal.parse([
      '<protected_action>{"capability":"CAN_READ","targetNodeId":"asset:a","reason":"one"}</protected_action>',
      '<protected_action>{"capability":"CAN_READ","targetNodeId":"asset:b","reason":"two"}</protected_action>',
    ].join("\n"))).toThrow(/more than one/i);
    expect(() => modelActionProposal.parse(
      '<protected_action>{"capability":"CAN_CALL","targetNodeId":"asset:a","reason":"call"}</protected_action>',
    )).toThrow(/unsupported/i);
  });

  it("never turns an informational resource question into an effect", async () => {
    const request = vi.fn();
    const mediator = new ModelActionMediator(
      { getCatalog: async () => ({ nodes: [resource], edges: [], observations: [] }) } as unknown as GraphConfigurationService,
      { request } as unknown as ResourceGateway,
      principal,
    );
    const run = { id: "run:question", prompt: "What is the staging configuration?" };
    const plan = await mediator.prepare({ agent: { name: "Release Guardian" }, run });
    await expect(mediator.mediate({
      run,
      plan: plan!,
      modelOutput: '<protected_action>{"capability":"CAN_WRITE","targetNodeId":"asset:staging-config","reason":"unsafe model mistake"}</protected_action>',
    })).rejects.toThrow(/informational request/i);
    expect(request).not.toHaveBeenCalled();
  });
});
