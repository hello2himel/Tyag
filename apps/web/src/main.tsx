import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { ToastProvider } from './ui/components';
import './ui/styles.css';

// Offline-first: the service worker only precaches the locally bundled app.
// The desktop shell embeds the same bundle and has no service worker, so skip
// registration there to avoid a pointless console error.
const isDesktopShell =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
if (!isDesktopShell) registerSW({ immediate: true });

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
