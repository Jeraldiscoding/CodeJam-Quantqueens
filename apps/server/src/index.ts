import path from "node:path";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { MiddlewareDatabase } from "./middleware-database.js";
import { PolicyService } from "./policy-service.js";
import { DemoResourceAdapter, ResourceGateway } from "./resource-gateway.js";
import { KnowledgeGraphRunPolicyGate } from "./run-policy-gate.js";
import { createRunner } from "./runner-factory.js";
import { SqliteGovernanceStore } from "./sqlite-governance-store.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
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
const governanceStore = new SqliteGovernanceStore(middlewareDatabase);
const graph = new KnowledgeGraphService(graphStore, config.policyReviewThreshold);
const graphConfiguration = new GraphConfigurationService(graphStore);

const policy = new PolicyService(graph, graphStore, governanceStore, {
  reviewThreshold: config.policyReviewThreshold,
  denyThreshold: config.policyDenyThreshold,
  approvalTtlMs: config.policyApprovalTtlMs,
});
const runPolicyGate = new KnowledgeGraphRunPolicyGate(graph, policy);

const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  new DemoAgentGraphProvisioner(graphStore),
  config.policyEnforcement ? runPolicyGate : undefined,
);
await service.initialize();

const gateway = new ResourceGateway(policy, graphStore, service, new DemoResourceAdapter());

const app = await createApp(config, service, graph, graphConfiguration, policy, gateway);
app.addHook("onClose", () => middlewareDatabase.close());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
