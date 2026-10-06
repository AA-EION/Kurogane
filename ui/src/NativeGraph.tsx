import { useEffect, useMemo, useRef, useState } from 'react';
import type { Topology } from './api/types';
import { IsoCanvas } from './canvas/IsoCanvas';
import { layoutTopology } from './canvas/layout';
import { mapToSvg, svgToPng } from './canvas/mapExport';
import { toFossflowModel } from './canvas/fossflowExport';
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
    kuroganeGraph?: { update(state: GraphState): void; export(format: string, id: string): Promise<void> };
    webkit?: { messageHandlers?: { kuroganeGraph?: { postMessage(message: unknown): void } } };
  }
}
const post = (message: unknown) => window.webkit?.messageHandlers?.kuroganeGraph?.postMessage(message);

/** Only the topology renderer is web content. All commands and other UI are native. */
export function NativeGraph() {
  const [state, setState] = useState<GraphState | null>(null);
  const current = useRef(state);
  current.current = state;
  const scene = useMemo(() => state?.topology ? layoutTopology(state.topology) : null, [state?.topology]);
  const focus = useMemo(() => {
    const id = scene?.refToNode.get(state?.selected?.id ?? '');
    return id ? { id, nonce: Date.now() } : null;
  }, [scene, state?.selected?.id]);
  useEffect(() => {
    window.kuroganeGraph = {
      update(next) {
        setAppearance(next.appearance);
        setState((previous) => ({ ...next, topology: JSON.stringify(previous?.topology) === JSON.stringify(next.topology) ? previous?.topology ?? null : next.topology }));
      },
      async export(format, id) {
        try {
          const topology = current.current?.topology;
          if (!topology) throw new Error('Unlock the vault and open its map first.');
          const graph = layoutTopology(topology);
          let blob: Blob;
          if (format === 'json') blob = new Blob([JSON.stringify(toFossflowModel(topology, graph), null, 2)], { type: 'application/json' });
          else {
            const { svg, width, height } = mapToSvg(graph);
            blob = format === 'png' ? await svgToPng(svg, width, height) : new Blob([svg], { type: 'image/svg+xml' });
          }
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
  if (!scene || !state?.topology) return <main className="native-graph-stage"><span className="native-graph-empty">Unlock your vault to view its topology.</span></main>;
  const topology = state.topology;
  return <main className="native-graph-stage" aria-label="Infrastructure topology">
    <IsoCanvas scene={scene} selected={scene.refToNode.get(state.selected?.id ?? '') ?? null} focus={focus} inspectorInset={0} dimmedTenants={new Set()} onSelect={(nodeID) => {
      const zone = scene.zones.find((value) => value.id === nodeID);
      const node = scene.nodes.find((value) => value.id === nodeID);
      const id = zone?.refId ?? node?.refId;
      const kind = zone ? 'tenant' : topology.hosts.some((row) => row.id === id) ? 'host' : topology.services.some((row) => row.id === id) ? 'service' : topology.proxies.some((row) => row.id === id) ? 'proxy' : null;
      post({ type: 'select', item: id && kind ? { kind, id } : null });
    }} />
  </main>;
}
