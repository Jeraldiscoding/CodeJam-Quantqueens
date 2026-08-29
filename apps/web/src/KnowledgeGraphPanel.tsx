import {
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type { Agent } from "./types";

type NodeKind = "human" | "agent" | "asset" | "data";
type NodeTone = "owner" | "primary-agent" | "peer-agent" | "primary-asset" | "context-asset" | "sensitive-data" | "safe-data";

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
  peer?: boolean;
  supporting?: boolean;
}

interface VisualEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  detail: string;
  kind: "ownership" | "permission" | "impact" | "context";
  primary?: boolean;
  peer?: boolean;
  supporting?: boolean;
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
  "peer-agent": 28,
  "primary-asset": 29,
  "context-asset": 24,
  "sensitive-data": 28,
  "safe-data": 22,
};
const mapWidth = 1180;
const mapHeight = 610;
const releaseGuardianId = "d7b3a871-81e1-4965-9a88-bef875c3bb19";
const dataStewardId = "4d5661a8-49e5-4fe7-b430-cb8fd59e0633";

interface VisualGraph {
  nodes: VisualNode[];
  edges: VisualEdge[];
  score: number;
  decision: "ALLOW" | "REVIEW_REQUIRED";
  isEmpty?: boolean;
  evidence: string;
}

function releaseGraph(agent: Agent): VisualGraph {
  const agentNodeId = `agent:${agent.id}`;
  const nodes: VisualNode[] = [
    { id: "human:alice", kind: "human", tone: "owner", label: "Alice", detail: "Demo owner, accountable for the Release Guardian.", classification: "Internal", risk: 0, x: 96, y: 132 },
    { id: agentNodeId, kind: "agent", tone: "primary-agent", label: agent.name, detail: "The selected platform Agent. Its UUID is the canonical graph identity.", classification: "Internal", risk: 0, x: 152, y: 348 },
    { id: "asset:deployment-config", kind: "asset", tone: "primary-asset", label: "Deployment config", detail: "Protected configuration that this Agent may write.", classification: "Internal", risk: 4, x: 365, y: 338 },
    { id: "asset:release-api", kind: "asset", tone: "context-asset", label: "Release API", detail: "Protected deployment API. It gives supporting context but adds no extra risk in this demo.", classification: "Internal", risk: 0, x: 372, y: 510, supporting: true },
    { id: "asset:production-service", kind: "asset", tone: "primary-asset", label: "Production service", detail: "A production system affected by the configuration and Release API.", classification: "Confidential", risk: 7, x: 610, y: 235 },
    { id: "asset:staging-service", kind: "asset", tone: "context-asset", label: "Staging service", detail: "A lower-impact non-production comparison path.", classification: "Internal", risk: 0, x: 615, y: 480, supporting: true },
    { id: "asset:customer-dataset", kind: "asset", tone: "primary-asset", label: "Customer dataset", detail: "Restricted customer data processed by the production service.", classification: "Restricted", risk: 10, x: 840, y: 230 },
    { id: "asset:synthetic-dataset", kind: "asset", tone: "context-asset", label: "Synthetic dataset", detail: "Non-production test data used only in staging.", classification: "Internal", risk: 0, x: 840, y: 490, supporting: true },
    { id: "data_category:pii", kind: "data", tone: "sensitive-data", label: "PII", detail: "Personal data classification. It explains sensitivity but is not counted a second time.", classification: "Restricted", risk: 0, x: 1065, y: 130 },
    { id: "data_category:synthetic", kind: "data", tone: "safe-data", label: "Test data", detail: "Synthetic data classification that makes the staging branch visibly safer.", classification: "Internal", risk: 0, x: 1065, y: 535, supporting: true },
  ];
  const edges: VisualEdge[] = [
    { id: "owns", source: "human:alice", target: agentNodeId, relation: "OWNS", detail: "Ownership records accountability. It does not grant the Agent authority.", kind: "ownership" },
    { id: "can-write", source: agentNodeId, target: "asset:deployment-config", relation: "CAN_WRITE", detail: "Exact permission to change the deployment configuration.", kind: "permission", primary: true },
    { id: "can-call", source: agentNodeId, target: "asset:release-api", relation: "CAN_CALL", detail: "Exact permission to invoke the Release API.", kind: "permission", supporting: true },
    { id: "config-production", source: "asset:deployment-config", target: "asset:production-service", relation: "DEPLOYS_TO", detail: "The configuration deploys to production.", kind: "impact", primary: true },
    { id: "api-production", source: "asset:release-api", target: "asset:production-service", relation: "DEPLOYS_TO", detail: "The Release API can deploy a release to production.", kind: "impact", supporting: true },
    { id: "config-staging", source: "asset:deployment-config", target: "asset:staging-service", relation: "DEPLOYS_TO", detail: "The configuration also deploys to staging.", kind: "impact", supporting: true },
    { id: "production-customers", source: "asset:production-service", target: "asset:customer-dataset", relation: "PROCESSES", detail: "Production processes the restricted customer dataset.", kind: "impact", primary: true },
    { id: "staging-synthetic", source: "asset:staging-service", target: "asset:synthetic-dataset", relation: "PROCESSES", detail: "Staging uses synthetic, non-production data.", kind: "impact", supporting: true },
    { id: "customers-pii", source: "asset:customer-dataset", target: "data_category:pii", relation: "CONTAINS", detail: "Customer data contains personally identifiable information.", kind: "impact", primary: true },
    { id: "synthetic-test", source: "asset:synthetic-dataset", target: "data_category:synthetic", relation: "CONTAINS", detail: "The staging dataset contains test data only.", kind: "impact", supporting: true },
  ];

  nodes.push(
    { id: "human:marcus", kind: "human", tone: "owner", label: "Marcus", detail: "Owner of the Data Steward Agent.", classification: "Internal", risk: 0, x: 675, y: 78, peer: true },
    { id: `agent:${dataStewardId}`, kind: "agent", tone: "peer-agent", label: "Data Steward", detail: "A peer Agent that may read the same customer dataset. It provides relationship context without changing this Agent’s authority.", classification: "Internal", risk: 0, x: 805, y: 84, peer: true },
  );
  edges.push(
    { id: "peer-owns", source: "human:marcus", target: `agent:${dataStewardId}`, relation: "OWNS", detail: "Marcus owns the Data Steward Agent.", kind: "ownership", peer: true },
    { id: "peer-can-read", source: `agent:${dataStewardId}`, target: "asset:customer-dataset", relation: "CAN_READ", detail: "The Data Steward has a separate, direct read permission to customer data.", kind: "context", peer: true },
  );
  return {
    nodes,
    edges,
    score: 21,
    decision: "REVIEW_REQUIRED",
    evidence: "1. Permission to change config   2. Production impact   3. Restricted customer PII",
  };
}

function dataStewardGraph(agent: Agent): VisualGraph {
  const agentNodeId = `agent:${agent.id}`;
  const nodes: VisualNode[] = [
    { id: "human:marcus", kind: "human", tone: "owner", label: "Marcus", detail: "Demo owner, accountable for the Data Steward.", classification: "Internal", risk: 0, x: 135, y: 155 },
    { id: agentNodeId, kind: "agent", tone: "primary-agent", label: agent.name, detail: "The selected platform Agent. It has a direct, read-only permission to the customer dataset.", classification: "Internal", risk: 0, x: 315, y: 300 },
    { id: "asset:customer-dataset", kind: "asset", tone: "primary-asset", label: "Customer dataset", detail: "Restricted customer data this Agent is authorized to read.", classification: "Restricted", risk: 10, x: 620, y: 300 },
    { id: "data_category:pii", kind: "data", tone: "sensitive-data", label: "PII", detail: "Personal data classification. It explains sensitivity but is not counted a second time.", classification: "Restricted", risk: 0, x: 915, y: 185 },
    { id: "human:alice", kind: "human", tone: "owner", label: "Alice", detail: "Owner of the peer Release Guardian Agent.", classification: "Internal", risk: 0, x: 115, y: 485, peer: true },
    { id: `agent:${releaseGuardianId}`, kind: "agent", tone: "peer-agent", label: "Release Guardian", detail: "A peer Agent that reaches the same customer data through a deployment-impact path.", classification: "Internal", risk: 0, x: 295, y: 485, peer: true },
    { id: "asset:deployment-config", kind: "asset", tone: "context-asset", label: "Deployment config", detail: "Configuration the peer Release Guardian may write.", classification: "Internal", risk: 4, x: 475, y: 485, peer: true },
    { id: "asset:production-service", kind: "asset", tone: "context-asset", label: "Production service", detail: "The peer’s configuration can affect this production service.", classification: "Confidential", risk: 7, x: 640, y: 470, peer: true },
  ];
  const edges: VisualEdge[] = [
    { id: "marcus-owns", source: "human:marcus", target: agentNodeId, relation: "OWNS", detail: "Ownership records Marcus’s accountability. It does not grant authority.", kind: "ownership" },
    { id: "steward-can-read", source: agentNodeId, target: "asset:customer-dataset", relation: "CAN_READ", detail: "Exact, direct permission to read the customer dataset.", kind: "permission", primary: true },
    { id: "customers-pii", source: "asset:customer-dataset", target: "data_category:pii", relation: "CONTAINS", detail: "Customer data contains personally identifiable information.", kind: "impact", primary: true },
    { id: "alice-owns-release", source: "human:alice", target: `agent:${releaseGuardianId}`, relation: "OWNS", detail: "Alice owns the Release Guardian Agent.", kind: "ownership", peer: true },
    { id: "release-can-write", source: `agent:${releaseGuardianId}`, target: "asset:deployment-config", relation: "CAN_WRITE", detail: "The peer has a separate direct permission to change deployment configuration.", kind: "context", peer: true },
    { id: "config-production", source: "asset:deployment-config", target: "asset:production-service", relation: "DEPLOYS_TO", detail: "That configuration deploys to the production service.", kind: "context", peer: true },
    { id: "production-customers", source: "asset:production-service", target: "asset:customer-dataset", relation: "PROCESSES", detail: "Production processes the same restricted customer dataset.", kind: "context", peer: true },
  ];
  return {
    nodes,
    edges,
    score: 10,
    decision: "ALLOW",
    evidence: "1. Direct read permission   2. Restricted customer data   3. No downstream change path",
  };
}

function emptyGraph(agent: Agent): VisualGraph {
  return {
    nodes: [{ id: `agent:${agent.id}`, kind: "agent", tone: "primary-agent", label: agent.name, detail: "This Agent has a graph identity but no configured relationships yet.", classification: "Internal", risk: 0, x: mapWidth / 2, y: mapHeight / 2 }],
    edges: [],
    score: 0,
    decision: "ALLOW",
    isEmpty: true,
    evidence: "No direct permissions, connected assets, or protected-data impact have been configured.",
  };
}

function graphFor(agent: Agent): VisualGraph {
  if (agent.id === releaseGuardianId) return releaseGraph(agent);
  if (agent.id === dataStewardId) return dataStewardGraph(agent);
  return emptyGraph(agent);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function KnowledgeGraphPanel({ agent }: { agent: Agent }) {
  const graph = useMemo(() => graphFor(agent), [agent]);
  const [selectedNodeId, setSelectedNodeId] = useState(`agent:${agent.id}`);
  const [pathHighlighted, setPathHighlighted] = useState(true);
  const [showSupporting, setShowSupporting] = useState(false);
  const [showPeer, setShowPeer] = useState(false);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<HoverDetail | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const visibleNodes = graph.nodes.filter(
    (node) => (showPeer || !node.peer) && (showSupporting || !node.supporting),
  );
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = graph.edges.filter(
    (edge) =>
      (showPeer || !edge.peer) &&
      (showSupporting || !edge.supporting) &&
      visibleIds.has(edge.source) &&
      visibleIds.has(edge.target),
  );
  const nodesById = new Map(visibleNodes.map((node) => [node.id, node]));
  const selectedNode = nodesById.get(selectedNodeId) ?? visibleNodes[0]!;
  const hasPeerContext = graph.nodes.some((node) => node.peer);
  const hasSupportingContext = graph.nodes.some((node) => node.supporting);

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

  return (
    <section className="graph-panel" aria-labelledby="impact-map-title">
      <header className="graph-panel-header">
        <div><span className="eyebrow">Knowledge Graph</span><h2 id="impact-map-title">{graph.isEmpty ? "Relationship field" : "Impact field"}</h2><p>{graph.isEmpty ? "This Agent has an identity, but no relationship facts have been configured yet." : "Start with the bold route, it explains this Agent’s reachable impact."}</p></div>
        <div className="graph-decision" aria-label={`Blast Radius ${graph.score} out of 20, ${graph.decision === "REVIEW_REQUIRED" ? "review required" : "allowed"}`}><span>Blast Radius</span><strong>{graph.score} / 20</strong><b>{graph.decision === "REVIEW_REQUIRED" ? "Review required" : "Allowed"}</b></div>
      </header>

      <div className="graph-toolbar">
        <div className="graph-legend" aria-label="Graph legend"><span><i className="legend-node legend-agent" /> Selected Agent</span>{!graph.isEmpty && <><span><i className="legend-node legend-asset" /> Protected asset</span><span><i className="legend-line legend-permission" /> Direct permission</span><span><i className="legend-line legend-impact" /> Impact path</span></>}</div>
        <div className="graph-actions">
          <span className="graph-hint">Drag to pan · Scroll to zoom</span>
          {hasSupportingContext && <button className={"peer-toggle " + (showSupporting ? "active" : "")} onClick={() => setShowSupporting((value) => !value)} aria-pressed={showSupporting}>Supporting paths</button>}
          {hasPeerContext && <button className={"peer-toggle " + (showPeer ? "active" : "")} onClick={() => setShowPeer((value) => !value)} aria-pressed={showPeer}>Peer Agent</button>}
          <button className="map-control" onClick={() => setViewport((current) => ({ ...current, scale: clamp(current.scale - 0.15, 0.65, 1.8) }))} aria-label="Zoom out">−</button>
          <button className="map-control" onClick={() => setViewport({ x: 0, y: 0, scale: 1 })} aria-label="Reset map view">↺</button>
          <button className="map-control" onClick={() => setViewport((current) => ({ ...current, scale: clamp(current.scale + 0.15, 0.65, 1.8) }))} aria-label="Zoom in">+</button>
          {!graph.isEmpty && <button className={"path-toggle " + (pathHighlighted ? "active" : "")} onClick={() => setPathHighlighted((value) => !value)} aria-pressed={pathHighlighted}>{pathHighlighted ? "Focus path on" : "Focus path"}</button>}
        </div>
      </div>

      <div className="graph-body">
        <div className="graph-canvas-wrap" ref={canvasRef} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={finishPan} onPointerCancel={finishPan} onWheel={zoomWithWheel}>
          {hover && <div className="graph-hover-tooltip" style={{ left: hover.left, top: hover.top }} role="status"><strong>{hover.title}</strong><span>{hover.detail}</span></div>}
          <svg className={"knowledge-graph " + (pathHighlighted ? "path-active" : "")} viewBox={`0 0 ${mapWidth} ${mapHeight}`} role="img" aria-label="Interactive Knowledge Graph. Drag to pan and scroll to zoom.">
            <defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="graph-arrowhead" /></marker></defs>
            <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
              {!graph.isEmpty && <g className="graph-region-labels"><text x="68" y="42">ACCOUNTABILITY</text><text x="290" y="244">{agent.id === dataStewardId ? "DATA ACCESS" : "CONTROL"}</text><text x="728" y="174">{agent.id === dataStewardId ? "RESTRICTED DATA" : "PRODUCTION DATA"}</text>{showSupporting && <text x="720" y="435">SAFE STAGING</text>}</g>}
              {visibleEdges.map((edge) => {
                const source = nodesById.get(edge.source)!;
                const target = nodesById.get(edge.target)!;
                const angle = Math.atan2(target.y - source.y, target.x - source.x);
                const x1 = source.x + Math.cos(angle) * radius[source.tone];
                const y1 = source.y + Math.sin(angle) * radius[source.tone];
                const x2 = target.x - Math.cos(angle) * (radius[target.tone] + 6);
                const y2 = target.y - Math.sin(angle) * (radius[target.tone] + 6);
                return <g key={edge.id} className={`graph-edge graph-edge-${edge.kind} ${edge.primary ? "graph-edge-primary" : ""} graph-interactive`} onPointerEnter={(event) => placeHover(event, edge.relation, edge.detail)} onPointerLeave={() => setHover(null)}><line className="graph-edge-hit" x1={x1} y1={y1} x2={x2} y2={y2} /><line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd="url(#graph-arrow)" />{edge.primary && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor="middle">{edge.relation}</text>}</g>;
              })}
              {visibleNodes.map((node) => {
                const active = selectedNodeId === node.id;
                return <g key={node.id} className={`graph-node graph-node-${node.tone} graph-interactive ${active ? "selected" : ""}`} role="button" tabIndex={0} aria-label={`Select ${node.label}`} aria-pressed={active} onClick={() => setSelectedNodeId(node.id)} onPointerEnter={(event) => placeHover(event, node.label, node.detail)} onPointerLeave={() => setHover(null)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedNodeId(node.id); } }}><title>{node.label}</title><circle cx={node.x} cy={node.y} r={radius[node.tone]} /><text className="graph-node-label" x={node.x} y={node.y + radius[node.tone] + 20} textAnchor="middle">{node.label}</text></g>;
              })}
              {graph.isEmpty && <text className="graph-empty-message" x={mapWidth / 2} y={mapHeight / 2 + 105} textAnchor="middle">No relationships configured</text>}
            </g>
          </svg>
        </div>

        <aside className="graph-inspector" aria-live="polite">
          <span className="eyebrow">Selected relation</span>
          <div className="inspector-title"><span className={`inspector-dot inspector-${selectedNode.tone}`} /><div><h3>{selectedNode.label}</h3><span>{selectedNode.kind === "data" ? "Data category" : selectedNode.kind}</span></div></div>
          <p>{selectedNode.detail}</p>
          <dl><div><dt>Classification</dt><dd>{selectedNode.classification}</dd></div><div><dt>Risk contribution</dt><dd>{selectedNode.risk ? `${selectedNode.risk} points` : "Context only"}</dd></div></dl>
          <div className="inspector-note"><strong>Reading the field</strong>{selectedNode.risk > 0 ? " This node contributes once to the Blast Radius." : " This node supplies relationship context without increasing the score."}</div>
        </aside>
      </div>

      <footer className="graph-evidence"><span>{graph.decision === "REVIEW_REQUIRED" ? "Why review?" : "Current evidence"}</span><p>{graph.evidence}</p></footer>
    </section>
  );
}
