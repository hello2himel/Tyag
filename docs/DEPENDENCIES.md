# Tyag — Dependencies

Tyag itself is licensed under **AGPL-3.0-only** (see `LICENSE`). Its dependency surface is intentionally small. Each direct dependency
has a technical justification; none includes telemetry, advertising or cloud
synchronisation. Versions are pinned in `pnpm-lock.yaml`.

## Runtime dependencies

### `packages/core` (`@tyag/core`)

| Package | Version | Why |
| --- | --- | --- |
| `sql.js` | 1.15.x | SQLite compiled to WebAssembly — real SQL, constraints, transactions and migrations with one driver across browser, WebView, Tauri's WebView and Node tests. |
| `@js-temporal/polyfill` | 0.5.x | Correct timezone/DST/leap-year calendar boundaries for local periods. |

### `apps/web`

| Package | Version | Why |
| --- | --- | --- |
| `react`, `react-dom` | 19.x | UI runtime. |
| `@capacitor/core` | 8.x | Platform detection and native bridge. |
| `@capacitor/filesystem` | 8.x | App-private database file on Android/iOS. |
| `@capacitor/local-notifications` | 8.x | Optional on-device progress notifications. |
| `sql.js` | 1.15.x | Direct dependency because the app loads `sql-wasm.wasm` as a local asset. |

### `apps/mobile`

Capacitor Android project plus `@capacitor/android`. iOS project added on
macOS/CI.

### `apps/desktop`

**Tauri 2** (Rust) with only `serde`, `base64` and the `tauri` crate on the Rust
side; `@tauri-apps/cli` is build tooling and `@tauri-apps/api` is used by the
web bundle solely to call the app's own database/export commands. The system
WebView (WebKitGTK/WKWebView/WebView2) renders the shared bundle; no plugin
that could access the network, shell or arbitrary files is linked.

## Build/test tooling

`typescript`, `vite`, `@vitejs/plugin-react`, `vite-plugin-pwa`,
`workbox-window`, `vitest`, `@types/*`, `@tauri-apps/cli`.

## Not included, by design

- No analytics/crash SDK (Sentry, Firebase, Google Analytics, …).
- No cloud/database SDK (Firebase, Supabase, iCloud, …).
- No remote font/asset packages.
- No AI/LLM SDK.
- No push-notification service.
- No advertising or attribution SDK.
- No auto-updater.

## Audit

`pnpm audit:privacy` inspects the production build for external hosts and
forbidden integrations. CI runs it on every push. Network access is verified
by running the app offline, not by trusting the absence of visible requests.
