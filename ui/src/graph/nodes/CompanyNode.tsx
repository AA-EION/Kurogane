import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNode } from '../TopologyView';
import { Handles, useLod } from './parts';

export const CompanyNode = memo(function CompanyNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const lod = useLod();
  return (
    <div className={`g-company lod-${lod} ${n.context ? 'is-context' : ''} ${selected ? 'is-selected' : ''}`} data-node={n.id} style={{ ['--tc' as string]: n.color }}>
      <Handles />
      <header className="g-company-head">
        <i className="g-company-mark" aria-hidden />
        <div className="g-titles">
          <div className="g-company-name" title={n.label}>{n.label}</div>
          {lod !== 'overview' && <div className="g-company-sub">{n.sublabel}</div>}
        </div>
      </header>
      {n.count === 0 && <div className="g-empty">No machines yet</div>}
    </div>
  );
});
