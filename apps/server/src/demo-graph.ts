import type { GraphEdge, GraphNode } from "./graph-types.js";

export interface DemoGraphSeed {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const demoAgents = {
  releaseGuardian: {
    id: "d7b3a871-81e1-4965-9a88-bef875c3bb19",
    name: "Release Guardian",
    description: "Maps deployment permissions to customer-data impact.",
    instructions:
      "Help users understand release readiness, deployment impact, and which production changes need review. Explain recommendations in operational language.",
  },
  dataSteward: {
    id: "4d5661a8-49e5-4fe7-b430-cb8fd59e0633",
    name: "Data Steward",
    description: "Reviews approved access to shared customer data.",
    instructions:
      "Help users understand approved customer-data access, responsible data handling, and when a request needs human review. Keep summaries focused on the user's data task.",
  },
} as const;

/**
 * Every platform Agent receives its own graph identity. Relationships are
 * deliberately not inferred at creation time: non-demo Agents start empty
 * until a resource, permission, or ownership fact is configured explicitly.
 */
export function createUnconfiguredAgentNode(
  agentId: string,
  agentLabel: string,
  createdAt = new Date().toISOString(),
): GraphNode {
  return {
    id: `agent:${agentId}`,
    type: "agent",
    label: agentLabel,
    riskLevel: "low",
    riskWeight: 0,
    classification: "internal",
    metadata: { agentId },
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * The named demo topologies used by the graph UI and persistence seed path.
 * Only the two demo Agent UUIDs receive example facts; all other Agents use
 * createUnconfiguredAgentNode until their real relationships are configured.
 */
export function createDemoGraphSeed(
  agentId: string,
  agentLabel: string,
  createdAt = new Date().toISOString(),
): DemoGraphSeed {
  const agentNodeId = `agent:${agentId}`;
  const isDataSteward = agentId === demoAgents.dataSteward.id;
  const node = (
    id: string,
    type: GraphNode["type"],
    label: string,
    riskLevel: GraphNode["riskLevel"],
    riskWeight: number,
    classification: GraphNode["classification"],
    metadata: Record<string, unknown> = {},
  ): GraphNode => ({
    id,
    type,
    label,
    riskLevel,
    riskWeight,
    classification,
    metadata,
    createdAt,
    updatedAt: createdAt,
  });
  const edge = (
    id: string,
    sourceId: string,
    targetId: string,
    relation: GraphEdge["relation"],
  ): GraphEdge => ({
    id,
    sourceId,
    targetId,
    relation,
    status: "authorized",
    metadata: {},
    createdAt,
  });

  return {
    nodes: [
      node(
        isDataSteward ? "human:marcus" : "human:alice",
        "human",
        isDataSteward ? "Marcus (Demo Owner)" : "Alice (Demo Owner)",
        "low",
        0,
        "internal",
      ),
      ...(!isDataSteward
        ? [
            node(
              "human:bob",
              "human",
              "Bob (Demo User)",
              "low",
              0,
              "internal",
            ),
          ]
        : []),
      node(agentNodeId, "agent", agentLabel, "medium", 0, "internal", { agentId }),
      ...(!isDataSteward
        ? [
            node(
              "asset:alice-private-records",
              "asset",
              "Alice's private records",
              "low",
              0,
              "internal",
              { kind: "mock_user_data", adapterKind: "managed_state", ownerId: "human:alice" },
            ),
            node(
              "asset:bob-private-records",
              "asset",
              "Bob's private records",
              "low",
              0,
              "internal",
              { kind: "mock_user_data", adapterKind: "managed_state", ownerId: "human:bob" },
            ),
          ]
        : []),
      node(
        "asset:deployment-config",
        "asset",
        "Deployment configuration",
        "medium",
        4,
        "internal",
        { kind: "configuration", adapterKind: "managed_state" },
      ),
      node(
        "asset:staging-config",
        "asset",
        "Staging configuration",
        "low",
        0,
        "internal",
        { kind: "configuration", adapterKind: "managed_state" },
      ),
      node(
        "asset:production-service",
        "asset",
        "Production service",
        "high",
        7,
        "confidential",
        { kind: "service" },
      ),
      node(
        "asset:customer-dataset",
        "asset",
        "Customer dataset",
        "critical",
        10,
        "restricted",
        { kind: "dataset" },
      ),
      node("asset:release-api", "asset", "Release API", "low", 0, "internal", {
        kind: "service",
      }),
      node("asset:staging-service", "asset", "Staging service", "low", 0, "internal", {
        kind: "service",
      }),
      node("asset:synthetic-dataset", "asset", "Synthetic dataset", "low", 0, "internal", {
        kind: "dataset",
      }),
      node("data_category:pii", "data_category", "PII", "low", 0, "restricted", {
        code: "pii",
      }),
      node("data_category:synthetic", "data_category", "Test data", "low", 0, "internal", {
        code: "synthetic",
      }),
    ],
    edges: [
      edge(
        isDataSteward ? "demo:marcus-owns-steward" : "demo:alice-owns-release",
        isDataSteward ? "human:marcus" : "human:alice",
        agentNodeId,
        "OWNS",
      ),
      ...(isDataSteward
        ? [edge("demo:steward-can-read-customers", agentNodeId, "asset:customer-dataset", "CAN_READ")]
        : [
            edge(
              "demo:alice-owns-private-records",
              "human:alice",
              "asset:alice-private-records",
              "OWNS",
            ),
            edge(
              "demo:bob-owns-private-records",
              "human:bob",
              "asset:bob-private-records",
              "OWNS",
            ),
            edge(
              "demo:release-can-read-alice-records",
              agentNodeId,
              "asset:alice-private-records",
              "CAN_READ",
            ),
            edge("demo:can-write-config", agentNodeId, "asset:deployment-config", "CAN_WRITE"),
            edge("demo:can-write-staging-config", agentNodeId, "asset:staging-config", "CAN_WRITE"),
            edge("demo:can-call-release-api", agentNodeId, "asset:release-api", "CAN_CALL"),
            edge("demo:config-deploys-production", "asset:deployment-config", "asset:production-service", "DEPLOYS_TO"),
            edge("demo:production-processes-customers", "asset:production-service", "asset:customer-dataset", "PROCESSES"),
            edge("demo:release-api-deploys-production", "asset:release-api", "asset:production-service", "DEPLOYS_TO"),
            edge("demo:config-deploys-staging", "asset:deployment-config", "asset:staging-service", "DEPLOYS_TO"),
            edge("demo:staging-config-deploys-staging", "asset:staging-config", "asset:staging-service", "DEPLOYS_TO"),
            edge("demo:staging-processes-synthetic", "asset:staging-service", "asset:synthetic-dataset", "PROCESSES"),
            edge("demo:customers-contain-pii", "asset:customer-dataset", "data_category:pii", "CONTAINS"),
            edge("demo:synthetic-contains-test-data", "asset:synthetic-dataset", "data_category:synthetic", "CONTAINS"),
          ]),
    ],
  };
}
