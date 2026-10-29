import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import type { FlowEdge } from '../TopologyView';
import { EDGE_RADIUS } from '../layout';

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
      {lit && labelAt && edge.label && (
        <EdgeLabelRenderer>
          <div className={`g-edge-label tone-${tone}`} style={{ transform: `translate(${labelAt.x}px, ${labelAt.y}px) scale(var(--lod-scale)) translate(-50%, -50%)` }}>
            {edge.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
