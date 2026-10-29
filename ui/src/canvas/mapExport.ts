import { type Scene } from './layout';
import { sceneScreenBounds } from './IsoCanvas';

/**
 * Serialise the whole map (not just the visible viewport) as a standalone
 * SVG with the app stylesheet inlined, so it renders identically elsewhere.
 */
export function mapToSvg(scene: Scene): { svg: string; width: number; height: number } {
  const live = document.querySelector<SVGSVGElement>('svg.iso-canvas');
  if (!live) throw new Error('Open the map first');
  const clone = live.cloneNode(true) as SVGSVGElement;
  const b = sceneScreenBounds(scene);
  const pad = 60;
  const width = Math.ceil(b.x1 - b.x0 + pad * 2);
  const height = Math.ceil(b.y1 - b.y0 + pad * 2 + 120);
  const root = clone.querySelector(':scope > g');
  root?.setAttribute('transform', `translate(${pad - b.x0} ${pad + 120 - b.y0})`);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.removeAttribute('style');
  clone.dataset.theme = document.documentElement.dataset.theme ?? 'light';
  // Export resolved custom properties so SVG renderers and PNG conversion do
  // not depend on the host document's theme or browser color-mix support.
  const computed = getComputedStyle(document.documentElement);
  for (let i = 0; i < computed.length; i++) {
    const name = computed.item(i);
    if (name.startsWith('--')) clone.style.setProperty(name, computed.getPropertyValue(name));
  }
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
    } catch {
      /* cross-origin sheet */
    }
  }
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', computed.getPropertyValue('--bg').trim());
  clone.insertBefore(bg, style.nextSibling);
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`, width, height };
}

export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render the map image'));
      img.src = url;
    });
    const max = 16000;
    const s = Math.min(scale, max / width, max / height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * s);
    canvas.height = Math.round(height * s);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(s, s);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
