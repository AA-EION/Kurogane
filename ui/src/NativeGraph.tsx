import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Topology } from './api/types';
import { type NodeKind, buildGraph } from './graph/build';
import { exportGraphImage } from './graph/exportImage';
import { TopologyView } from './graph/TopologyView';
import { setAppearance, type Appearance } from './theme';

interface GraphState {
  topology: Topology | null;
  selected: { kind: string; id: string } | null;
  appearance: Appearance;
  fit: string;
}
declare global {
  interface Window {
    __KUROGANE_NATIVE_GRAPH__?: boolean;
    kuroganeGraph?: { update(state: GraphState): void; export(format: 'png' | 'svg', id: string): Promise<void> };
    webkit?: { messageHandlers?: { kuroganeGraph?: { postMessage(message: unknown): void } } };
  }
}
const post = (message: unknown) => window.webkit?.messageHandlers?.kuroganeGraph?.postMessage(message);

/** Record kinds the native inspector understands, by graph node kind. */
const RECORD_KIND: Partial<Record<NodeKind, string>> = { tenant: 'tenant', host: 'host', service: 'service', proxy: 'proxy' };

/** Only the topology renderer is web content. All commands and other UI are native. */
export function NativeGraph() {
  const [state, setState] = useState<GraphState | null>(null);
  const current = useRef(state);
  current.current = state;
  const graph = useMemo(() => (state?.topology ? buildGraph(state.topology) : null), [state?.topology]);
  const selectedNode = graph?.refToNode.get(state?.selected?.id ?? '') ?? null;
  const focus = useMemo(() => (selectedNode ? { id: selectedNode, nonce: Date.now() } : null), [selectedNode]);
  useEffect(() => {
    window.kuroganeGraph = {
      update(next) {
        setAppearance(next.appearance);
        setState((previous) => ({ ...next, topology: JSON.stringify(previous?.topology) === JSON.stringify(next.topology) ? previous?.topology ?? null : next.topology }));
      },
      async export(format, id) {
        try {
          if (format !== 'png' && format !== 'svg') throw new Error(`Unsupported map format: ${format}`);
          if (!current.current?.topology) throw new Error('Unlock the vault and open its map first.');
          const blob = await exportGraphImage(format);
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('Could not encode the map.'));
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.readAsDataURL(blob);
          });
          post({ type: 'file', id, format, dataBase64: base64 });
        } catch (error) { post({ type: 'error', id, message: String(error) }); }
      },
    };
    post({ type: 'ready' });
    return () => { delete window.kuroganeGraph; };
  }, []);
  useEffect(() => { if (state?.fit) window.dispatchEvent(new Event('kurogane:fit')); }, [state?.fit]);
  if (!graph) return <main className="native-graph-stage"><span className="native-graph-empty">Unlock your vault to view its topology.</span></main>;
  return <main className="native-graph-stage" aria-label="Infrastructure topology">
    <ReactFlowProvider>
      <TopologyView model={graph} selected={selectedNode} focus={focus} inspectorInset={0} onSelect={(nodeId) => {
        const node = nodeId ? graph.byId.get(nodeId) : undefined;
        const kind = node && RECORD_KIND[node.kind];
        post({ type: 'select', item: node && kind ? { kind, id: node.refId } : null });
      }} />
    </ReactFlowProvider>
  </main>;
}
