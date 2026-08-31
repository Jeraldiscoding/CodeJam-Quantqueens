import { HttpError } from "./errors.js";
import type { RunTimeline } from "./run-timeline.js";
import type { SecurityStore } from "./security-store.js";
import type { AuthenticatedPrincipal, ExecutionIdentity } from "./security-types.js";
import type { Agent, AgentRun } from "./types.js";

export interface IdentityRunDirectory {
  getRun(runId: string): AgentRun;
  getAgent(agentId: string): Agent;
}

/** Resolves server-attested origin and optional delegation into one action identity. */
export class ExecutionIdentityService {
  constructor(
    private readonly runs: IdentityRunDirectory,
    private readonly security: SecurityStore,
    private readonly timeline?: RunTimeline,
  ) {}

  async register(principal: AuthenticatedPrincipal): Promise<void> {
    await this.security.upsertPrincipal(principal);
  }

  async resolve(input: {
    runId: string;
    principal: AuthenticatedPrincipal;
    delegationId?: string;
  }): Promise<ExecutionIdentity> {
    const persisted = await this.security.getPrincipal(input.principal.id);
    if (!persisted || persisted.role !== input.principal.role || persisted.kind !== input.principal.kind) {
      throw new HttpError(403, "The authenticated identity is missing, inactive, or inconsistent");
    }
    const run = this.runs.getRun(input.runId);
    const rootAgent = this.runs.getAgent(run.agentId);
    // Every action that enters the integrated protected gateway needs a
    // server-attested origin. Legacy Runs remain viewable, but cannot acquire
    // protected effects by inheriting whichever principal happens to call now.
    if (!run.originPrincipalId) {
      throw new HttpError(503, "Protected Run origin identity is unavailable");
    }
    if (run.originPrincipalId && run.originPrincipalId !== input.principal.id) {
      throw new HttpError(403, "This Run belongs to a different authenticated person");
    }
    await this.assertRunOrigin(input.runId, input.principal.id);
    if (!input.delegationId) {
      return {
        principal: input.principal,
        runId: run.id,
        rootAgentId: run.agentId,
        actorAgentId: run.agentId,
        actorAgentNodeId: `agent:${run.agentId}`,
        actorAgentDisplayName: rootAgent.name,
        delegationChain: [],
      };
    }

    const leaf = await this.security.getDelegation(input.delegationId);
    if (!leaf) throw new HttpError(403, "Delegation was not found");
    const chain = await this.resolveChain(leaf.id);
    const timestamp = new Date().toISOString();
    for (const delegation of chain) {
      if (delegation.status !== "active" || delegation.expiresAt <= timestamp) {
        throw new HttpError(403, "Delegation is revoked or expired");
      }
      if (delegation.runId !== run.id || delegation.originPrincipalId !== input.principal.id) {
        throw new HttpError(403, "Delegation does not belong to this identity and Run");
      }
    }
    if (chain[0]!.parentAgentId !== run.agentId) {
      throw new HttpError(403, "Delegation does not originate from this Run's Agent");
    }
    const actorAgent = this.runs.getAgent(leaf.childAgentId);
    return {
      principal: input.principal,
      runId: run.id,
      rootAgentId: run.agentId,
      actorAgentId: leaf.childAgentId,
      actorAgentNodeId: `agent:${leaf.childAgentId}`,
      actorAgentDisplayName: actorAgent.name,
      delegation: leaf,
      delegationChain: chain,
    };
  }

  private async resolveChain(leafId: string) {
    const chain = [];
    let current = await this.security.getDelegation(leafId);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) throw new HttpError(403, "Delegation chain contains a cycle");
      visited.add(current.id);
      chain.unshift(current);
      if (!current.parentDelegationId) break;
      const parent = await this.security.getDelegation(current.parentDelegationId);
      if (!parent || parent.childAgentId !== current.parentAgentId || parent.depth + 1 !== current.depth) {
        throw new HttpError(403, "Delegation parent linkage is invalid");
      }
      current = parent;
    }
    if (chain.length !== chain.at(-1)!.depth) throw new HttpError(403, "Delegation depth is inconsistent");
    return chain;
  }

  private async assertRunOrigin(runId: string, principalId: string): Promise<void> {
    if (!this.timeline) return;
    const created = (await this.timeline.list(runId)).find((event) => event.type === "RUN_CREATED");
    if (!created) throw new HttpError(503, "Run origin evidence is unavailable");
    const recordedOrigin = created.actor.originPrincipalId ??
      (created.actor.kind === "human" ? created.actor.principalId : undefined);
    if (!recordedOrigin) {
      throw new HttpError(503, "Run origin event identity is unavailable");
    }
    if (recordedOrigin !== principalId) {
      throw new HttpError(403, "This Run belongs to a different authenticated person");
    }
  }
}
