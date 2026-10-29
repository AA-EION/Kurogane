import { toPng, toSvg } from 'html-to-image';
import type { Rect } from './layout';

/**
 * Whole-graph PNG/SVG export (not just the viewport). The mounted
 * TopologyView registers itself as the capture target; during a capture it
 * renders every node at full detail with no selection or dimming.
 */
export interface CaptureTarget {
  bounds: Rect;
  viewport: () => HTMLElement | null;
  /** Switch to capture rendering; resolves once it has painted. */
  begin: () => Promise<void>;
  end: () => void;
}

let target: CaptureTarget | null = null;

export function registerCaptureTarget(t: CaptureTarget): () => void {
  target = t;
  return () => {
    if (target === t) target = null;
  };
}

const PAD = 48;
const MAX_SIDE = 16_000;

export async function exportGraphImage(format: 'png' | 'svg'): Promise<Blob> {
  const t = target;
  const el = t?.viewport();
  if (!t || !el) throw new Error('Open the map first');
  const { bounds } = t;
  const width = Math.ceil(bounds.w + PAD * 2);
  const height = Math.ceil(bounds.h + PAD * 2);
  const options = {
    width,
    height,
    backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || undefined,
    pixelRatio: Math.min(2, MAX_SIDE / width, MAX_SIDE / height),
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${PAD - bounds.x}px, ${PAD - bounds.y}px) scale(1)` },
  };
  await t.begin();
  try {
    const url = format === 'png' ? await toPng(el, options) : await toSvg(el, options);
    return await (await fetch(url)).blob();
  } finally {
    t.end();
  }
}
