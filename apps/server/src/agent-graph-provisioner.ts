import type { Agent } from "./types.js";
import { createDemoGraphSeed, createUnconfiguredAgentNode, demoAgents } from "./demo-graph.js";
import type { GraphStore } from "./graph-types.js";

export type GraphSyncedAgent = Pick<Agent, "id" | "name">;

/** The boundary AgentService uses; it remains independent of persistence. */
export interface AgentGraphProvisioner {
  provisionAgent(agent: GraphSyncedAgent): Promise<void>;
}

/**
 * Provisions an Agent graph identity. Only named demo Agents receive their
 * purpose-built sample topology; every newly created Agent starts with a
 * single Agent node and no implied permissions or impact relationships.
 * Upserts make startup reconciliation and retries safe.
 */
export class DemoAgentGraphProvisioner implements AgentGraphProvisioner {
  constructor(private readonly store: GraphStore) {}

  async provisionAgent(agent: GraphSyncedAgent): Promise<void> {
    const isDemoAgent =
      agent.id === demoAgents.releaseGuardian.id || agent.id === demoAgents.dataSteward.id;

    if (!isDemoAgent) {
      await this.store.upsertNode(createUnconfiguredAgentNode(agent.id, agent.name));
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
