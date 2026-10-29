import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { GLYPHS } from './glyphs';

function Btn({ icon, title, onClick, pressed }: { icon: string; title: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={pressed} onClick={onClick} className={pressed ? 'on' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden><path d={GLYPHS[icon]} /></svg>
    </button>
  );
}

/** Zoom, fit, minimap toggle and legend, in the app's own control style. */
export function GraphControls({ onFit, duration, minimap, onToggleMinimap }: { onFit: () => void; duration: () => number; minimap: boolean; onToggleMinimap: () => void }) {
  const { zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <Panel position="bottom-left" className="g-panel">
      <div className="g-legend" aria-label="Legend">
        <span><i className="sw tone-secure" />HTTPS route</span>
        <span><i className="sw tone-plain" />Plain-HTTP route</span>
        <span><i className="sw tone-ingress dashed" />Tunnel / ingress</span>
        <span><i className="sw tone-parent dashed" />VM → hypervisor</span>
      </div>
      <div className="g-controls" role="toolbar" aria-label="Map controls">
        <Btn icon="plus" title="Zoom in" onClick={() => zoomIn({ duration: duration() })} />
        <Btn icon="minus" title="Zoom out" onClick={() => zoomOut({ duration: duration() })} />
        <Btn icon="fit" title="Fit to view" onClick={onFit} />
        <span className="g-zoom-readout" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <Btn icon="map" title={minimap ? 'Hide minimap' : 'Show minimap'} pressed={minimap} onClick={onToggleMinimap} />
      </div>
    </Panel>
  );
}
