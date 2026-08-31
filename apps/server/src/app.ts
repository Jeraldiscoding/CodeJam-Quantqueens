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
});
const resumeActionBody = z.object({
  decisionId: z.string().min(3).max(180),
  payload: z.record(z.string(), z.unknown()).optional(),
});
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
      const body = graphNodeBody.parse(request.body);
      return reply.code(201).send({ node: await graphConfiguration.createNode(body) });
    });

    app.post("/api/agents/:id/graph/relationships", async (request, reply) => {
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
        const { id, observationId } = observationIdParams.parse(request.params);
        service.getAgent(id);
        return { observation: await knowledgeObservations.resolve(id, observationId, "confirmed") };
      });

      app.post("/api/agents/:id/observations/:observationId/reject", async (request) => {
        const { id, observationId } = observationIdParams.parse(request.params);
        service.getAgent(id);
        return { observation: await knowledgeObservations.resolve(id, observationId, "rejected") };
      });
    }
  }

  if (policy && gateway) {
    /**
     * Actor identity is derived on the server from the authenticated request,
     * never from the body. A caller cannot claim to be someone else.
     */
    const actorPrincipalId = (authenticated: boolean) =>
      authenticated ? "principal:operator" : "principal:local-dev";
    const principalFor = (request: { headers: Record<string, unknown> }) =>
      actorPrincipalId(config.authToken.length > 0 && Boolean(request.headers.authorization));

    app.post("/api/runs/:id/actions", async (request, reply) => {
      const { id } = runIdParams.parse(request.params);
      const body = protectedActionBody.parse(request.body);
      const outcome = await gateway.request({
        runId: id,
        operationId: body.operationId,
        capability: body.capability,
        targetNodeId: body.targetNodeId,
        payload: body.payload,
        actorPrincipalId: principalFor(request),
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
        actorPrincipalId: principalFor(request),
      });
      return reply.code(outcome.status === "executed" ? 200 : 403).send(outcome);
    });

    app.post("/api/runs/:id/resume", async (request) => {
      const { id } = runIdParams.parse(request.params);
      return { run: await service.resumeRun(id) };
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
      return policy.resolveApproval({
        approvalRequestId: id,
        resolution: "approved",
        actorPrincipalId: principalFor(request),
        actorHumanNodeId: body.actorHumanNodeId,
        reason: body.reason,
      });
    });

    app.post("/api/policy/approvals/:id/reject", async (request) => {
      const { id } = approvalIdParams.parse(request.params);
      const body = approvalDecisionBody.parse(request.body ?? {});
      const resolved = await policy.resolveApproval({
        approvalRequestId: id,
        resolution: "rejected",
        actorPrincipalId: principalFor(request),
        actorHumanNodeId: body.actorHumanNodeId,
        reason: body.reason,
      });
      // A refused pre-run review must end the Run, not leave it paused forever.
      const decision = await policy.getDecision(resolved.approvalRequest.decisionId);
      if (decision.decision.operationId.startsWith("run-gate:")) {
        await service.rejectPendingRun(
          decision.decision.runId,
          `A reviewer rejected this run: ${body.reason ?? "no reason given"}`,
        );
      }
      return resolved;
    });
  }

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
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
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

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
