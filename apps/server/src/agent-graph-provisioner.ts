import type { Agent } from "./types.js";
import { createDemoGraphSeed, createUnconfiguredAgentNode, demoAgents } from "./demo-graph.js";
import type { GraphStore } from "./graph-types.js";

export type GraphSyncedAgent = Pick<Agent, "id" | "name">;

/** The boundary AgentService uses; it remains independent of persistence. */
export interface AgentGraphProvisioner {
  provisionAgent(agent: GraphSyncedAgent): Promise<void>;
}

export interface ProvisionedAgentOwner {
  id: string;
  label: string;
}

/**
 * Provisions an Agent graph identity. Only named demo Agents receive their
 * purpose-built sample topology. A server-attested owner may be attached to a
 * new Agent for accountability, but ownership never creates a resource
 * capability. Without that optional identity, legacy callers still create an
 * unowned Agent node with no implied permissions or impact relationships.
 * Upserts make startup reconciliation and retries safe.
 */
export class DemoAgentGraphProvisioner implements AgentGraphProvisioner {
  constructor(
    private readonly store: GraphStore,
    private readonly owner?: ProvisionedAgentOwner,
  ) {}

  async provisionAgent(agent: GraphSyncedAgent): Promise<void> {
    const isDemoAgent =
      agent.id === demoAgents.releaseGuardian.id || agent.id === demoAgents.dataSteward.id;

    if (!isDemoAgent) {
      const agentNode = createUnconfiguredAgentNode(agent.id, agent.name);
      const existingAgentNode = await this.store.getNode(agentNode.id);
      await this.store.upsertNode(agentNode);
      // Reconciliation may update the Agent label, but it must never attach a
      // newly configured server principal to an existing Agent. Ownership is
      // written exactly when this graph identity is first materialized.
      if (this.owner && !existingAgentNode) {
        const existingOwner = await this.store.getNode(this.owner.id);
        if (!existingOwner) {
          await this.store.upsertNode({
            id: this.owner.id,
            type: "human",
            label: this.owner.label,
            riskLevel: "low",
            riskWeight: 0,
            classification: "internal",
            metadata: {},
            createdAt: agentNode.createdAt,
            updatedAt: agentNode.updatedAt,
          });
        }
        await this.store.upsertEdge({
          id: `owner:${this.owner.id}:${agentNode.id}`,
          sourceId: this.owner.id,
          targetId: agentNode.id,
          relation: "OWNS",
          status: "authorized",
          metadata: { accountabilityOnly: true },
          createdAt: agentNode.createdAt,
        });
      }
      return;
    }

    const seed = createDemoGraphSeed(agent.id, agent.name);
    for (const node of seed.nodes) {
      await this.store.upsertNode(node);
    }
    for (const edge of seed.edges) {
      await this.store.upsertEdge(edge);
    }
  }
}
