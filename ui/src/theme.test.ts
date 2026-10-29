import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const rgb = (hex: string) => hex.replace('#', '').match(/../g)!.map((value) => parseInt(value, 16));
const luminance = (values: number[]) => values.map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
const ratio = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe('Readable light and dark surfaces', () => {
  for (const theme of ['light', 'dark']) it(`${theme} text and graph labels meet 4.5:1`, () => {
    const block = css.match(new RegExp(`:root\\[data-theme='${theme}'\\] \\{([^}]+)\\}`))![1];
    const palette = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((value) => [value[1], rgb(value[2])]));
    for (const surface of ['bg', 'bg-2', 'panel', 'panel-2', 'surface-bottom']) {
      for (const text of ['text', 'text-2', 'text-3', 'ok', 'warn', 'danger', 'info']) {
        expect(ratio(palette[text], palette[surface]), `${theme}: ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    const slab = palette.steel.map((value) => Math.round(value + (255 - value) * 0.08));
    for (const label of ['slab-text', 'slab-muted']) expect(ratio(palette[label], slab), `${theme}: ${label} on machine slab`).toBeGreaterThanOrEqual(4.5);
    for (const surface of ['primary-top', 'primary-bottom']) expect(ratio(palette['primary-ink'], palette[surface]), `${theme}: primary button`).toBeGreaterThanOrEqual(4.5);
  });
});
