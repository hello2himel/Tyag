# deUrge — Dependencies

deUrge intentionally keeps its dependency surface small. Each direct dependency
has a technical justification; none includes telemetry, advertising or cloud
synchronisation. Versions are pinned in `pnpm-lock.yaml`.

## Runtime dependencies

### `packages/core` (`@deurge/core`)

| Package | Version | Why |
| --- | --- | --- |
| `sql.js` | 1.15.x | SQLite compiled to WebAssembly — real SQL, constraints, transactions and migrations with one driver across browser, WebView, Electron and Node tests. |
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

`electron` + `electron-builder` (dev/build tooling). No runtime network
features enabled.

## Build/test tooling

`typescript`, `vite`, `@vitejs/plugin-react`, `vite-plugin-pwa`,
`workbox-window`, `vitest`, `@types/*`, `electron-builder`.

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
