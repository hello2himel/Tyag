import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Tyag mobile shell (Android + iOS).
 *
 * The mobile apps ship the exact same static PWA bundle as the web build
 * (`apps/web/dist`), served from the local app bundle (`https://` scheme on
 * Android, `capacitor://` on iOS), never from a network origin. All
 * persistence is local (SQLite-WASM snapshot via
 * @capacitor/filesystem Directory.Data). The Android app does not even request
 * the INTERNET permission.
 *
 * Colors mirror the design tokens: canvas #000, brand #0071E3.
 */
const config: CapacitorConfig = {
  appId: 'app.tyag.Tyag',
  appName: 'Tyag',
  webDir: '../web/dist',
  backgroundColor: '#000000',
  android: {
    backgroundColor: '#000000',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    backgroundColor: '#000000',
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: true,
  },
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
    // Local assets only: no server.url, no cleartext traffic.
    cleartext: false,
  },
  plugins: {
    // targetSdk 36 forces edge-to-edge on Android 15+; SystemBars (part of
    // @capacitor/android 8) keeps the WebView clear of system bars/cutouts by
    // exposing env(safe-area-inset-*) instead of drawing opaque chrome.
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
  },
};

export default config;
