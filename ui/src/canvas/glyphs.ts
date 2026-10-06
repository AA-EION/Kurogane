// 24×24 monochrome pictograms (original artwork, stroke-based, no vendor logos).
// Shared by the canvas renderer, the drawer and the FossFLOW exporter.

export const GLYPHS: Record<string, string> = {
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9M12 3c-2.5 2.5-3.8 5.5-3.8 9s1.3 6.5 3.8 9',
  cloud: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.2A4.5 4.5 0 0 0 7 18z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h6M11 17h6',
  vps: 'M5 9h14v10H5zM8 9V6a4 4 0 0 1 8 0v3M9 14h6',
  vm: 'M3 5h18v11H3zM8 20h8M12 16v4M8 10l2 2-2 2M12 14h4',
  switch: 'M3 8h18v8H3zM6 12h.01M9 12h.01M12 12h.01M15 12h.01M18 12h.01',
  ap: 'M12 18a1 1 0 1 0 0 .01M8.5 14.5a5 5 0 0 1 7 0M5.5 11.5a9 9 0 0 1 13 0M3 8.5a13 13 0 0 1 18 0',
  router: 'M3 13h18v6H3zM7 16h.01M11 16h.01M7 13l-2-7M17 13l2-7',
  firewall: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v5M15 10v5M9 15v4',
  nvr: 'M3 7h12v10H3zM15 10l6-3v10l-6-3M7 12h.01',
  nas: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h6M12 18h.01',
  edge: 'M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  workstation: 'M3 5h18v11H3zM8 20h8M12 16v4',
  container: 'M3 8l9-4l9 4v8l-9 4l-9-4zM3 8l9 4l9-4M12 12v8',
  proxy: 'M4 12h6M14 12h6M10 9l4 3-4 3M4 6h3M4 18h3M17 6h3M17 18h3',
  tunnel: 'M3 20V11a9 9 0 0 1 18 0v9M7 20v-8a5 5 0 0 1 10 0v8M12 9v2',
  share: 'M3 6h6l2 2h10v11H3zM8 14h8',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1',
  windows: 'M3 5l8-1v8H3zM13 4l8-1v9h-8zM3 13h8v7l-8-1zM13 13h8v8l-8-1z',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  key: 'M14 4a6 6 0 1 0 0 .01M10.5 13.5L3 21M6 18l2 2M8 16l2 2',
  terminal: 'M3 4h18v16H3zM7 9l3 3-3 3M12 15h5',
  desktop: 'M3 4h18v12H3zM8 20h8M12 16v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM21 21l-5-5',
  sync: 'M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4',
  close: 'M5 5l14 14M19 5L5 19',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  folder: 'M3 6h6l2 2h10v11H3z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  linux: 'M12 3c-2 0-3.2 1.8-3.2 4.2 0 1.4.4 2.3.4 3.1-.9 1.2-3.2 3.6-3.2 6.2 0 1.1.6 1.6 1.4 1.8M12 3c2 0 3.2 1.8 3.2 4.2 0 1.4-.4 2.3-.4 3.1.9 1.2 3.2 3.6 3.2 6.2 0 1.1-.6 1.6-1.4 1.8M8 20c1.2.7 2.5 1 4 1s2.8-.3 4-1M10.5 7h.01M13.5 7h.01',
  apple: 'M15.5 3c0 1.5-1.2 3-2.8 3 0-1.5 1.3-3 2.8-3zM12 7.5c1-.5 2-.8 3-.8 1.8 0 3 1 3.6 2.2-1.6 1-2.4 2.3-2.4 4 0 2 1.2 3.4 2.4 3.9-.6 1.6-2 4.2-3.6 4.2-1.2 0-1.6-.7-3-.7s-1.9.7-3 .7C7.2 21 5 17 5 13.5 5 10 7.2 7 9.6 7c.9 0 1.6.3 2.4.5z',
};

export function glyphSvg(name: string, color = '#e9ecef'): string {
  const d = GLYPHS[name] ?? GLYPHS.server;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
