import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and no host-network exposure.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: ['es2022', 'safari15'],
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: { environment: 'node' },
} as never);
