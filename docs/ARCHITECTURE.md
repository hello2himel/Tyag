# deUrge — Architecture

deUrge is a local-first abstinence and recovery tracker. The same TypeScript
application runs as a PWA, an Android app, an iOS app and a desktop app. There
is no server, no account system and no network dependency.

## 1. Technology choice

**React 19 + TypeScript + Vite 8** for the application, **SQLite compiled to
WebAssembly (sql.js)** for storage, **Capacitor 8** for Android/iOS shells and
**Tauri 2** (Rust + the system WebView) for Windows/macOS/Linux + **Flatpak**.

Why this stack over Flutter (the other obvious option):

| Requirement | React/Vite + Capacitor/Tauri | Flutter |
| --- | --- | --- |
| Host on Netlify | Native static SPA build | Needs a custom build image |
| One UI for the supplied HTML-based design | Direct, design tokens map 1:1 | Recreate every screen by hand |
| Five platforms | PWA + Capacitor + Tauri | Native targets, but web is a different renderer |
| Local SQLite | One WASM driver everywhere, testable in Node | Native SQLite plugins per platform |
| Automated tests of calculations | Pure TS core, Vitest | Dart tests, separate tooling |

The domain, streak, analytics, insights, backup and persistence layers are
plain TypeScript with zero platform imports, so they are tested directly and
shared by every target. Only the storage adapter and notification bridge are
platform-specific.

### Dependency rationale

| Dependency | Why |
| --- | --- |
| `react`, `react-dom` | UI runtime; no framework lock-in beyond the component tree |
| `vite`, `@vitejs/plugin-react` | Fast deterministic builds and static output for Netlify |
| `vite-plugin-pwa` (+`workbox-window`) | Offline precache of the locally bundled app; no runtime/remote caching |
| `sql.js` | Real SQLite (SQL, constraints, joins, transactions) compiled to WASM; runs identically in browsers, WebViews, Tauri's WebView and Node tests |
| `@js-temporal/polyfill` | Correct DST/leap-year/timezone calendar arithmetic for local day/week/month grouping |
| `@capacitor/core`, `@capacitor/android`, `@capacitor/filesystem`, `@capacitor/local-notifications` | Native Android/iOS shell, app-private DB file, on-device notifications |
| `@tauri-apps/api`, `@tauri-apps/cli`, Rust `tauri` crate | Desktop shell using the operating system's WebView (no bundled Chromium), plus installers; IPC payloads are base64 database snapshots |
| `vitest` | Fast TS test runner for the core |
| `typescript` | Strict typing across the monorepo |

Deliberately **not** used: analytics SDKs, crash reporters, cloud sync,
remote fonts, remote asset CDNs, external AI APIs, push notifications, or any
code that opens a network connection.

## 2. Repository layout

```
deUrge/
├── apps/
│   ├── web/            React PWA (Netlify deploy target, shared by all shells)
│   ├── mobile/         Capacitor config + committed android/ (ios/ via CI)
│   └── desktop/        Tauri 2 shell (Rust commands + system WebView)
├── packages/
│   └── core/           @deurge/core — domain, SQLite, services, engines, backups
├── flatpak/            Flatpak manifest, AppStream metadata, build script
├── docs/               architecture/data model/calculation rules/privacy/backup
├── scripts/            privacy audit, release helpers
├── netlify.toml        web deployment configuration
└── .github/workflows/  CI + Android/Flatpak/Windows/macOS/iOS release builds
```

## 3. Layers

```
┌──────────────────────────────────────────────────────────────┐
│ UI (apps/web/src)                                            │
│  screens · design system · formatters · hash router · store   │
├──────────────────────────────────────────────────────────────┤
│ @deurge/core                                                 │
│  services (trackers, lapses, urges, journal, check-ins,       │
│  categories, settings, history)                              │
│  engines (streak, recognition, analytics, insights, backup)   │
│  repositories + SQLite wrapper + migrations                   │
├──────────────────────────────────────────────────────────────┤
│ Platform adapters                                             │
│  IndexedDB (web) · Filesystem (Capacitor) · Tauri IPC file      │
│  clock · local notifications · native file save/open          │
└──────────────────────────────────────────────────────────────┘
```

- **Domain models** (`packages/core/src/domain.ts`): plain records, timestamps
  in UTC epoch milliseconds plus the local zone/offset that recorded them.
- **Persistence** (`db/`, `repos/`): SQLite schema, migrations and typed
  repositories. Business logic never speaks SQL outside these files.
- **App lock** (`services/security.ts` + `apps/web/src/features/lock`): a
  4-digit PIN gate rendered by the React root before any records; PBKDF2-SHA-256
  hash in the local `meta` table, Android biometric unlock through a small local
  Capacitor plugin, and a 60-second background auto-lock.
- **Business logic** (`services/`): validation, lifecycle rules (pause/resume/
  archive/restore/delete), history recording, transactions + snapshot persist.
- **Streak engine** (`engine/streak.ts`): pure deterministic calculation from
  stored records; no timers, no cached derived state.
- **Recognition** (`engine/recognition.ts`): messages generated from the
  metrics; no milestone system anywhere.
- **Analytics** (`analytics/`): local-time period buckets, distributions,
  combined view. Recalculated on demand from records.
- **Insights** (`insights/`): deterministic rules with sample sizes, period
  labels and explicit insufficient-data/causation caveats.
- **Backup** (`backup/`): JSON export/import, CSV export, encrypted backups,
  validation, merge/replace with transactional safety.
- **Platform** (`apps/web/src/platform`): storage adapters, file save/open,
  notifications. This is the only code aware of the host platform.

## 4. Data flow (write)

1. A screen calls a service method (e.g. `core.lapses.create`).
2. The service validates input, writes the record and an append-only history
   event **inside one SQLite transaction**.
3. After the transaction commits, the core exports the database bytes and the
   active `PersistenceAdapter` stores that snapshot (IndexedDB put / atomic
   file rename / Capacitor filesystem write).
4. The store's `refresh()` bumps a version; screens recompute metrics from the
   database and the current clock.

If validation or the transaction fails, nothing is persisted and the database
stays exactly as it was. This is what makes merge/replace imports safe.

## 5. SQLite-WASM trade-off

The database is loaded into memory and snapshotted after writes. This is a
deliberate trade-off: the dataset is a personal journal (kilobytes to a few
megabytes), snapshots are atomic per platform, and a single storage driver can
be tested under Node and shipped to browsers, WebViews and Tauri without
native bindings. The portability/export formats make the snapshot itself
disposable: every record can be reconstructed from the JSON export, and the
JSON export is generated from the database, not vice versa.

## 6. Time handling

- Persist UTC epoch milliseconds only.
- Persist the IANA zone and UTC offset at entry time for display context.
- Use Temporal for local calendar boundaries (day/week/month/quarter/year), so
  DST transitions and leap years are correct.
- Derive all durations from timestamps. A one-second UI timer only re-renders;
  it never owns elapsed time. Changing the device clock or time zone cannot
  corrupt stored history, and negative durations are clamped to zero.

See [CALCULATION_RULES.md](CALCULATION_RULES.md) for the exact definitions.

## 7. Offline and privacy architecture

- Build output contains only local assets; there are no remote URLs, fonts,
  scripts or runtime caching rules.
- A strict CSP (`default-src 'self'`, `connect-src 'self'`) is set in
  `index.html` and in Netlify headers.
- No account, no telemetry, no analytics, no crash upload, no cloud sync.
- The service worker precaches the app for offline use.
- `scripts/audit-privacy.mjs` audits the production build for external hosts,
  sockets, external links and forbidden SDKs; CI runs it.
- Platform integrations are audited in [PRIVACY.md](PRIVACY.md).

## 8. Platform shells

- **Web/PWA** (`apps/web`): static `dist/` deployed to Netlify; installable;
  works offline after first load.
- **Android/iOS** (`apps/mobile`): Capacitor 8 loads the same `dist/` from the
  app bundle over `https://localhost`; the database lives in app-private
  storage via `@capacitor/filesystem`; notifications use the local
  notification plugin.
- **Windows/macOS/Linux** (`apps/desktop`): a Tauri 2 application embeds the same
  `dist/` and renders it in the system WebView (WebKitGTK / WKWebView /
  WebView2). Three Rust commands are the only privileged surface: `db_read`,
  `db_write` (atomic temp + fsync + rename) and `db_backup`, plus
  `save_text_file` for user-initiated exports. The database lives in the app
  data directory. No filesystem, shell, HTTP or updater plugin is linked.
- **Linux Flatpak**: the Tauri binary is packaged against an `org.gnome.Platform`
  runtime (WebKitGTK 4.1) with no network permission and no home-directory
  access.

## 9. Testing strategy

- **Core** (`packages/core/tests`): streak math, pause/archive behaviour,
  timezone/DST/leap-year boundaries, clock changes, edits/deletes, restart,
  analytics, insights, import/export/encryption, CSV, schema constraints.
- **Web**: strict typecheck + production build; visual verification at the
  design breakpoints; privacy audit of the build output.
- **Android/desktop**: packaging builds in CI; the web UI is the same code.

## 10. Known limitations (documented, not hidden)

- The live database is snapshotted after each write, so a process kill during
  the tiny window while a snapshot is being replaced could lose the *last*
  change. The previous snapshot is kept as a rolling backup on disk adapters
  where possible, and JSON exports are the user-controlled fallback.
- Encrypted backups protect exported files, not the live database on disk.
  Full at-rest database encryption is a platform decision (OS full-disk/file
  encryption, app-private storage); deUrge does not invent its own crypto.
- Web/PWA local notifications only fire while the app is open (no push
  service by design). Android/iOS use scheduled on-device notifications.
- macOS/Windows/iOS installers are produced by CI on their native runners;
  Linux-hosted builds cannot cross-sign Apple/Windows artifacts.
