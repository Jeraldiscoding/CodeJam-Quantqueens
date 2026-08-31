import path from "node:path";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { KnowledgeObservationService } from "./knowledge-observation.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { PolicyService } from "./policy-service.js";
import { ResourceGateway } from "./resource-gateway.js";
import { KnowledgeGraphRunPolicyGate } from "./run-policy-gate.js";
import { createRunner } from "./runner-factory.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteKnowledgeObservationStore } from "./sqlite-knowledge-observation-store.js";
import { SqliteRunTimelineStore } from "./sqlite-run-timeline-store.js";
import { SqliteSecurityStore } from "./sqlite-security-store.js";
import { BehavioralBaselineService, BehavioralRiskService } from "./behavioral-security.js";
import { ExecutionIdentityService } from "./execution-identity.js";
import { DelegationService } from "./delegation-service.js";
import { SqliteManagedResourceAdapter } from "./managed-resource-adapter.js";
import { ControlledActionRuntime } from "./controlled-action-runtime.js";
import { SafetyEvidenceService } from "./safety-evidence.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const middlewareDatabase = new MiddlewareDatabase(
  path.join(config.dataDirectory, "middleware.db"),
);
await middlewareDatabase.initialize();
const graphStore = new SqliteGraphStore(middlewareDatabase);
const observationStore = new SqliteKnowledgeObservationStore(middlewareDatabase);
const knowledgeObservations = new KnowledgeObservationService(graphStore, observationStore);
const governanceStore = new SqliteGovernanceStore(middlewareDatabase);
const runTimeline = new SqliteRunTimelineStore(middlewareDatabase);
const securityStore = new SqliteSecurityStore(middlewareDatabase);
const graph = new KnowledgeGraphService(graphStore, config.policyReviewThreshold, observationStore);
const graphConfiguration = new GraphConfigurationService(graphStore, observationStore);

const principal = {
  id: config.principalId,
  kind: "human" as const,
  displayName: config.principalName,
  role: config.principalRole,
  authenticationSource: config.authToken ? "bearer_token" as const : "local_loopback" as const,
};
await securityStore.upsertPrincipal(principal);
let service!: AgentService;
const runDirectory = {
  getRun: (runId: string) => service.getRun(runId),
  getAgent: (agentId: string) => service.getAgent(agentId),
  getRuns: (agentId: string) => service.getRuns(agentId),
};
const baselines = new BehavioralBaselineService(securityStore, runTimeline, runDirectory);
const behavioralRisk = new BehavioralRiskService(
  securityStore,
  baselines,
  config.policyReviewThreshold,
  config.policyDenyThreshold,
);
const identities = new ExecutionIdentityService(runDirectory, securityStore, runTimeline);

const policy = new PolicyService(graph, graphStore, governanceStore, {
  reviewThreshold: config.policyReviewThreshold,
  denyThreshold: config.policyDenyThreshold,
  approvalTtlMs: config.policyApprovalTtlMs,
}, { security: securityStore, risk: behavioralRisk, timeline: runTimeline });
const runPolicyGate = new KnowledgeGraphRunPolicyGate(graph, policy);

const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  new DemoAgentGraphProvisioner(graphStore, {
    id: principal.id,
    label: principal.displayName,
  }),
  config.policyEnforcement ? runPolicyGate : undefined,
  knowledgeObservations,
  runTimeline,
);
await service.initialize();

const gateway = new ResourceGateway(
  policy,
  graphStore,
  service,
  new SqliteManagedResourceAdapter(securityStore),
  identities,
  runTimeline,
);
const controlledActions = new ControlledActionRuntime(
  service,
  gateway,
  securityStore,
  runTimeline,
);
const delegations = new DelegationService(securityStore, graph, runTimeline);
const safetyEvidence = new SafetyEvidenceService(
  runDirectory,
  policy,
  securityStore,
  runTimeline,
);

const app = await createApp(
  config,
  service,
  graph,
  graphConfiguration,
  policy,
  gateway,
  knowledgeObservations,
  runTimeline,
  {
    principal,
    identities,
    delegations,
    baselines,
    security: securityStore,
    controlledActions,
    safetyEvidence,
  },
);
app.addHook("onClose", () => middlewareDatabase.close());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
