import { useEffect, useMemo, useState } from "react";
import { api, type GraphCatalog, type GraphEdge, type GraphNode, type GraphObservation } from "./api";

type OverallTone = "owner" | "peer-agent" | "primary-asset" | "context-asset" | "sensitive-data" | "safe-data";

interface PositionedNode extends GraphNode {
  tone: OverallTone;
  x: number;
  y: number;
}

interface NetworkEdge extends GraphEdge {
  observation?: GraphObservation;
}

const mapWidth = 1180;
const mapHeight = 610;
const radius: Record<OverallTone, number> = {
  owner: 21,
  "peer-agent": 28,
  "primary-asset": 27,
  "context-asset": 23,
  "sensitive-data": 26,
  "safe-data": 22,
};

const columnByType: Record<GraphNode["type"], number> = {
  human: 95,
  agent: 330,
  asset: 670,
  data_category: 1035,
  run: 1035,
};

function toneFor(node: GraphNode): OverallTone {
  if (node.type === "human") return "owner";
  if (node.type === "agent") return "peer-agent";
  if (node.type === "data_category") {
    return node.classification === "restricted" || node.classification === "confidential"
      ? "sensitive-data"
      : "safe-data";
  }
  return node.riskWeight > 0 ? "primary-asset" : "context-asset";
}

function positionNodes(nodes: GraphNode[]): PositionedNode[] {
  const groups = new Map<GraphNode["type"], GraphNode[]>();
  for (const node of nodes) {
    const group = groups.get(node.type) ?? [];
    group.push(node);
    groups.set(node.type, group);
  }
  const positioned: PositionedNode[] = [];
  for (const [type, group] of groups) {
    group.sort((left, right) => left.label.localeCompare(right.label));
    group.forEach((node, index) => {
      positioned.push({
        ...node,
        tone: toneFor(node),
        x: columnByType[type],
        y: ((index + 1) * mapHeight) / (group.length + 1),
      });
    });
  }
  return positioned;
}

function edgeClass(edge: NetworkEdge): string {
  if (edge.observation) return "inference";
  if (edge.relation === "OWNS") return "ownership";
  if (edge.relation.startsWith("CAN_")) return "permission";
  if (edge.status !== "authorized") return "context";
  return "impact";
}

export function OverallGraphPanel() {
  const [catalog, setCatalog] = useState<GraphCatalog | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void api.wholeGraph()
      .then(({ graph }) => {
        if (cancelled) return;
        setCatalog(graph);
        setSelectedNodeId((current) => current && graph.nodes.some(({ id }) => id === current)
          ? current
          : (graph.nodes[0]?.id ?? null));
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load the network graph.");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const nodes = useMemo(() => positionNodes(catalog?.nodes ?? []), [catalog]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = (selectedNodeId && nodesById.get(selectedNodeId)) || nodes[0] || null;
  const allEdges: NetworkEdge[] = [
    ...(catalog?.edges ?? []),
    ...(catalog?.observations ?? []).filter((observation) => observation.state !== "rejected").map((observation) => ({
      id: observation.id,
      sourceId: observation.sourceNodeId,
      targetId: observation.targetNodeId,
      relation: observation.relation,
      status: "actual" as const,
      ...(observation.runId ? { runId: observation.runId } : {}),
      metadata: {},
      createdAt: observation.createdAt,
      observation,
    })),
  ];
  const visibleEdges = allEdges.filter(
    (edge) => nodesById.has(edge.sourceId) && nodesById.has(edge.targetId),
  );

  if (!catalog && !error) {
    return <section className="graph-panel graph-panel-loading" aria-busy="true"><div className="graph-loading-copy"><span className="eyebrow">Network Graph</span><h2>Loading the shared topology</h2><p>Reading every stored identity, asset, data category, and relationship.</p></div><div className="graph-loading-field" /></section>;
  }
  if (error || !catalog || !selected) {
    return <section className="graph-panel graph-panel-error" role="alert"><span className="eyebrow">Network Graph</span><h2>Overall graph unavailable</h2><p>{error ?? "No graph nodes are available."}</p><button className="button button-primary" onClick={() => setReloadToken((value) => value + 1)}>Try again</button></section>;
  }

  const connectedEdges = visibleEdges.filter(
    (edge) => edge.sourceId === selected.id || edge.targetId === selected.id,
  );

  return (
    <section className="graph-panel" aria-labelledby="overall-graph-title">
      <header className="graph-panel-header overall-graph-header">
        <div><span className="eyebrow">Network Graph · Live</span><h2 id="overall-graph-title">Shared relationship map</h2><p>Solid lines are trusted configuration. Dashed lines are relationships learned from prompts and Agent replies, with evidence retained for review.</p></div>
        <div className="overall-graph-counts" aria-label={`${nodes.length} nodes and ${visibleEdges.length} relationships`}><span>{nodes.length} nodes</span><span>{visibleEdges.length} relationships</span></div>
      </header>
      <div className="graph-toolbar">
        <div className="graph-legend"><span><i className="legend-node legend-agent" /> Agent</span><span><i className="legend-node legend-asset" /> Asset</span><span><i className="legend-line legend-permission" /> Access</span><span><i className="legend-line legend-impact" /> Confirmed dependency</span><span><i className="legend-line legend-inference" /> Learned relationship</span></div>
        <button className="button button-ghost graph-refresh-button" onClick={() => setReloadToken((value) => value + 1)}>Refresh network</button>
      </div>
      <div className="graph-body">
        <div className="graph-canvas-wrap overall-graph-canvas">
          <svg className="knowledge-graph" viewBox={`0 0 ${mapWidth} ${mapHeight}`} role="img" aria-label="Overall knowledge graph containing every stored node and relationship.">
            <defs><marker id="overall-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="graph-arrowhead" /></marker></defs>
            <g className="graph-region-labels"><text x="45" y="38">PEOPLE</text><text x="275" y="38">AGENTS</text><text x="625" y="38">ASSETS</text><text x="955" y="38">DATA</text></g>
            {visibleEdges.map((edge) => {
              const source = nodesById.get(edge.sourceId)!;
              const target = nodesById.get(edge.targetId)!;
              const angle = Math.atan2(target.y - source.y, target.x - source.x);
              const x1 = source.x + Math.cos(angle) * radius[source.tone];
              const y1 = source.y + Math.sin(angle) * radius[source.tone];
              const x2 = target.x - Math.cos(angle) * (radius[target.tone] + 6);
              const y2 = target.y - Math.sin(angle) * (radius[target.tone] + 6);
              const highlighted = edge.sourceId === selected.id || edge.targetId === selected.id;
              return <g key={edge.id} className={`graph-edge graph-edge-${edgeClass(edge)} ${highlighted ? "overall-edge-selected" : ""}`}><line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#overall-graph-arrow)" /><title>{edge.relation}: {source.label} to {target.label}</title></g>;
            })}
            {nodes.map((node) => <g key={node.id} className={`graph-node graph-node-${node.tone} graph-interactive ${selected.id === node.id ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`Inspect ${node.label}`} aria-pressed={selected.id === node.id} onClick={() => setSelectedNodeId(node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedNodeId(node.id); } }}><circle cx={node.x} cy={node.y} r={radius[node.tone]} /><text className="graph-node-label" x={node.x} y={node.y + radius[node.tone] + 18} textAnchor="middle">{node.label}</text><title>{node.label}</title></g>)}
          </svg>
        </div>
        <aside className="graph-inspector" aria-live="polite"><span className="eyebrow">Network node</span><div className="inspector-title"><span className={`inspector-dot inspector-${selected.tone}`} /><div><h3>{selected.label}</h3><span>{selected.type.replace("_", " ")}</span></div></div><p>{connectedEdges.length === 0 ? "No stored relationships connect to this node yet." : `${connectedEdges.length} stored relationship${connectedEdges.length === 1 ? "" : "s"} connect this node to the network.`}</p><dl><div><dt>Classification</dt><dd>{selected.classification}</dd></div><div><dt>Risk</dt><dd>{selected.riskWeight} points</dd></div></dl><div className="overall-edge-list">{connectedEdges.map((edge) => <div key={edge.id}><strong>{edge.relation}{edge.observation ? ` · ${Math.round(edge.observation.confidence * 100)}%` : ""}</strong><span>{edge.sourceId === selected.id ? `to ${nodesById.get(edge.targetId)?.label}` : `from ${nodesById.get(edge.sourceId)?.label}`}</span>{edge.observation && <small>{edge.observation.state} · “{edge.observation.evidence}”</small>}</div>)}</div></aside>
      </div>
    </section>
  );
}
