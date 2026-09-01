import type { AgentRuntimeMediator, AgentRuntimePlan } from "./agent-runtime-mediator.js";
import { HttpError } from "./errors.js";
import type { GraphConfigurationService } from "./graph-configuration.js";
import type { GraphNode } from "./graph-types.js";
import { analyzePromptIntent } from "./prompt-intelligence.js";
import {
  PostEffectFinalizationError,
  type GatewayResponse,
  type ResourceGateway,
} from "./resource-gateway.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import type { AgentRun } from "./types.js";

type ManagedModelCapability = "CAN_READ" | "CAN_WRITE";

interface ModelActionProposal {
  capability: ManagedModelCapability;
  targetNodeId: string;
  reason: string;
}

const proposalPattern = /<protected_action>\s*([\s\S]*?)\s*<\/protected_action>/g;
const capabilities = new Set<ManagedModelCapability>(["CAN_READ", "CAN_WRITE"]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("'s", "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bconfigs?\b/g, "configuration")
    .replace(/\s+/g, " ")
    .trim();
}

function managedResources(nodes: readonly GraphNode[]): GraphNode[] {
  return nodes
    .filter((node) => node.type === "asset" && node.metadata.adapterKind === "managed_state")
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function promptNamesResource(prompt: string, resources: readonly GraphNode[]): boolean {
  const normalizedPrompt = normalize(prompt);
  return resources.some((resource) => {
    const label = normalize(resource.label);
    const stableName = normalize(resource.id.replace(/^asset:/, ""));
    return normalizedPrompt.includes(label) || normalizedPrompt.includes(stableName);
  });
}

function parseProposal(output: string): ModelActionProposal | null {
  const matches = [...output.matchAll(proposalPattern)];
  if (matches.length === 0) {
    if (/<\/?protected_action\b/i.test(output)) {
      throw new HttpError(422, "Codex returned a malformed protected-action proposal; nothing was executed");
    }
    return null;
  }
  if (matches.length !== 1) {
    throw new HttpError(422, "Codex proposed more than one protected action; nothing was executed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0]![1]!);
  } catch {
    throw new HttpError(422, "Codex returned invalid protected-action JSON; nothing was executed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(422, "Codex returned an invalid protected-action proposal; nothing was executed");
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["capability", "reason", "targetNodeId"].includes(key))) {
    throw new HttpError(422, "Codex added unsupported protected-action fields; nothing was executed");
  }
  if (
    typeof value.capability !== "string" ||
    !capabilities.has(value.capability as ManagedModelCapability) ||
    typeof value.targetNodeId !== "string" ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 1 ||
    value.reason.length > 240
  ) {
    throw new HttpError(422, "Codex returned an unsupported protected-action proposal; nothing was executed");
  }
  return {
    capability: value.capability as ManagedModelCapability,
    targetNodeId: value.targetNodeId,
    reason: value.reason.trim(),
  };
}

function visibleModelOutput(output: string): string {
  return output
    .replace(proposalPattern, "")
    .replace(/```(?:json)?\s*```/gi, "")
    .trim();
}

function outcomeExplanation(outcome: GatewayResponse): string {
  if (outcome.status === "executed") {
    return `Middleware result: ${outcome.result.summary}. The protected effect ran only after identity, exact permission, graph impact, history, and the safety stop were checked.`;
  }
  if (outcome.status === "approval_required") {
    return `Middleware result: paused for human review. ${outcome.risk?.explanation ?? "The action was unusual enough to require approval."} Nothing has changed yet.`;
  }
  if (outcome.authorization?.result === "DENY") {
    return `Middleware result: blocked because the authenticated person or Agent does not have the required authority (${outcome.authorization.reasonCode}). Nothing changed.`;
  }
  return `Middleware result: blocked by the safety policy. ${outcome.risk?.explanation ?? outcome.decision.reasonCode} Nothing changed.`;
}

/**
 * Lets the real Codex Agent choose a bounded managed action, while keeping the
 * planning turn read-only and treating all model output as untrusted input.
 * The model never grants permission and never receives the managed adapter.
 */
export class ModelActionMediator implements AgentRuntimeMediator {
  constructor(
    private readonly graphConfiguration: GraphConfigurationService,
    private readonly gateway: ResourceGateway,
    private readonly principal: AuthenticatedPrincipal,
  ) {}

  async prepare(input: { agent: { name: string }; run: { prompt: string } }): Promise<AgentRuntimePlan | null> {
    const catalog = await this.graphConfiguration.getCatalog();
    const resources = managedResources(catalog.nodes);
    if (!promptNamesResource(input.run.prompt, resources)) return null;

    const inventory = resources.map((resource) =>
      `- ${resource.label} (targetNodeId: ${resource.id}; supported capabilities: CAN_READ, CAN_WRITE)`,
    );
    return {
      mode: "protected_action_planner",
      sandboxMode: "read-only",
      managedResourceIds: resources.map((resource) => resource.id),
      prompt: [
        "Runtime mode: read-only protected-action planning.",
        "You are the real Codex Agent. Understand the user's request and respond naturally.",
        "Do not edit files, call external systems, or claim that a protected action succeeded.",
        "The protected resources below are not mounted in your runtime. If, and only if, the user asks to read or change exactly one of them, end your response with exactly one proposal using this format:",
        '<protected_action>{"capability":"CAN_READ|CAN_WRITE","targetNodeId":"asset:...","reason":"short explanation of the intended effect"}</protected_action>',
        "Choose only a listed target and supported capability. The server will validate the proposal and the middleware—not you—will decide whether it can run.",
        "If the user is asking a question, greeting you, or requesting explanation only, do not include a proposal.",
        "",
        "Protected resource catalog:",
        ...inventory,
        "",
        "User request:",
        input.run.prompt,
      ].join("\n"),
    };
  }

  async mediate(input: {
    run: { id: string; prompt: string };
    plan: AgentRuntimePlan;
    modelOutput: string;
  }): Promise<{
    output: string;
    approval?: {
      policy: NonNullable<AgentRun["policy"]>;
      pendingAction: NonNullable<AgentRun["pendingAction"]>;
    };
  }> {
    const proposal = parseProposal(input.modelOutput);
    if (!proposal) return { output: input.modelOutput.trim() };
    if (analyzePromptIntent(input.run.prompt).intent === "informational") {
      throw new HttpError(422, "Codex proposed an effect for an informational request; nothing was executed");
    }
    if (!input.plan.managedResourceIds.includes(proposal.targetNodeId)) {
      throw new HttpError(422, "Codex proposed a resource outside the protected catalog; nothing was executed");
    }

    // Re-read the catalog after planning so a removed or reclassified adapter
    // cannot be reached with a stale model proposal.
    const current = managedResources((await this.graphConfiguration.getCatalog()).nodes);
    if (!current.some((resource) => resource.id === proposal.targetNodeId)) {
      throw new HttpError(409, "The proposed protected resource changed during planning; nothing was executed");
    }

    const payload = {
      content: input.run.prompt,
      source: "codex-protected-action-proposal",
      proposal: {
        capability: proposal.capability,
        targetNodeId: proposal.targetNodeId,
        reason: proposal.reason,
      },
    };
    const outcome = await this.gateway.request({
      runId: input.run.id,
      operationId: `model-proposed:${input.run.id}`,
      capability: proposal.capability,
      targetNodeId: proposal.targetNodeId,
      principal: this.principal,
      payload,
    });
    const visible = visibleModelOutput(input.modelOutput) ||
      `Codex proposed ${proposal.capability.replace("CAN_", "").toLowerCase()} access to ${proposal.targetNodeId}.`;
    if (outcome.status === "approval_required") {
      return {
        output: visible,
        approval: {
          policy: {
            result: "REVIEW_REQUIRED",
            reasonCode: outcome.decision.reasonCode,
            intent: "action",
            intentExplanation: outcome.risk?.explanation ?? "The protected action requires review.",
            riskScore: outcome.decision.riskScore,
            reviewThreshold: outcome.risk?.warnThreshold ?? outcome.decision.riskThreshold,
            denyThreshold: outcome.risk?.blockThreshold ?? outcome.decision.riskThreshold,
            decisionId: outcome.decision.id,
            approvalRequestId: outcome.approvalRequest.id,
            evaluatedAt: outcome.decision.createdAt,
            riskFactors: [],
          },
          pendingAction: {
            decisionId: outcome.decision.id,
            approvalRequestId: outcome.approvalRequest.id,
            capability: proposal.capability,
            targetNodeId: proposal.targetNodeId,
            proposalReason: proposal.reason,
            modelOutput: visible,
          },
        },
      };
    }
    return { output: `${visible}\n\n${outcomeExplanation(outcome)}` };
  }

  async resume(input: { run: AgentRun }): Promise<{ output: string }> {
    const pending = input.run.pendingAction;
    if (!pending) throw new HttpError(409, "This Run has no pending model-proposed action");
    const payload = {
      content: input.run.prompt,
      source: "codex-protected-action-proposal",
      proposal: {
        capability: pending.capability,
        targetNodeId: pending.targetNodeId,
        reason: pending.proposalReason,
      },
    };
    let outcome: GatewayResponse;
    try {
      outcome = await this.gateway.resume({
        runId: input.run.id,
        decisionId: pending.decisionId,
        principal: this.principal,
        payload,
      });
    } catch (error) {
      if (error instanceof PostEffectFinalizationError) {
        return {
          output: `${pending.modelOutput}\n\nMiddleware result: ${error.result.summary}. The effect completed, but audit finalization needs attention.`,
        };
      }
      throw error;
    }
    if (outcome.status !== "executed") {
      throw new HttpError(403, "The approved protected action could not be executed");
    }
    return { output: `${pending.modelOutput}\n\n${outcomeExplanation(outcome)}` };
  }
}

export const modelActionProposal = { parse: parseProposal };
