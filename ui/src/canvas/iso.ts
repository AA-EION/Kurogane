/**
 * Isometric projection.
 *
 * Adapted from Isoflow / FossFLOW (MIT © 2023 Mark Mankarious, FossFLOW
 * contributors): `config.ts` (UNPROJECTED_TILE_SIZE, TILE_PROJECTION_MULTIPLIERS)
 * and `utils/renderer.ts#getTilePosition`. Isoflow's tile y axis points *up*
 * the screen; SVG's points down, so the vertical term is negated here. A
 * z (elevation) axis is added so hosts, containers and the Internet can sit
 * on different layers.
 */

export interface Coords {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export const UNPROJECTED_TILE_SIZE = 100;
export const TILE_PROJECTION_MULTIPLIERS = { width: 1.415, height: 0.819 };
export const PROJECTED_TILE_SIZE = {
  width: UNPROJECTED_TILE_SIZE * TILE_PROJECTION_MULTIPLIERS.width,
  height: UNPROJECTED_TILE_SIZE * TILE_PROJECTION_MULTIPLIERS.height,
};
/** Screen pixels per elevation unit (z). */
export const ELEVATION_UNIT = PROJECTED_TILE_SIZE.height * 0.5;

const HW = PROJECTED_TILE_SIZE.width / 2;
const HH = PROJECTED_TILE_SIZE.height / 2;

/** Tile-space point (fractional allowed) at elevation z → screen point. */
export function tileToScreen(t: Coords, z = 0): Coords {
  return { x: HW * t.x - HW * t.y, y: HH * t.x + HH * t.y - z * ELEVATION_UNIT };
}

/** Inverse of {@link tileToScreen} on the ground plane (z = 0). */
export function screenToTile(p: Coords): Coords {
  return { x: (p.x / HW + p.y / HH) / 2, y: (p.y / HH - p.x / HW) / 2 };
}

/** Screen-space centre of a footprint whose top-left tile is `t`. */
export function footprintCenter(t: Coords, size: Size, z = 0): Coords {
  return tileToScreen({ x: t.x + size.w / 2, y: t.y + size.h / 2 }, z);
}

/** The four ground corners of a footprint, clockwise from the back corner. */
export function footprintCorners(t: Coords, size: Size, z = 0): [Coords, Coords, Coords, Coords] {
  return [
    tileToScreen({ x: t.x, y: t.y }, z),
    tileToScreen({ x: t.x + size.w, y: t.y }, z),
    tileToScreen({ x: t.x + size.w, y: t.y + size.h }, z),
    tileToScreen({ x: t.x, y: t.y + size.h }, z),
  ];
}

/**
 * SVG matrix that lays flat content (text, icons) onto the ground plane,
 * aligned with the tile x axis. Equivalent to Isoflow's `getIsoMatrix('X')`
 * with the y flip; one local unit = 1/100 tile.
 */
export function groundMatrix(origin: Coords): string {
  const a = HW / UNPROJECTED_TILE_SIZE;
  const b = HH / UNPROJECTED_TILE_SIZE;
  return `matrix(${a} ${b} ${-a} ${b} ${origin.x} ${origin.y})`;
}

/** Painter's-algorithm key: back-to-front by tile depth, then elevation. */
export function depthKey(t: Coords, size: Size, z = 0): number {
  return (t.x + size.w) + (t.y + size.h) + z * 0.01;
}

export function polygonPoints(pts: Coords[]): string {
  return pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}
