import { createContext, memo, useContext } from 'react';
import { Handle, Position, useStore } from '@xyflow/react';
import { GLYPHS } from '../glyphs';
import { type Badge, isAlert } from '../describe';

/** Zoom bands: names only → names, sublabels and alerts → every badge. */
export type Lod = 'overview' | 'normal' | 'detail';

export const OVERVIEW_BELOW = 0.6;
export const DETAIL_FROM = 0.95;

export const lodFor = (zoom: number): Lod => (zoom < OVERVIEW_BELOW ? 'overview' : zoom < DETAIL_FROM ? 'normal' : 'detail');

/** How much overview labels grow as the camera pulls back. */
export const lodScale = (zoom: number) => Math.min(2.6, Math.max(1, 0.9 / zoom));

/** True while an image export is being captured: render every detail, no dimming. */
export const CaptureContext = createContext(false);

/** Screen space covered by the inspector (right) and the company picker (top), so edge labels stay in view. */
export const InsetContext = createContext({ right: 0, top: 0 });

/** Re-renders only when the zoom crosses a band boundary. */
export function useLod(): Lod {
  const band = useStore((s) => lodFor(s.transform[2]));
  return useContext(CaptureContext) ? 'detail' : band;
}

const SIDES = [
  ['t', Position.Top],
  ['r', Position.Right],
  ['b', Position.Bottom],
  ['l', Position.Left],
] as const;

/** A source and a target handle on every side; the layout picks which ones an edge uses. */
export const Handles = memo(function Handles() {
  return (
    <>
      {SIDES.map(([id, pos]) => (
        <span key={id}>
          <Handle type="source" id={`s-${id}`} position={pos} isConnectable={false} className="g-handle" />
          <Handle type="target" id={`t-${id}`} position={pos} isConnectable={false} className="g-handle" />
        </span>
      ))}
    </>
  );
});

export function Glyph({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={`g-glyph ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d={GLYPHS[name] ?? GLYPHS.server} />
    </svg>
  );
}

export function Badges({ badges, lod, ownerColor, className }: { badges: Badge[]; lod: Lod; ownerColor?: string; className?: string }) {
  const shown = lod === 'detail' ? [...badges].sort((a, b) => Number(isAlert(b)) - Number(isAlert(a))) : badges.filter(isAlert);
  if (!shown.length) return null;
  return (
    <div className={`g-badges ${className ?? ''}`}>
      {shown.map((b, i) => (
        <span key={i} className={`g-badge tone-${b.tone} kind-${b.kind}`}>
          {b.glyph === 'lock' && <Glyph name="lock" size={10} />}
          {b.kind === 'owner' && <i className="g-owner-dot" style={{ background: ownerColor }} />}
          {b.label}
        </span>
      ))}
    </div>
  );
}
