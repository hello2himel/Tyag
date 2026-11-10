export {};

declare global {
  interface Window {
    /** Injected by the Tauri 2 runtime (desktop shell); absent on the web. */
    __TAURI_INTERNALS__?: unknown;
  }
}
