import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { initBackNavigation } from './platform/back';
import { ToastProvider } from './ui/components';
import './ui/styles.css';

// Offline-first: the service worker only precaches the locally bundled app.
// The desktop shell embeds the same bundle and has no service worker, so skip
// registration there to avoid a pointless console error.
const isDesktopShell =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
if (!isDesktopShell) registerSW({ immediate: true });

// Hash routes are the only routing mechanism (no server rewrites), so give the
// first entry a real path before React mounts. Doing it here — rather than
// from a `useRoute` effect — means no screen or back layer can observe, or
// race against, the empty-hash transient during boot or unlock.
if (typeof window !== 'undefined' && !window.location.hash) {
  window.location.replace('#/trackers');
}

// One global back dispatcher for every shell: browser/PWA back + desktop
// keyboard on the web bundle, Android hardware back through the TyagBack
// plugin, and the shared history sentinels used on web/PWA and iOS.
initBackNavigation();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
