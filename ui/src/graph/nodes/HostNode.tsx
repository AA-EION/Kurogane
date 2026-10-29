import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNode } from '../TopologyView';
import { Badges, Glyph, Handles, useLod } from './parts';

/** A machine: a raised card holding its workloads, or a compact leaf for bare appliances. */
export const HostNode = memo(function HostNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const lod = useLod();
  return (
    <div
      className={`g-host ${n.appliance ? 'is-appliance' : ''} lod-${lod} ${selected ? 'is-selected' : ''}`}
      data-node={n.id}
      style={{ ['--tc' as string]: n.color }}
    >
      <Handles />
      <header className="g-host-head">
        <span className="g-icon"><Glyph name={n.glyph} size={n.appliance ? 16 : 18} /></span>
        <div className="g-titles">
          <div className="g-host-name">{n.label}</div>
          {lod !== 'overview' && n.sublabel && <div className="g-sub mono">{n.sublabel}</div>}
        </div>
        {lod !== 'overview' && <Badges badges={n.badges} lod={lod} className="g-host-badges" />}
      </header>
    </div>
  );
});
