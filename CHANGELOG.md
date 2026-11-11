# Changelog

## 1.0.1 — 2026-11-11

### Fixed

- **Back navigation on every platform.** Android hardware/gesture Back no
  longer closes the app from anywhere: a new local `TyagBack` Capacitor plugin
  forwards `onBackPressed` to the web layer, which closes the topmost
  sheet/modal/PIN overlay or onboarding step first, then walks the route
  history back, and only exits from the root screen. iOS gets the WKWebView
  edge-swipe gesture, web/PWA gets correct browser-back and Alt+Left/Cmd+[
  handling (a history sentinel keeps an open overlay from being navigated
  away), and the Tauri desktop shell supports Alt+Left/Cmd+[. Consumed
  `?new=1` deep links are now replaced out of the URL so Back never reopens a
  dismissed sheet. See [docs/BACK_NAVIGATION.md](docs/BACK_NAVIGATION.md).
- **Mobile bottom navigation is opaque.** On phones/tablets the tab bar uses
  the new solid `--nav-solid` surface with no backdrop blur; desktop keeps its
  translucent treatment (and hides the tab bar entirely).
- **Android system bars blend with the app.** The Android shell is edge-to-edge
  on every supported API: the transparent status bar and navigation/gesture bar
  show the app canvas instead of a separate system surface (no scrim behind the
  gesture pill), the window background follows day/night, and the bar icons are
  re-tinted from the resolved in-app theme. The branded black splash is
  unchanged.

## 1.0.0 — 2026-11-10

First complete release of Tyag: a private, local-first, cross-platform
abstinence and habit recovery tracker. Licensed under **AGPL-3.0-only**.

### Product

- Multiple independent trackers with backdated starts, descriptions,
  categories, personal notes and reasons; pause, resume, archive, restore and
  permanent delete with explicit confirmations.
- Indefinite abstinence tracking with exact current streak, longest streak,
  accumulated abstinence, wall-clock time since start, paused time, lapse
  count, average/median time between lapses and per-active-week/month rates.
- Lapse recording with time, trigger, reason, context, notes and retrospective
  flag. Lapses never erase accumulated progress.
- Separate urge tracking (intensity 1–10, duration, trigger, outcome) that
  never resets a streak.
- Journal entries, check-ins and a complete searchable activity log with
  filters.
- Continuous progress recognition generated from real elapsed time — no
  milestones, badges, levels or completion targets.
- Local analytics: day/week/month/quarter/year buckets, distributions,
  combined multi-tracker view, sample sizes and honest insufficient-data
  states.
- Deterministic, offline insights engine with period labels, sample sizes and
  caveats; no AI services, no predictions, no diagnoses.
- Full JSON export/import, RFC 4180 CSV exports, password-protected encrypted
  backups (PBKDF2-SHA256 310k + AES-GCM 256), schema versions, integrity
  hashes and transactional merge/replace imports with duplicate/conflict
  reporting.
- Database migrations, strict input validation, structured activity history and
  recovery guidance.

### Platforms

- **Web/PWA** (React 19 + Vite 8): installable, offline-first, Netlify-ready,
  strict CSP, zero external requests, local notifications (while open).
- **Android** (Capacitor 8): signed APK and AAB, targetSdk 36, minSdk 24, no
  INTERNET permission, app-private SQLite snapshot, local notifications.
- **iOS**: committed Xcode/SPM project; unsigned simulator/archive builds in
  CI on macOS.
- **Windows/macOS/Linux desktop** (Tauri 2 + Rust, system WebView): minimal
  Rust command bridge, atomic local database writes, NSIS/MSI/DMG builds in
  CI, AppImage/deb/rpm and Flatpak for Linux.

### Quality

- 136 automated core tests: streak math (pauses, backdated/out-of-order events,
  edits/deletes, restarts, clock changes, timezone/DST/leap-year boundaries),
  analytics, insights, JSON/CSV import/export, encrypted backups, database
  constraints/migrations.
- End-to-end browser verification: onboarding, all record types, lifecycle
  transitions, settings persistence, exports, merge/replace imports, restart
  persistence, production offline reload, zero external network requests.
- Tauri build validation, Android signing verification, Flatpak
  sandbox/metadata verification, privacy audit of the shipped web bundle.

### Known limitations

- Encrypted backups protect exported files; the live database relies on OS
  full-disk/app-private storage (documented in `docs/PRIVACY.md`).
- Web notifications only fire while the PWA is open (no push service by
  design). Android/iOS use on-device scheduled notifications.
- Windows/macOS/iOS installers are built and unsigned by CI (no Apple/Windows
  signing certificates in this repository).
- Android build artifacts are release-signed; the release keystore is kept
  outside the repository and is not distributed.
