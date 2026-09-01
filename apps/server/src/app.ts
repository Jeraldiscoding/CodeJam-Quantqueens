import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { GraphConfigurationService } from "./graph-configuration.js";
import type { KnowledgeGraphService } from "./knowledge-graph.js";
import type { KnowledgeObservationService } from "./knowledge-observation.js";
import { MiddlewareStoreError } from "./middleware-validation.js";
import type { PolicyService } from "./policy-service.js";
import type { ResourceGateway } from "./resource-gateway.js";
import { projectRunEvent, type RunTimeline } from "./run-timeline.js";
import type { ExecutionIdentityService } from "./execution-identity.js";
import type { DelegationService } from "./delegation-service.js";
import type { BehavioralBaselineService } from "./behavioral-security.js";
import type { SecurityStore } from "./security-store.js";
import type { AuthenticatedPrincipal } from "./security-types.js";
import type { ControlledActionRuntime } from "./controlled-action-runtime.js";
import type { SafetyEvidenceService } from "./safety-evidence.js";
import { extractRelationshipCandidates } from "./knowledge-observation.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const promptRequestBody = messageBody;
const graphNodeBody = z.object({
  type: z.enum(["human", "asset", "data_category"]),
  label: z.string().trim().min(1).max(120),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
  riskWeight: z.number().int().min(0).max(100).optional(),
  classification: z.enum(["public", "internal", "confidential", "restricted"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const decisionIdParams = z.object({ id: z.string().min(3).max(180) });
const approvalIdParams = z.object({ id: z.string().min(3).max(180) });
const protectedActionBody = z.object({
  operationId: z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9:_.-]+$/),
  capability: z.enum(["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"]),
  targetNodeId: z.string().min(3).max(180),
  payload: z.record(z.string(), z.unknown()).optional(),
  delegationId: z.string().min(12).max(180).optional(),
});
const managedActionBody = protectedActionBody.omit({ operationId: true });
const resumeActionBody = z.object({
  decisionId: z.string().min(3).max(180),
  payload: z.record(z.string(), z.unknown()).optional(),
  delegationId: z.string().min(12).max(180).optional(),
});
const resourceIdParams = z.object({ id: z.string().min(3).max(180) });
const agentResourceParams = z.object({
  agentId: z.string().uuid(),
  resourceId: z.string().min(3).max(180),
});
const delegationIdParams = z.object({ id: z.string().min(12).max(180) });
const delegationBody = z.object({
  childAgentId: z.string().uuid(),
  parentDelegationId: z.string().min(12).max(180).optional(),
  expiresAt: z.string().datetime(),
  reason: z.string().trim().max(500).optional(),
  scope: z.array(z.object({
    capability: z.enum(["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"]),
    targetNodeId: z.string().min(3).max(180),
  })).min(1).max(30),
});
const breakerResetBody = z.object({ reason: z.string().trim().min(3).max(500) });
const approvalDecisionBody = z.object({
  reason: z.string().trim().max(500).optional(),
  actorHumanNodeId: z.string().min(3).max(180).optional(),
});
const approvalQuery = z.object({
  status: z
    .enum(["pending", "approved", "rejected", "expired", "consumed"])
    .optional(),
});

const graphRelationshipBody = z.object({
  sourceId: z.string().min(3).max(180),
  targetId: z.string().min(3).max(180),
  relation: z.enum(["OWNS", "CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE", "DEPLOYS_TO", "PROCESSES", "CONTAINS"]),
});
const promptAnalysisBody = z.object({
  prompt: z.string().trim().min(1).max(50_000),
});
const confirmPromptSuggestionBody = z.object({
  existingNodeId: z.string().min(3).max(180).optional(),
  label: z.string().trim().min(1).max(120),
  capability: z.enum(["CAN_READ", "CAN_WRITE", "CAN_CALL", "CAN_USE"]),
  classification: z.enum(["public", "internal", "confidential", "restricted"]),
});
const observationIdParams = z.object({
  id: z.string().uuid(),
  observationId: z.string().min(12).max(180),
});

/**
 * Fastify exposes the original request URL as `request.url`, while routing may
 * decode percent-encoded path characters. Authorization must therefore use the
 * matched route and a canonical fallback, never a raw string prefix alone.
 */
function canonicalRequestPath(rawUrl: string): string | null {
  const rawPath = rawUrl.split("?", 1)[0] ?? "/";
  try {
    let decoded = rawPath;
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return new URL(decoded.replaceAll("\\", "/"), "http://localhost").pathname
      .replace(/\/{2,}/g, "/");
  } catch {
    return null;
  }
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  graph?: KnowledgeGraphService,
  graphConfiguration?: GraphConfigurationService,
  policy?: PolicyService,
  gateway?: ResourceGateway,
  knowledgeObservations?: KnowledgeObservationService,
  runTimeline?: RunTimeline,
  securityRuntime?: {
    principal: AuthenticatedPrincipal;
    identities: ExecutionIdentityService;
    delegations: DelegationService;
    baselines: BehavioralBaselineService;
    security: SecurityStore;
    controlledActions: ControlledActionRuntime;
    safetyEvidence: SafetyEvidenceService;
  },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  /**
   * The demo has one server-attested principal. Identity-like headers and
   * request-body fields never select a different person or role.
   */
  const actorPrincipalId = (authenticated: boolean) =>
    authenticated ? "principal:operator" : "principal:local-dev";
  const principalFor = (request: { headers: Record<string, unknown> }): AuthenticatedPrincipal =>
    securityRuntime?.principal ?? {
      id: actorPrincipalId(config.authToken.length > 0 && Boolean(request.headers.authorization)),
      kind: "system",
      displayName: "Local operator",
      role: "operator",
      authenticationSource: "system",
    };
  const requireDurableRole = async (
    request: { headers: Record<string, unknown> },
    allowedRoles: readonly AuthenticatedPrincipal["role"][],
    message: string,
  ) => {
    const principal = principalFor(request);
    // Narrow unit tests may compose only the legacy lifecycle service. In the
    // integrated application, SQLite is authoritative and a stale process-local
    // role must fail closed after a downgrade or deactivation.
    if (securityRuntime) {
      const durablePrincipal = await securityRuntime.security.getPrincipal(principal.id);
      if (
        !durablePrincipal ||
        durablePrincipal.role !== principal.role ||
        !allowedRoles.includes(durablePrincipal.role)
      ) {
        throw new HttpError(403, message);
      }
    }
    return principal;
  };
  const requireGraphAdministrator = async (request: { headers: Record<string, unknown> }) => {
    return requireDurableRole(
      request,
      ["admin"],
      "Only an administrator may change graph permissions or safety facts",
    );
  };

  app.addHook("onRequest", async (request, reply) => {
    const matchedPath = request.routeOptions.url ?? "";
    const canonicalPath = canonicalRequestPath(request.url);
    const isApiRequest =
      matchedPath.startsWith("/api/") || canonicalPath?.startsWith("/api/") === true;
    const isPublicApi =
      matchedPath === "/api/health" ||
      matchedPath === "/api/auth" ||
      canonicalPath === "/api/health" ||
      canonicalPath === "/api/auth";
    if (
      !config.authToken ||
      !isApiRequest ||
      isPublicApi
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    await requireDurableRole(
      request,
      ["operator", "admin"],
      "Only an operator or administrator may create Agents",
    );
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  if (graph && graphConfiguration) {
    app.get("/api/graph", async () => ({
      graph: await graphConfiguration.getCatalog(),
    }));

    app.get("/api/agents/:id/graph", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      service.getAgent(id);
      return { graph: await graph.getAgentGraph(id) };
    });

    app.get("/api/agents/:id/blast-radius", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      service.getAgent(id);
      return { blastRadius: await graph.calculateBlastRadius(id) };
    });

    app.post("/api/graph/nodes", async (request, reply) => {
      await requireGraphAdministrator(request);
      const body = graphNodeBody.parse(request.body);
      return reply.code(201).send({ node: await graphConfiguration.createNode(body) });
    });

    app.post("/api/agents/:id/graph/relationships", async (request, reply) => {
      await requireGraphAdministrator(request);
      const { id } = agentIdParams.parse(request.params);
      service.getAgent(id);
      const body = graphRelationshipBody.parse(request.body);
      return reply.code(201).send({
        edge: await graphConfiguration.createRelationship(id, body),
      });
    });

    app.post("/api/agents/:id/prompt-analysis", async (request) => {
      const { id } = agentIdParams.parse(request.params);
      service.getAgent(id);
      const { prompt } = promptAnalysisBody.parse(request.body);
      return { analysis: await graphConfiguration.analyzePrompt(id, prompt) };
    });

    app.post("/api/agents/:id/graph/suggestions/confirm", async (request, reply) => {
      await requireGraphAdministrator(request);
      const { id } = agentIdParams.parse(request.params);
      service.getAgent(id);
      const body = confirmPromptSuggestionBody.parse(request.body);
      return reply.code(201).send({
        result: await graphConfiguration.confirmPromptSuggestion(id, body),
      });
    });

    if (knowledgeObservations) {
      app.get("/api/agents/:id/observations", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        return { observations: await knowledgeObservations.listForAgent(id) };
      });

      app.post("/api/agents/:id/observations/:observationId/confirm", async (request) => {
        await requireGraphAdministrator(request);
        const { id, observationId } = observationIdParams.parse(request.params);
        service.getAgent(id);
        return { observation: await knowledgeObservations.resolve(id, observationId, "confirmed") };
      });

      app.post("/api/agents/:id/observations/:observationId/reject", async (request) => {
        await requireGraphAdministrator(request);
        const { id, observationId } = observationIdParams.parse(request.params);
        service.getAgent(id);
        return { observation: await knowledgeObservations.resolve(id, observationId, "rejected") };
      });
    }
  }

  if (policy && gateway) {
    app.post("/api/runs/:id/actions", async (request, reply) => {
      const { id } = runIdParams.parse(request.params);
      const body = protectedActionBody.parse(request.body);
      const outcome = await gateway.request({
        runId: id,
        operationId: body.operationId,
        capability: body.capability,
        targetNodeId: body.targetNodeId,
        payload: body.payload,
        principal: principalFor(request),
        ...(body.delegationId ? { delegationId: body.delegationId } : {}),
      });
      const statusCode =
        outcome.status === "executed" ? 200 : outcome.status === "denied" ? 403 : 202;
      return reply.code(statusCode).send(outcome);
    });

    app.post("/api/runs/:id/actions/resume", async (request, reply) => {
      const { id } = runIdParams.parse(request.params);
      const body = resumeActionBody.parse(request.body);
      const outcome = await gateway.resume({
        runId: id,
        decisionId: body.decisionId,
        payload: body.payload,
        principal: principalFor(request),
        ...(body.delegationId ? { delegationId: body.delegationId } : {}),
      });
      return reply.code(outcome.status === "executed" ? 200 : 403).send(outcome);
    });

    app.post("/api/runs/:id/resume", async (request) => {
      await requireDurableRole(
        request,
        ["operator", "admin"],
        "Only an operator or administrator may resume an Agent Run",
      );
      const { id } = runIdParams.parse(request.params);
      return { run: await service.resumeRun(id, principalFor(request)) };
    });

    app.get("/api/runs/:id/policy", async (request) => {
      const { id } = runIdParams.parse(request.params);
      service.getRun(id);
      return { decisions: await policy.getDecisionsForRun(id) };
    });

    app.get("/api/policy/decisions/:id", async (request) => {
      const { id } = decisionIdParams.parse(request.params);
      return policy.getDecision(id);
    });

    app.get("/api/policy/approvals", async (request) => {
      const { status } = approvalQuery.parse(request.query);
      return { approvals: await policy.listApprovals(status ?? "pending") };
    });

    app.post("/api/policy/approvals/:id/approve", async (request) => {
      const { id } = approvalIdParams.parse(request.params);
      const body = approvalDecisionBody.parse(request.body ?? {});
      const principal = await requireDurableRole(
        request,
        ["approver", "admin"],
        "This identity is not allowed to approve unusual actions",
      );
      return policy.resolveApproval({
        approvalRequestId: id,
        resolution: "approved",
        actorPrincipalId: principal.id,
        actorHumanNodeId: securityRuntime ? undefined : body.actorHumanNodeId,
        reason: body.reason,
      });
    });

    app.post("/api/policy/approvals/:id/reject", async (request) => {
      const { id } = approvalIdParams.parse(request.params);
      const body = approvalDecisionBody.parse(request.body ?? {});
      const principal = await requireDurableRole(
        request,
        ["approver", "admin"],
        "This identity is not allowed to reject unusual actions",
      );
      const resolved = await policy.resolveApproval({
        approvalRequestId: id,
        resolution: "rejected",
        actorPrincipalId: principal.id,
        actorHumanNodeId: securityRuntime ? undefined : body.actorHumanNodeId,
        reason: body.reason,
      });
      // A refused pre-run review must end the Run, not leave it paused forever.
      const decision = await policy.getDecision(resolved.approvalRequest.decisionId);
      if (decision.decision.operationId.startsWith("run-gate:")) {
        await service.rejectPendingRun(
          decision.decision.runId,
          `A reviewer rejected this run: ${body.reason ?? "no reason given"}`,
          principal,
        );
      } else if (
        decision.decision.operationId.startsWith("managed:") &&
        securityRuntime
      ) {
        await securityRuntime.controlledActions.finishRejected(
          decision.decision.runId,
          body.reason ?? "no reason given",
        );
      } else if (decision.decision.operationId.startsWith("model-proposed:")) {
        await service.rejectPendingMediatedAction(
          decision.decision.runId,
          body.reason ?? "no reason given",
        );
      }
      return resolved;
    });

    if (securityRuntime && graph) {
      if (graphConfiguration) {
        app.post("/api/agents/:id/prompt-requests", async (request) => {
          const { id } = agentIdParams.parse(request.params);
          service.getAgent(id);
          const { content } = promptRequestBody.parse(request.body);

          // Declarative relationship evidence is never executed as an action.
          // It enters a quarantined observation queue and cannot affect
          // authority or risk until an administrator confirms it.
          if (
            knowledgeObservations &&
            extractRelationshipCandidates(content, "prompt").length > 0
          ) {
            const observations = await knowledgeObservations.observeText({
              agentId: id,
              sourceKind: "prompt",
              text: content,
            });
            if (observations.length > 0) {
              return {
                kind: "relationship_observation" as const,
                observations,
                explanation: `${observations.length} possible ${observations.length === 1 ? "relationship was" : "relationships were"} found in the request. It remains quarantined until a person confirms it.`,
              };
            }
          }

          return {
            kind: "unhandled" as const,
            explanation: "The request will continue through the real Codex Agent. If Codex proposes a protected action, the server validates it and routes it through the Resource Gateway.",
          };
        });
      }

      app.post("/api/agents/:id/managed-actions", async (request, reply) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        const body = managedActionBody.parse(request.body);
        const result = await securityRuntime.controlledActions.request({
          agentId: id,
          principal: principalFor(request),
          capability: body.capability,
          targetNodeId: body.targetNodeId,
          ...(body.payload ? { payload: body.payload } : {}),
          ...(body.delegationId ? { delegationId: body.delegationId } : {}),
        });
        const code = result.outcome.status === "executed" ? 200 : result.outcome.status === "approval_required" ? 202 : 403;
        return reply.code(code).send(result);
      });

      app.post("/api/runs/:id/managed-actions/resume", async (request, reply) => {
        const { id } = runIdParams.parse(request.params);
        const body = resumeActionBody.parse(request.body);
        const result = await securityRuntime.controlledActions.resume({
          runId: id,
          decisionId: body.decisionId,
          principal: principalFor(request),
          ...(body.payload ? { payload: body.payload } : {}),
          ...(body.delegationId ? { delegationId: body.delegationId } : {}),
        });
        return reply.code(result.outcome.status === "executed" ? 200 : 403).send(result);
      });

      app.post("/api/runs/:id/delegations", async (request, reply) => {
        const { id } = runIdParams.parse(request.params);
        const body = delegationBody.parse(request.body);
        const identity = await securityRuntime.identities.resolve({
          runId: id,
          principal: principalFor(request),
          ...(body.parentDelegationId ? { delegationId: body.parentDelegationId } : {}),
        });
        const delegation = await securityRuntime.delegations.delegate({
          identity,
          childAgentId: body.childAgentId,
          requestedScope: body.scope,
          expiresAt: body.expiresAt,
          ...(body.reason ? { reason: body.reason } : {}),
        });
        return reply.code(201).send({ delegation });
      });

      app.post("/api/delegations/:id/revoke", async (request) => {
        const { id } = delegationIdParams.parse(request.params);
        const { reason } = breakerResetBody.parse(request.body);
        const existing = await securityRuntime.security.getDelegation(id);
        if (!existing) throw new HttpError(404, "Delegation not found");
        const identity = await securityRuntime.identities.resolve({
          runId: existing.runId,
          principal: principalFor(request),
          ...(existing.parentDelegationId ? { delegationId: existing.parentDelegationId } : {}),
        });
        return { delegation: await securityRuntime.delegations.revoke(identity, id, reason) };
      });

      app.get("/api/agents/:id/behavior-baseline", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        return { baseline: await securityRuntime.baselines.rebuild(id) };
      });

      app.get("/api/agents/:id/circuit-breaker", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        return { circuitBreaker: await securityRuntime.security.getBreaker(id) };
      });

      app.get("/api/agents/:id/safety-evidence/latest", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        return { evidence: await securityRuntime.safetyEvidence.latestForAgent(id) };
      });

      app.post("/api/agents/:id/circuit-breaker/reset", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        const principal = await requireDurableRole(
          request,
          ["admin"],
          "Only an administrator may reset the safety stop",
        );
        const { reason } = breakerResetBody.parse(request.body);
        return securityRuntime.controlledActions.resetSafetyStop({
          agentId: id,
          principal,
          reason,
        });
      });

      app.get("/api/graph/resources/:id/impact", async (request) => {
        const { id } = resourceIdParams.parse(request.params);
        return {
          owners: await graph.ownersOfResource(id),
          downstream: await graph.downstreamDependents(id),
          inbound: await graph.inboundDependencies(id),
          affectingAgents: await graph.agentsAffectingResource(id),
          relatedRunIds: await graph.runsRelatedToResource(id),
        };
      });

      app.get("/api/agents/:id/reachable-resources", async (request) => {
        const { id } = agentIdParams.parse(request.params);
        service.getAgent(id);
        return { resources: await graph.reachableResources(id) };
      });

      app.get("/api/agents/:agentId/path-to/:resourceId", async (request) => {
        const { agentId, resourceId } = agentResourceParams.parse(request.params);
        service.getAgent(agentId);
        return { path: await graph.relevantAgentResourcePath(agentId, resourceId) };
      });
    }
  }

  app.patch("/api/agents/:id", async (request) => {
    await requireDurableRole(
      request,
      ["operator", "admin"],
      "Only an operator or administrator may update Agents",
    );
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    await requireDurableRole(
      request,
      ["admin"],
      "Only an administrator may delete Agents",
    );
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    await requireDurableRole(
      request,
      ["operator", "admin"],
      "Only an operator or administrator may start Agents",
    );
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    await requireDurableRole(
      request,
      ["operator", "admin"],
      "Only an operator or administrator may stop Agents",
    );
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    await requireDurableRole(
      request,
      ["operator", "admin"],
      "Only an operator or administrator may start Agent work",
    );
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, securityRuntime?.principal);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  if (runTimeline) {
    app.get("/api/runs/:id/events", async (request) => {
      const { id } = runIdParams.parse(request.params);
      // Run lookup is the authorization boundary for the current demo API and
      // prevents using this route to enumerate arbitrary weak Run references.
      service.getRun(id);
      return {
        events: (await runTimeline.list(id))
          .slice()
          .sort((left, right) => left.sequence - right.sequence)
          .map(projectRunEvent),
      };
    });
  }

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const middlewareStatus =
      error instanceof MiddlewareStoreError
        ? error.code === "VALIDATION"
          ? 400
          : error.code === "NOT_FOUND"
            ? 404
            : 409
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : middlewareStatus
            ? middlewareStatus
            : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
              ? frameworkStatus
              : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
