import path from "node:path";
import { AgentService } from "./agent-service.js";
import { DemoAgentGraphProvisioner } from "./agent-graph-provisioner.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { GraphConfigurationService } from "./graph-configuration.js";
import { JsonGraphStore } from "./json-graph-store.js";
import { KnowledgeGraphService } from "./knowledge-graph.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const graphStore = new JsonGraphStore(store);
const graph = new KnowledgeGraphService(graphStore);
const graphConfiguration = new GraphConfigurationService(graphStore);
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(
  config,
  store,
  workspaces,
  runner,
  new DemoAgentGraphProvisioner(graphStore),
);
await service.initialize();

const app = await createApp(config, service, graph, graphConfiguration);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
