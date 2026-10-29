import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNode } from '../TopologyView';
import { Glyph, Handles } from './parts';

export const InternetNode = memo(function InternetNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  return (
    <div className={`g-internet ${selected ? 'is-selected' : ''}`} data-node={n.id}>
      <Handles />
      <span className="g-internet-icon"><Glyph name="globe" size={24} /></span>
      <div className="g-titles">
        <div className="g-internet-name">{n.label}</div>
        <div className="g-sub">{n.sublabel}</div>
      </div>
    </div>
  );
});
