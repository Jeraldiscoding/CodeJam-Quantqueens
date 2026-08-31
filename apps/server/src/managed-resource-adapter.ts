import { digestOf } from "./policy-hash.js";
import type {
  GrantedAction,
  ResourceActionResult,
  ResourceAdapter,
} from "./resource-gateway.js";
import type { SecurityStore } from "./security-store.js";

/**
 * A real durable effect owned by middleware.db. Managed resources cannot be
 * changed through a runner mount or another HTTP handler; only the gateway
 * receives this adapter. The SQLite store still re-verifies the gateway's
 * one-time claim: keeping that check in the same transaction as the effect
 * prevents a direct adapter call or a claim/effect race from becoming a write.
 *
 * Reads use the same defense-in-depth check even though they do not mutate
 * state. A managed value digest is still protected information, and reusing a
 * stale or unrelated claim must not turn this adapter into a read bypass.
 */
export class SqliteManagedResourceAdapter implements ResourceAdapter {
  private calls = 0;

  constructor(private readonly security: SecurityStore) {}

  get invocationCount(): number {
    return this.calls;
  }

  async execute(action: GrantedAction): Promise<ResourceActionResult> {
    if (action.target.metadata.adapterKind !== "managed_state") {
      throw new Error(`Resource ${action.target.id} is not owned by the managed-state adapter`);
    }
    this.calls += 1;
    const claim = {
      decisionId: action.decision.id,
      operationId: action.operationId,
      runId: action.runId,
      agentId: action.agentId,
      agentNodeId: action.agentNodeId,
      capability: action.capability,
      resourceId: action.target.id,
      payloadDigest: digestOf(action.payload),
      executedAt: new Date().toISOString(),
    };
    if (action.capability === "CAN_READ") {
      const state = await this.security.readManagedResourceForClaim(claim);
      return {
        kind: "read",
        summary: state
          ? `Read managed revision ${state.revision} for ${action.target.label}`
          : `No managed value has been written for ${action.target.label}`,
        detail: state
          ? { targetId: state.resourceId, revision: state.revision, valueDigest: state.valueDigest }
          : { targetId: action.target.id, revision: 0 },
      };
    }
    if (action.capability !== "CAN_WRITE") {
      throw new Error("Managed-state resources support only read and write actions");
    }
    const state = await this.security.applyManagedWrite(claim);
    return {
      kind: "write",
      summary: `Updated ${action.target.label} to managed revision ${state.revision}`,
      detail: {
        targetId: state.resourceId,
        revision: state.revision,
        valueDigest: state.valueDigest,
      },
    };
  }
}
