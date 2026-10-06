import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App';
import './styles.css';
import './theme';

// macOS installs an NSHostingView and talks directly to Rust. Its webview
// remains an empty lifecycle container; no React views or IPC listeners mount.
if (!(isTauri() && /Mac/.test(navigator.platform))) createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
