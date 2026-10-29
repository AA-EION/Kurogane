import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BackgroundVariant, type Edge, type FitViewOptions, MiniMap, type Node, type NodeChange, Panel, ReactFlow, useReactFlow, useStoreApi,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './graph.css';
import { useAppearance } from '../theme';
import type { GraphEdge, GraphModel } from './build';
import { TopologyEdge } from './edges/TopologyEdge';
import { registerCaptureTarget } from './exportImage';
import { GraphControls } from './GraphControls';
import { GLYPHS } from './glyphs';
import { type FlowNodeData, layoutGraph, placeLabels } from './layout';
import { CompanyNode } from './nodes/CompanyNode';
import { HostNode } from './nodes/HostNode';
import { InternetNode } from './nodes/InternetNode';
import { CaptureContext, InsetContext, lodScale } from './nodes/parts';
import { WorkloadNode } from './nodes/WorkloadNode';
import { litEdges, litNodes } from './trace';

export type FlowNode = Node<FlowNodeData, 'internet' | 'company' | 'host' | 'workload'>;
export type FlowEdge = Edge<{ edge: GraphEdge; lit: boolean; labelAt?: { x: number; y: number } }, 'topo'>;

const nodeTypes = { internet: InternetNode, company: CompanyNode, host: HostNode, workload: WorkloadNode };
const edgeTypes = { topo: TopologyEdge };

const MINIMAP_KEY = 'kurogane.graph.minimap';
const LEGEND_KEY = 'kurogane.graph.legend';
const readPref = (key: string, fallback: boolean) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch { return fallback; }
};
const writePref = (key: string, on: boolean) => {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* preference lasts this session */ }
};
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const duration = (ms = 450) => (reducedMotion() ? 0 : ms);

interface Props {
  model: GraphModel;
  selected: string | null;
  onSelect: (id: string | null) => void;
  focus: { id: string; nonce: number } | null;
  /** Right-hand space covered by an overlaying inspector (380 on web, 0 on macOS). */
  inspectorInset?: number;
  /** Companies for the filter picker; omit to hide it. */
  companies?: { id: string; name: string }[];
  companyFilter?: string | null;
  onCompanyFilter?: (tenantId: string | null) => void;
}

/** Read-only topology diagram. The app's `selected` state is the only selection. */
export function TopologyView({ model, selected, onSelect, focus, inspectorInset = 380, companies, companyFilter = null, onCompanyFilter }: Props) {
  const appearance = useAppearance();
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const storeApi = useStoreApi();
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [minimap, setMinimap] = useState(() => readPref(MINIMAP_KEY, false));
  const [legend, setLegend] = useState(() => readPref(LEGEND_KEY, false));
  const captureDone = useRef<(() => void) | null>(null);

  const layout = useMemo(() => layoutGraph(model), [model]);

  // The inspector only covers the map while something is selected; the company picker sits above the graph.
  const inset = selected ? inspectorInset : 0;
  const picker = !!companies && !!onCompanyFilter && companies.length > 1;
  const padTop = picker ? 84 : 56;
  const labelInset = useMemo(() => ({ right: inset, top: picker ? 50 : 0 }), [inset, picker]);
  const fitOptions = useMemo<FitViewOptions<FlowNode>>(
    () => ({ padding: { top: `${padTop}px`, left: '56px', bottom: '56px', right: `${56 + inset}px` }, maxZoom: 1.1, minZoom: 0.1 }),
    [inset, padTop],
  );
  const fit = useCallback(() => rf.fitView({ ...fitOptions, duration: duration() }), [rf, fitOptions]);

  // Refit whenever the topology changes (not on resize: the viewport is kept).
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    rf.fitView(fitOptions);
  }, [layout]);

  useEffect(() => {
    window.addEventListener('kurogane:fit', fit);
    return () => window.removeEventListener('kurogane:fit', fit);
  }, [fit]);

  // A selection made on the map must not end up under the inspector or off screen.
  useEffect(() => {
    const r = selected ? layout.rects.get(selected) : undefined;
    if (!r || capturing) return;
    const { transform: [x, y, z], width, height } = storeApi.getState();
    const m = 24;
    const left = x + r.x * z;
    const top = y + r.y * z;
    const visibleW = width - inset;
    const mTop = m + padTop - 56;
    if (left >= m && top >= mTop && left + r.w * z <= visibleW - m && top + r.h * z <= height - m) return;
    if (r.w * z > visibleW - 2 * m || r.h * z > height - m - mTop) return;
    rf.setCenter(r.x + r.w / 2 + inset / 2 / z, r.y + r.h / 2, { zoom: z, duration: duration() });
  }, [selected]);

  // Focus: companies fit their group, leaves zoom in to at least 100%.
  useEffect(() => {
    if (!focus) return;
    const node = model.byId.get(focus.id);
    if (!node) return;
    const leaf = node.kind === 'service' || node.kind === 'proxy' || node.appliance;
    const pad = 72;
    rf.fitView({
      nodes: [{ id: focus.id }],
      padding: { top: `${pad + padTop - 56}px`, left: `${pad}px`, bottom: `${pad}px`, right: `${pad + inspectorInset}px` },
      duration: duration(),
      minZoom: leaf ? 1 : 0.1,
      maxZoom: leaf ? 1 : node.kind === 'tenant' ? 1 : 1.2,
    });
  }, [focus]);

  // Image export: render everything at full detail with no dimming while captured.
  useEffect(
    () =>
      registerCaptureTarget({
        bounds: layout.bounds,
        viewport: () => wrap.current?.querySelector<HTMLElement>('.react-flow__viewport') ?? null,
        begin: () => new Promise<void>((resolve) => { captureDone.current = resolve; setCapturing(true); }),
        end: () => setCapturing(false),
      }),
    [layout],
  );
  useEffect(() => {
    if (!capturing || !captureDone.current) return;
    const done = captureDone.current;
    captureDone.current = null;
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  }, [capturing]);

  // Level of detail: overview labels grow as the camera pulls back, without re-rendering nodes.
  useEffect(() => {
    const apply = (zoom: number) => wrap.current?.style.setProperty('--lod-scale', capturing ? '1' : String(lodScale(zoom)));
    apply(storeApi.getState().transform[2]);
    return storeApi.subscribe((s) => apply(s.transform[2]));
  }, [storeApi, capturing]);

  // Tracing.
  const sel = capturing ? null : selected;
  const hov = capturing ? null : hover;
  const lit = useMemo(() => {
    const fromSelection = litEdges(model, sel);
    const fromHover = litEdges(model, hov);
    const edges = new Set([...fromSelection, ...fromHover]);
    const nodes = litNodes(model, sel, edges);
    for (const id of litNodes(model, hov, edges)) nodes.add(id);
    // Labels only for a single workload or appliance: a whole company or machine would bury the map in pills.
    const leaf = (id: string | null) => {
      const n = id ? model.byId.get(id) : undefined;
      return !!n && (n.kind === 'service' || n.kind === 'proxy' || !!n.appliance);
    };
    const labelled = new Set([...(leaf(sel) ? fromSelection : []), ...(leaf(hov) ? fromHover : [])]);
    return { edges, nodes, labelled, active: !!(sel && model.byId.has(sel)) || !!(hov && model.byId.has(hov)) };
  }, [model, sel, hov]);
  const labels = useMemo(() => placeLabels(layout, model, lit.labelled), [layout, model, lit.labelled]);

  // Keep object identity for unchanged nodes and edges so React Flow re-renders only what changed.
  const nodeCache = useRef(new Map<string, FlowNode>());
  const nodes = useMemo(() => {
    const next = new Map<string, FlowNode>();
    const out = layout.nodes.map((p) => {
      const className = lit.active && !lit.nodes.has(p.id) ? 'is-dim' : '';
      const isSelected = p.id === sel;
      const prev = nodeCache.current.get(p.id);
      const n: FlowNode =
        prev && prev.data === p.data && prev.className === className && !!prev.selected === isSelected
          ? prev
          : {
              ...p,
              className,
              selected: isSelected,
              draggable: false,
              connectable: false,
              ariaLabel: p.data.node.ariaLabel,
            };
      next.set(p.id, n);
      return n;
    });
    nodeCache.current = next;
    return out;
  }, [layout, lit, sel]);

  const edgeCache = useRef(new Map<string, FlowEdge>());
  const edges = useMemo(() => {
    const next = new Map<string, FlowEdge>();
    const out = layout.edges.map(({ edge, sourceHandle, targetHandle }) => {
      const isLit = lit.edges.has(edge.id);
      const labelAt = isLit ? labels.get(edge.id) : undefined;
      const className = `kind-${edge.kind} ${isLit ? 'is-lit' : lit.active ? 'is-dim' : ''}`;
      const prev = edgeCache.current.get(edge.id);
      const e: FlowEdge =
        prev && prev.data?.edge === edge && prev.className === className && prev.data.labelAt?.x === labelAt?.x && prev.data.labelAt?.y === labelAt?.y
          ? prev
          : { id: edge.id, type: 'topo', source: edge.source, target: edge.target, sourceHandle, targetHandle, className, focusable: false, selectable: false, zIndex: isLit ? 1 : 0, data: { edge, lit: isLit, labelAt } };
      next.set(edge.id, e);
      return e;
    });
    edgeCache.current = next;
    return out;
  }, [layout, lit, labels]);

  // React Flow keeps no selection of its own: clicks and keyboard (Enter/Space) select through the app.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const picked = changes.find((c) => c.type === 'select' && c.selected);
      if (picked && picked.type === 'select') onSelect(picked.id);
    },
    [onSelect],
  );

  const toggleMinimap = useCallback(() => setMinimap((on) => (writePref(MINIMAP_KEY, !on), !on)), []);
  const toggleLegend = useCallback(() => setLegend((on) => (writePref(LEGEND_KEY, !on), !on)), []);
  const filtered = companies?.find((c) => c.id === companyFilter);

  return (
    <CaptureContext.Provider value={capturing}>
      <InsetContext.Provider value={labelInset}>
        <div ref={wrap} className={`graph-wrap ${capturing ? 'is-capturing' : ''}`}>
          <ReactFlow<FlowNode, FlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={appearance}
            onNodesChange={onNodesChange}
            onNodeClick={(_, n) => onSelect(n.id)}
            onPaneClick={() => onSelect(null)}
            onNodeMouseEnter={(_, n) => n.type !== 'company' && setHover(n.id)}
            onNodeMouseLeave={() => setHover(null)}
            fitView
            fitViewOptions={fitOptions}
            minZoom={0.1}
            maxZoom={2.5}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable
            edgesFocusable={false}
            elementsSelectable
            selectNodesOnDrag={false}
            elevateNodesOnSelect={false}
            elevateEdgesOnSelect={false}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            zoomOnDoubleClick={false}
            onlyRenderVisibleElements={!capturing && layout.nodes.length > 300}
            proOptions={{ hideAttribution: false }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="var(--graph-dot)" />
            <GraphControls onFit={fit} duration={() => duration(220)} minimap={minimap} onToggleMinimap={toggleMinimap} legend={legend} onToggleLegend={toggleLegend} />
            {picker && onCompanyFilter && (
              <Panel position="top-left" className="g-filter" style={{ maxWidth: `calc(100% - ${32 + inset}px)` }}>
                <label className={`g-filter-pick ${filtered ? 'on' : ''}`}>
                  <svg viewBox="0 0 24 24" aria-hidden><path d={GLYPHS.filter} /></svg>
                  <span className="visually-hidden">Show company</span>
                  <select value={companyFilter ?? ''} onChange={(e) => onCompanyFilter(e.target.value || null)} aria-label="Show company">
                    <option value="">All companies</option>
                    {[...companies].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                {filtered && (
                  <>
                    <span className="g-filter-note">Other companies appear only where {filtered.name}’s services run or are published.</span>
                    <button type="button" className="g-filter-clear" onClick={() => onCompanyFilter(null)}>Show all</button>
                  </>
                )}
              </Panel>
            )}
            {minimap && (
              <MiniMap<FlowNode>
                pannable
                zoomable
                position="bottom-right"
                style={{ marginRight: 16 + inset }}
                ariaLabel="Minimap"
                nodeColor={(n) => n.data.node.color ?? 'var(--text-3)'}
                nodeClassName={(n) => `mm-${n.type}`}
                nodeBorderRadius={4}
              />
            )}
          </ReactFlow>
        </div>
      </InsetContext.Provider>
    </CaptureContext.Provider>
  );
}
