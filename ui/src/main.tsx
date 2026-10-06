import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App';
import { NativeGraph } from './NativeGraph';
import './styles.css';
import './theme';

// macOS embeds only the proven topology renderer inside the SwiftUI workspace.
const nativeGraph = window.__KUROGANE_NATIVE_GRAPH__ || (isTauri() && /Mac/.test(navigator.platform));
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {nativeGraph ? <NativeGraph /> : <App />}
  </StrictMode>,
);
