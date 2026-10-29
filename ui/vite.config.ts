import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Tauri freezes Object.prototype (`freezePrototype`). d3-color, used by React
 * Flow's zoom, builds prototypes by assignment (`prototype.constructor = …`,
 * `prototype.toString = …`), which throws when the inherited property is
 * frozen. Defining the properties instead keeps the hardening on and the
 * behaviour identical.
 */
function d3ColorFrozenPrototype(): Plugin {
  const define = 'Object.defineProperty(prototype, "constructor", { value: constructor, writable: true, configurable: true });';
  const extend = 'for (var key in definition) Object.defineProperty(prototype, key, { value: definition[key], writable: true, configurable: true, enumerable: true });';
  return {
    name: 'd3-color-frozen-prototype',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]d3-color[\\/]src[\\/]define\.js$/.test(id.split('?')[0])) return null;
      const out = code
        .replace('prototype.constructor = constructor;', define)
        .replace('for (var key in definition) prototype[key] = definition[key];', extend);
      if (!out.includes(define) || !out.includes(extend)) throw new Error('d3-color define.js changed; review the frozen-prototype patch');
      return { code: out, map: null };
    },
  };
}

// Tauri expects a fixed dev port and no host-network exposure.
export default defineConfig({
  plugins: [d3ColorFrozenPrototype(), react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Pre-bundled dependencies skip plugin transforms; let Vite serve d3-color as source in development.
  optimizeDeps: { exclude: ['d3-color'] },
  build: {
    target: ['es2022', 'safari15'],
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: { environment: 'node', exclude: ['e2e/**', 'node_modules/**'] },
} as never);
