import { memo, useCallback, useContext } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, type ReactFlowState, getSmoothStepPath, useStore } from '@xyflow/react';
import type { FlowEdge } from '../TopologyView';
import { CaptureContext, InsetContext, lodScale } from '../nodes/parts';
import { EDGE_RADIUS, LABEL_H, labelWidth } from '../layout';

const MARGIN = 12;

/**
 * Keeps a label pill inside the visible map (left of the inspector), sliding
 * it along the screen edge when its spot on the path is out of view.
 */
function useVisibleLabel(at: { x: number; y: number }, text: string): { x: number; y: number } {
  const inset = useContext(InsetContext);
  const capturing = useContext(CaptureContext);
  const selector = useCallback(
    (s: ReactFlowState) => {
      if (capturing) return `${at.x},${at.y}`;
      const [tx, ty, z] = s.transform;
      const scale = lodScale(z) * z;
      const hw = (labelWidth(text) * scale) / 2;
      const hh = (LABEL_H * scale) / 2;
      const clamp = (v: number, lo: number, hi: number) => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
      const sx = clamp(at.x * z + tx, MARGIN + hw, s.width - inset.right - MARGIN - hw);
      const sy = clamp(at.y * z + ty, inset.top + MARGIN + hh, s.height - MARGIN - hh);
      return `${(sx - tx) / z},${(sy - ty) / z}`;
    },
    [at.x, at.y, text, inset.right, inset.top, capturing],
  );
  const [x, y] = useStore(selector).split(',').map(Number);
  return { x, y };
}

function EdgeLabel({ at, text, tone }: { at: { x: number; y: number }; text: string; tone: string }) {
  const p = useVisibleLabel(at, text);
  return (
    <EdgeLabelRenderer>
      <div className={`g-edge-label tone-${tone}`} style={{ transform: `translate(${p.x}px, ${p.y}px) scale(var(--lod-scale)) translate(-50%, -50%)` }}>
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

/** Every connection: smoothstep path, semantic stroke, and a label pill while lit. */
export const TopologyEdge = memo(function TopologyEdge(props: EdgeProps<FlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: EDGE_RADIUS });
  if (!data) return null;
  const { edge, lit, labelAt } = data;
  const tone = edge.kind !== 'route' ? edge.kind : edge.secure ? 'secure' : 'plain';
  return (
    <>
      <BaseEdge id={id} path={path} className={`g-edge tone-${tone} ${edge.tunnel || edge.kind !== 'route' ? 'is-dashed' : ''}`} interactionWidth={0} />
      {lit && <path d={path} className={`g-edge-flow tone-${tone}`} fill="none" />}
      {lit && labelAt && edge.label && <EdgeLabel at={labelAt} text={edge.label} tone={tone} />}
    </>
  );
});
