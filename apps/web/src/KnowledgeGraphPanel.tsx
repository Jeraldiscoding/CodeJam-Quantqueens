import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { api, type AgentGraph, type BlastRadius, type GraphCatalog, type GraphEdge, type GraphNode } from "./api";
import type { Agent } from "./types";

type NodeKind = "human" | "agent" | "asset" | "data" | "run";
type NodeTone = "owner" | "primary-agent" | "primary-asset" | "context-asset" | "sensitive-data" | "safe-data";

interface VisualNode {
  id: string;
  kind: NodeKind;
  tone: NodeTone;
  label: string;
  detail: string;
  classification: string;
  risk: number;
  x: number;
  y: number;
}

interface VisualEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  detail: string;
  kind: "ownership" | "permission" | "impact" | "context";
  primary?: boolean;
}

interface VisualGraph {
  nodes: VisualNode[];
  edges: VisualEdge[];
  score: number;
  threshold: number;
  decision: "ALLOW" | "REVIEW_REQUIRED";
  isEmpty: boolean;
  evidence: string;
}

interface HoverDetail {
  title: string;
  detail: string;
  left: number;
  top: number;
}

const radius: Record<NodeTone, number> = {
  owner: 21,
  "primary-agent": 34,
  "primary-asset": 29,
  "context-asset": 24,
  "sensitive-data": 28,
  "safe-data": 22,
};
const mapWidth = 1180;
const mapHeight = 610;

function nodeKind(node: GraphNode): NodeKind {
  return node.type === "data_category" ? "data" : node.type;
}

function nodeTone(node: GraphNode, agentId: string): NodeTone {
  if (node.id === `agent:${agentId}`) return "primary-agent";
  if (node.type === "human") return "owner";
  if (node.type === "data_category") {
    return node.classification === "restricted" || node.classification === "confidential"
      ? "sensitive-data"
      : "safe-data";
  }
  if (node.type === "asset") return node.riskWeight > 0 ? "primary-asset" : "context-asset";
  return "context-asset";
}

function detailForNode(node: GraphNode): string {
  const risk = node.riskWeight > 0 ? ` It contributes ${node.riskWeight} risk points.` : "";
  return `${node.riskLevel} risk, ${node.classification} classification.${risk}`;
}

function edgeKind(relation: string): VisualEdge["kind"] {
  if (relation === "OWNS") return "ownership";
  if (relation.startsWith("CAN_")) return "permission";
  if (["ATTEMPTED", "TOUCHED", "DENIED"].includes(relation)) return "context";
  return "impact";
}

function detailForEdge(edge: GraphEdge): string {
  if (edge.relation === "OWNS") return "Ownership records accountability. It does not grant authority.";
  if (edge.relation.startsWith("CAN_")) return `Direct authorized capability: ${edge.relation}.`;
  return `${edge.relation} is an authorized downstream relationship.`;
}

function buildVisualGraph(agentId: string, graph: AgentGraph, blastRadius: BlastRadius): VisualGraph {
  const nodesById = new Map<string, GraphNode>([[graph.agent.id, graph.agent]]);
  for (const node of [...graph.owners, ...graph.reachableNodes]) nodesById.set(node.id, node);

  const levelByNodeId = new Map<string, number>([[graph.agent.id, 0]]);
  for (const path of graph.paths) {
    path.nodeIds.forEach((nodeId, index) => {
      const current = levelByNodeId.get(nodeId);
      if (current === undefined || index < current) levelByNodeId.set(nodeId, index);
    });
  }
  for (const owner of graph.owners) levelByNodeId.set(owner.id, -1);

  const maxLevel = Math.max(1, ...[...levelByNodeId.values()].filter((level) => level > 0));
  const nodesByLevel = new Map<number, GraphNode[]>();
  for (const node of nodesById.values()) {
    const level = levelByNodeId.get(node.id) ?? maxLevel;
    const group = nodesByLevel.get(level) ?? [];
    group.push(node);
    nodesByLevel.set(level, group);
  }
  for (const group of nodesByLevel.values()) group.sort((left, right) => left.label.localeCompare(right.label));

  const coordinates = new Map<string, { x: number; y: number }>();
  for (const [level, group] of nodesByLevel) {
    const x = level < 0 ? 105 : 155 + ((Math.min(level, maxLevel) / maxLevel) * 870);
    group.forEach((node, index) => {
      const y = node.id === graph.agent.id ? mapHeight / 2 : ((index + 1) * mapHeight) / (group.length + 1);
      coordinates.set(node.id, { x, y });
    });
  }

  const primaryEdgeIds = new Set(
    [...blastRadius.targets]
      .sort((left, right) => right.node.riskWeight - left.node.riskWeight)[0]
      ?.path.edgeIds ?? [],
  );
  const relationships: GraphEdge[] = [
    ...graph.capabilityEdges,
    ...graph.impactEdges,
    ...graph.owners.map((owner) => ({
      id: `owner:${owner.id}:${graph.agent.id}`,
      sourceId: owner.id,
      targetId: graph.agent.id,
      relation: "OWNS",
      status: "authorized" as const,
      metadata: {},
      createdAt: "",
    })),
  ];
  const edges = relationships
    .filter((edge) => coordinates.has(edge.sourceId) && coordinates.has(edge.targetId))
    .map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      relation: edge.relation,
      detail: detailForEdge(edge),
      kind: edgeKind(edge.relation),
      primary: primaryEdgeIds.has(edge.id),
    }));
  const targets = [...blastRadius.targets].sort(
    (left, right) => right.node.riskWeight - left.node.riskWeight,
  );
  const evidence = targets.length === 0
    ? "No direct permissions, connected assets, or protected-data impact have been configured."
    : `${targets.map(({ node }) => `${node.label} (${node.riskWeight})`).join(" · ")} = ${blastRadius.score} risk points.`;

  return {
    nodes: [...nodesById.values()].map((node) => ({
      id: node.id,
      kind: nodeKind(node),
      tone: nodeTone(node, agentId),
      label: node.label,
      detail: detailForNode(node),
      classification: node.classification,
      risk: node.riskWeight,
      ...coordinates.get(node.id)!,
    })),
    edges,
    score: blastRadius.score,
    threshold: blastRadius.threshold,
    decision: blastRadius.decision,
    isEmpty: graph.capabilityEdges.length === 0 && graph.impactEdges.length === 0,
    evidence,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const inferredRiskByClassification: Record<
  GraphNode["classification"],
  { level: GraphNode["riskLevel"]; weight: number }
> = {
  public: { level: "low", weight: 0 },
  internal: { level: "low", weight: 2 },
  confidential: { level: "high", weight: 7 },
  restricted: { level: "critical", weight: 10 },
};

function inferReach(asset: GraphNode, catalog: GraphCatalog): { assets: GraphNode[]; score: number } {
  const nodesById = new Map(catalog.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of catalog.edges) {
    if (edge.status !== "authorized" || !["DEPLOYS_TO", "PROCESSES", "CONTAINS"].includes(edge.relation)) continue;
    const group = outgoing.get(edge.sourceId) ?? [];
    group.push(edge);
    outgoing.set(edge.sourceId, group);
  }
  const visited = new Set<string>();
  const queue = [asset.id];
  const assets: GraphNode[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodesById.get(nodeId);
    if (node?.type === "asset") assets.push(node);
    for (const edge of outgoing.get(nodeId) ?? []) queue.push(edge.targetId);
  }
  return { assets, score: assets.reduce((total, node) => total + node.riskWeight, 0) };
}

function GraphAccessConfigurator({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [catalog, setCatalog] = useState<GraphCatalog | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [assetId, setAssetId] = useState("");
  const [label, setLabel] = useState("");
  const [classification, setClassification] = useState<GraphNode["classification"]>("internal");
  const [relation, setRelation] = useState("CAN_READ");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = () => api.wholeGraph().then(({ graph }) => {
    setCatalog(graph);
    setAssetId((current) => current || graph.nodes.find((node) => node.type === "asset")?.id || "");
  });

  useEffect(() => {
    let cancelled = false;
    void api.wholeGraph().then(({ graph }) => {
      if (cancelled) return;
      setCatalog(graph);
      setAssetId(graph.nodes.find((node) => node.type === "asset")?.id ?? "");
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load available assets.");
    });
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const assets = catalog?.nodes.filter((node) => node.type === "asset") ?? [];
  const selectedAsset = assets.find((asset) => asset.id === assetId) ?? null;
  const preview = mode === "existing" && selectedAsset && catalog
    ? inferReach(selectedAsset, catalog)
    : { assets: [], score: inferredRiskByClassification[classification].weight };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const target = mode === "new"
        ? (await api.createGraphNode({ type: "asset", label, classification })).node
        : selectedAsset;
      if (!target) throw new Error("Choose an existing asset or create a new one.");
      await api.createGraphRelationship(agent.id, {
        sourceId: `agent:${agent.id}`,
        targetId: target.id,
        relation,
      });
      await loadCatalog();
      setLabel("");
      setMessage(`${relation.replace("CAN_", "").toLowerCase()} access connected to ${target.label}. The impact path and risk were inferred from the shared graph.`);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to connect this access.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="graph-configurator" aria-labelledby="graph-configurator-title">
      <div className="graph-configurator-intro"><span className="eyebrow">Guided configuration</span><h3 id="graph-configurator-title">Connect trusted access, infer the consequence</h3><p>You confirm the access and classification. Existing dependencies, reachable assets, and Blast Radius are derived automatically.</p></div>
      <form onSubmit={submit}>
        <div className="graph-config-mode" role="group" aria-label="Asset source"><button type="button" className={mode === "existing" ? "active" : ""} onClick={() => setMode("existing")}>Existing asset</button><button type="button" className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>New asset</button></div>
        <div className="graph-config-fields">
          {mode === "existing" ? <label>Protected asset<select value={assetId} onChange={(event) => setAssetId(event.target.value)} required>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label} · {asset.classification}</option>)}</select></label> : <><label>Asset name<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Finance reporting API" maxLength={120} required /></label><label>Classification<select value={classification} onChange={(event) => setClassification(event.target.value as GraphNode["classification"])}><option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option></select></label></>}
          <label>Agent access<select value={relation} onChange={(event) => setRelation(event.target.value)}><option value="CAN_READ">Read</option><option value="CAN_WRITE">Write</option><option value="CAN_CALL">Call</option><option value="CAN_USE">Use</option></select></label>
        </div>
        <div className="graph-inference-preview"><span>Inferred impact</span><strong>{mode === "existing" ? `${preview.assets.length} reachable asset${preview.assets.length === 1 ? "" : "s"} · ${preview.score} risk points` : `${inferredRiskByClassification[classification].level} risk · ${preview.score} points`}</strong><p>{mode === "existing" && preview.assets.length > 0 ? preview.assets.map((asset) => asset.label).join(" → ") : "New assets start without downstream dependencies. Connect them later from the network map."}</p></div>
        {error && <p className="graph-config-message graph-config-error" role="alert">{error}</p>}
        {message && <p className="graph-config-message" role="status">{message}</p>}
        <button className="button button-primary" disabled={busy || (mode === "existing" ? !selectedAsset : !label.trim())}>{busy ? "Connecting…" : "Connect access"}</button>
      </form>
    </section>
  );
}

export function KnowledgeGraphPanel({ agent }: { agent: Agent }) {
  const [graphData, setGraphData] = useState<{ graph: AgentGraph; blastRadius: BlastRadius } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState(`agent:${agent.id}`);
  const [pathHighlighted, setPathHighlighted] = useState(true);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<HoverDetail | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    void Promise.all([api.graph(agent.id), api.blastRadius(agent.id)])
      .then(([graphResult, blastRadiusResult]) => {
        if (!cancelled) setGraphData({ graph: graphResult.graph, blastRadius: blastRadiusResult.blastRadius });
      })
      .catch((reason) => {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : "Unable to load the live graph.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.updatedAt, reloadToken]);

  useEffect(() => {
    setSelectedNodeId(`agent:${agent.id}`);
    setViewport({ x: 0, y: 0, scale: 1 });
    setHover(null);
  }, [agent.id]);

  const graph = useMemo(
    () => graphData && buildVisualGraph(agent.id, graphData.graph, graphData.blastRadius),
    [agent.id, graphData],
  );
  const nodesById = useMemo(() => new Map(graph?.nodes.map((node) => [node.id, node]) ?? []), [graph]);
  const selectedNode = nodesById.get(selectedNodeId) ?? graph?.nodes[0] ?? null;

  const placeHover = (event: PointerEvent<SVGGElement>, title: string, detail: string) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setHover({ title, detail, left: clamp(event.clientX - bounds.left + 16, 12, bounds.width - 246), top: clamp(event.clientY - bounds.top + 16, 12, bounds.height - 98) });
  };
  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest(".graph-interactive")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: viewport.x, originY: viewport.y };
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const ratio = mapWidth / event.currentTarget.getBoundingClientRect().width;
    setViewport((current) => ({ ...current, x: drag.originX + (event.clientX - drag.x) * ratio, y: drag.originY + (event.clientY - drag.y) * ratio }));
  };
  const finishPan = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const zoomWithWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setViewport((current) => ({ ...current, scale: clamp(current.scale + (event.deltaY < 0 ? 0.12 : -0.12), 0.65, 1.8) }));
  };

  if (isLoading && !graph) {
    return <section className="graph-panel graph-panel-loading" aria-busy="true"><div className="graph-loading-copy"><span className="eyebrow">Knowledge Graph</span><h2>Loading live relationship data</h2><p>The panel is reading the selected Agent’s graph from the control plane.</p></div><div className="graph-loading-field" /></section>;
  }
  if (loadError || !graph || !selectedNode) {
    return <section className="graph-panel graph-panel-error" role="alert"><span className="eyebrow">Knowledge Graph</span><h2>Live graph unavailable</h2><p>{loadError ?? "The selected Agent has no readable graph record."}</p><button className="button button-primary" onClick={() => setReloadToken((value) => value + 1)}>Try again</button></section>;
  }

  return (
    <section className="graph-panel" aria-labelledby="impact-map-title">
      <header className="graph-panel-header">
        <div><span className="eyebrow">Knowledge Graph · Live</span><h2 id="impact-map-title">{graph.isEmpty ? "Relationship field" : "Impact field"}</h2><p>{graph.isEmpty ? "This Agent has an identity, but no relationship facts have been configured yet." : "This view reflects the selected Agent’s currently stored permissions and downstream impact."}</p></div>
        <div className="graph-decision" aria-label={`Blast Radius ${graph.score} out of ${graph.threshold}, ${graph.decision === "REVIEW_REQUIRED" ? "review required" : "allowed"}`}><span>Blast Radius</span><strong>{graph.score} / {graph.threshold}</strong><b>{graph.decision === "REVIEW_REQUIRED" ? "Review required" : "Allowed"}</b></div>
      </header>

      <div className="graph-toolbar">
        <div className="graph-legend" aria-label="Graph legend"><span><i className="legend-node legend-agent" /> Selected Agent</span>{!graph.isEmpty && <><span><i className="legend-node legend-asset" /> Reachable asset</span><span><i className="legend-line legend-permission" /> Direct permission</span><span><i className="legend-line legend-impact" /> Downstream impact</span></>}</div>
        <div className="graph-actions"><span className="graph-hint">Drag to pan · Scroll to zoom</span><button className="map-control" onClick={() => setReloadToken((value) => value + 1)} aria-label="Refresh live graph" title="Refresh live graph">↻</button><button className="map-control" onClick={() => setViewport((current) => ({ ...current, scale: clamp(current.scale - 0.15, 0.65, 1.8) }))} aria-label="Zoom out">−</button><button className="map-control" onClick={() => setViewport({ x: 0, y: 0, scale: 1 })} aria-label="Reset map view">↺</button><button className="map-control" onClick={() => setViewport((current) => ({ ...current, scale: clamp(current.scale + 0.15, 0.65, 1.8) }))} aria-label="Zoom in">+</button>{!graph.isEmpty && <button className={"path-toggle " + (pathHighlighted ? "active" : "")} onClick={() => setPathHighlighted((value) => !value)} aria-pressed={pathHighlighted}>{pathHighlighted ? "Focus path on" : "Focus path"}</button>}</div>
      </div>

      <div className="graph-body">
        <div className="graph-canvas-wrap" ref={canvasRef} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={finishPan} onPointerCancel={finishPan} onWheel={zoomWithWheel}>
          {hover && <div className="graph-hover-tooltip" style={{ left: hover.left, top: hover.top }} role="status"><strong>{hover.title}</strong><span>{hover.detail}</span></div>}
          <svg className={"knowledge-graph " + (pathHighlighted ? "path-active" : "")} viewBox={`0 0 ${mapWidth} ${mapHeight}`} role="img" aria-label="Interactive live knowledge graph. Drag to pan and scroll to zoom.">
            <defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="graph-arrowhead" /></marker></defs>
            <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
              {!graph.isEmpty && <g className="graph-region-labels"><text x="45" y="42">ACCOUNTABILITY</text><text x="310" y="42">DIRECT ACCESS</text><text x="740" y="42">REACHABLE IMPACT</text></g>}
              {graph.edges.map((edge) => {
                const source = nodesById.get(edge.source)!;
                const target = nodesById.get(edge.target)!;
                const angle = Math.atan2(target.y - source.y, target.x - source.x);
                const x1 = source.x + Math.cos(angle) * radius[source.tone];
                const y1 = source.y + Math.sin(angle) * radius[source.tone];
                const x2 = target.x - Math.cos(angle) * (radius[target.tone] + 6);
                const y2 = target.y - Math.sin(angle) * (radius[target.tone] + 6);
                return <g key={edge.id} className={`graph-edge graph-edge-${edge.kind} ${edge.primary ? "graph-edge-primary" : ""} graph-interactive`} onPointerEnter={(event) => placeHover(event, edge.relation, edge.detail)} onPointerLeave={() => setHover(null)}><line className="graph-edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} /><line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#graph-arrow)" />{edge.primary && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor="middle">{edge.relation}</text>}</g>;
              })}
              {graph.nodes.map((node) => {
                const active = selectedNodeId === node.id;
                return <g key={node.id} className={`graph-node graph-node-${node.tone} graph-interactive ${active ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`Select ${node.label}`} aria-pressed={active} onClick={() => setSelectedNodeId(node.id)} onPointerEnter={(event) => placeHover(event, node.label, node.detail)} onPointerLeave={() => setHover(null)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedNodeId(node.id); } }}><title>{node.label}</title><circle cx={node.x} cy={node.y} r={radius[node.tone]} /><text className="graph-node-label" x={node.x} y={node.y + radius[node.tone] + 20} textAnchor="middle">{node.label}</text></g>;
              })}
              {graph.isEmpty && <text className="graph-empty-message" x={mapWidth / 2} y={mapHeight / 2 + 105} textAnchor="middle">No relationships configured</text>}
            </g>
          </svg>
        </div>

        <aside className="graph-inspector" aria-live="polite"><span className="eyebrow">Selected node</span><div className="inspector-title"><span className={`inspector-dot inspector-${selectedNode.tone}`} /><div><h3>{selectedNode.label}</h3><span>{selectedNode.kind === "data" ? "Data category" : selectedNode.kind}</span></div></div><p>{selectedNode.detail}</p><dl><div><dt>Classification</dt><dd>{selectedNode.classification}</dd></div><div><dt>Risk contribution</dt><dd>{selectedNode.risk ? `${selectedNode.risk} points` : "Context only"}</dd></div></dl><div className="inspector-note"><strong>Reading the field</strong>{selectedNode.risk > 0 ? " This node contributes once to the Blast Radius." : " This node supplies relationship context without increasing the score."}</div></aside>
      </div>

      <footer className="graph-evidence"><span>{graph.decision === "REVIEW_REQUIRED" ? "Why review?" : "Current evidence"}</span><p>{graph.evidence}</p></footer>
      <GraphAccessConfigurator agent={agent} onSaved={() => setReloadToken((value) => value + 1)} />
    </section>
  );
}
