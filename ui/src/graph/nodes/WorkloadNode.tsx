import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';
import type { FlowNode } from '../TopologyView';
import { isAlert } from '../describe';
import { Badges, Glyph, Handles, useLod } from './parts';

/** A service or reverse proxy: a compact chip with its glyph, accent and badges. */
export const WorkloadNode = memo(function WorkloadNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const lod = useLod();
  const alert = n.badges.find((b) => b.tone === 'danger') ?? n.badges.find(isAlert);
  return (
    <div
      className={`g-chip kind-${n.kind} lod-${lod} ${n.ownerColor ? 'is-owned' : ''} ${n.context ? 'is-context' : ''} ${selected ? 'is-selected' : ''}`}
      data-node={n.id}
      style={{ ['--accent' as string]: n.accent, ['--oc' as string]: n.ownerColor }}
    >
      <Handles />
      <span className="g-chip-icon"><Glyph name={n.glyph} size={lod === 'overview' ? 26 : 18} /></span>
      {lod === 'overview' ? (
        alert && <span className={`g-alert-dot tone-${alert.tone}`} title={alert.label} />
      ) : (
        <div className="g-chip-body">
          <div className="g-chip-name" title={n.label}>{n.label}</div>
          {lod === 'detail' && n.sublabel && <div className="g-sub mono">{n.sublabel}</div>}
          <Badges badges={n.badges} lod={lod} ownerColor={n.ownerColor} />
        </div>
      )}
    </div>
  );
});
