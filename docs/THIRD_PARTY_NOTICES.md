# Third-party notices

deUrge is MIT-licensed. It is built with the following open-source packages
(see `pnpm-lock.yaml` for exact resolved versions). Each is used under its own
license; no package includes advertising, tracking or cloud functionality.

| Package | License | Use |
| --- | --- | --- |
| React, React DOM | MIT | UI runtime |
| Vite, @vitejs/plugin-react | MIT | build tooling |
| vite-plugin-pwa, Workbox | MIT | offline service worker generation |
| sql.js (SQLite compiled to WebAssembly) | MIT (SQLite is public domain) | local database |
| @js-temporal/polyfill | Apache-2.0 | timezone-aware calendar math |
| Capacitor core/Android/Filesystem/LocalNotifications | MIT | Android/iOS shell |
| Electron, electron-builder | MIT | desktop shell and packaging |
| TypeScript | Apache-2.0 | type system/build |
| Vitest | MIT | tests |

The system font stack is used; no font files are bundled or downloaded. The
application does not load resources from third-party servers at runtime.

If you redistribute a built binary, include this notice file and the upstream
license texts (available in each package under `node_modules/<package>/LICENSE`
or via the package registry).
