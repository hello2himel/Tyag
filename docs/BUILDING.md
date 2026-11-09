# Building deUrge

Everything in this document is reproducible from a clean checkout: pinned
toolchain versions, a committed lockfile, committed icon assets, and no
network-dependent steps in the product itself. Every command listed here has
been run in this repository on Linux x86_64; macOS/Windows steps are the CI
equivalents (see `.github/workflows/`).

> deUrge is local-first by construction. No build step, bundle or runtime
> fetches third-party assets. `pnpm audit:privacy` enforces that on the
> shipped web bundle.

---

## 1. Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 22 LTS (repo engines: `>=20.19`; CI uses 22) | everything |
| pnpm | 10.15.0 (`corepack enable`) | everything |
| JDK | **21** (AGP 8.13 in Capacitor 8 requires 21) | Android |
| Android SDK | platform **android-36**, build-tools **36.0.0**, platform-tools | Android |
| Xcode | 16+ on macOS | iOS |
| Flatpak CLI | 1.14+ with the `flathub` remote | Flatpak |
| flatpak-builder | 1.4+ (or `org.flatpak.Builder` app, or Docker) | Flatpak |
| librsvg (`rsvg-convert`) or ImageMagick (`magick`) | any recent | regenerating icons only |
| Docker | optional | containerised Flatpak builds |

Install JavaScript dependencies once:

```bash
corepack enable                 # activates pnpm@10.15.0 from package.json
pnpm install --frozen-lockfile  # exact versions from pnpm-lock.yaml
```

Environment variables are never hardcoded in the repository. Set them in your
shell (or CI):

| Variable | Used by | Meaning |
| --- | --- | --- |
| `JAVA_HOME` | Android | JDK 21 installation directory |
| `ANDROID_HOME` | Android | Android SDK directory (fallback: `apps/mobile/android/local.properties`, git-ignored) |
| `DEURGE_DEV_SERVER_URL` | Electron dev | Vite dev server URL (default `http://localhost:5173`) |
| `DEURGE_KEYSTORE`, `DEURGE_KEYSTORE_PASSWORD`, `DEURGE_KEY_ALIAS`, `DEURGE_KEY_PASSWORD` | Android release | release signing (never committed) |
| `FLATPAK_BUILDER` | Flatpak | explicit path to a `flatpak-builder` binary |
| `BUILD` | Flatpak | `direct`, `docker` or `auto` |
| `SKIP_APP_BUILD` | Flatpak | `1` reuses an existing web + Electron build |

CI additionally uses `ANDROID_KEYSTORE_BASE64` (base64 of the release keystore)
and platform signing secrets; see [RELEASING.md](RELEASING.md).

### Repository layout

```
apps/web/          React 19 + Vite 8 PWA (the single shared UI bundle)
apps/desktop/      Electron shell (main process, preload, electron-builder)
apps/mobile/       Capacitor shell + committed android/ and ios/ projects
packages/core/     domain, persistence, engines, analytics, insights
flatpak/           Flatpak manifest, AppStream metadata, launcher, build.sh
scripts/           privacy audit + icon generation
.github/workflows/ CI and per-platform release workflows
```

The single source of truth for the UI is `apps/web`; desktop and mobile only
package its build output. Do not edit `apps/web/dist` (generated).

---

## 2. Web / PWA (the shared bundle)

```bash
pnpm dev                             # Vite dev server, http://localhost:5173
pnpm --filter @deurge/web build      # typecheck + production build -> apps/web/dist
pnpm preview                         # serve the production build locally
pnpm typecheck                       # all workspaces
pnpm test                            # @deurge/core unit tests (vitest)
pnpm audit:privacy                   # offline-bundle audit (see §8)
```

The build emits a fully static `apps/web/dist` (hashed assets, `sw.js` service
worker, `manifest.webmanifest`, icons, `assets/sql-wasm-*.wasm`).

### Deploying the web build

* **Netlify** is preconfigured in `netlify.toml`:
  build `pnpm --filter @deurge/web build`, publish `apps/web/dist`, SPA hash
  routing fallback, and hardened security headers (CSP etc.). No environment
  variables or secrets are required.
* Any static host works (GitHub Pages, S3, nginx) — copy `apps/web/dist` and
  set a 200-fallback to `index.html`. `pnpm build` then `pnpm preview` for a
  local check.

---

## 3. Electron desktop (Windows, macOS, Linux)

```
apps/desktop/
  src/main.js       main process (app:// scheme, window, navigation/CSP hardening)
  src/preload.cjs   the only bridge: window.deurgeDesktop
  src/db-store.js   atomic local SQLite snapshot persistence (IPC handlers)
  electron-builder.yml
  build/            committed icons (png, ico, icns) — generated, do not hand-edit
```

### How the shell loads the app

The packaged UI is served from a **privileged custom scheme**, not `file://`:
`protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard,
secure, supportFetchAPI, corsEnabled, stream } }])` then
`protocol.handle('app', …)` reads files from `resources/web` and serves
`app://deurge/index.html`. This keeps fetch(), SQLite-WASM streaming,
IndexedDB/OPFS and the service worker working exactly like on the web, and it
gives the shell a real origin to enforce:

* CSP (`default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, …) on every
  response — identical to the Netlify header policy;
* navigation is denied unless it targets `app://deurge/` (or the Vite dev
  server in development); popups and webviews are denied;
* permissions other than notifications are denied;
* `contextIsolation`, `sandbox: true`, `nodeIntegration: false`.

### Local persistence contract (must stay in sync with the web adapter)

`window.deurgeDesktop` is the only privileged API:

```ts
readDatabase():        Promise<ArrayBuffer | null>  // null on first run
writeDatabase(bytes):  Promise<void>                // atomic: temp file + fsync + rename
backupDatabase(bytes): Promise<void>                // stable + timestamped backups
platform: 'electron'
versions: { electron, chrome }
```

Files (inside Electron's per-user data directory, e.g.
`~/.config/@deurge/desktop` on Linux):

| Path | Purpose |
| --- | --- |
| `deurge.db` | live SQLite snapshot (atomic writes) |
| `deurge.backup.db` | stable pre-write backup (overwritten each backup) |
| `backups/deurge-<ISO-8601>.db` | rotating history, last 20 kept |

IPC channels `deurge:db:read|write|backup` validate the sender frame and reject
payloads that are not `ArrayBuffer`/`Uint8Array`, empty, or larger than 64 MiB.

### Develop

```bash
pnpm dev                                       # terminal 1: Vite dev server (:5173)
pnpm --filter @deurge/desktop dev              # terminal 2: Electron against the dev server
```

`dev` loads `DEURGE_DEV_SERVER_URL` (default `http://localhost:5173`) and opens
DevTools. `pnpm --filter @deurge/desktop start` instead serves the local
`apps/web/dist` through `app://` **without** packaging — handy to validate the
production loading path after `pnpm --filter @deurge/web build`.

Headless end-to-end smoke test (no display required; also runs in CI):

```bash
pnpm --filter @deurge/web build
pnpm build:desktop                 # unpacked bundle in apps/desktop/release
node scripts/electron-smoke.mjs
```

`scripts/electron-smoke.mjs` launches `apps/desktop/release/linux-unpacked`
under `--ozone-platform=headless`, drives it over the Chrome DevTools Protocol
and asserts: `app://deurge/index.html` is served, the web app renders, the
SQLite-WASM asset is fetched locally, **no external network request** is made,
`window.deurgeDesktop` round-trips database bytes, `deurge.db` +
`deurge.backup.db` + `backups/` exist on disk, and there are no CSP violations.
Exits non-zero on any failure.

### Package

```bash
pnpm build:desktop                            # Linux unpacked dir (also used by Flatpak)
pnpm --filter @deurge/desktop dist:linux      # + AppImage
pnpm --filter @deurge/desktop dist:win        # NSIS installer  (on Windows)
pnpm --filter @deurge/desktop dist:mac        # DMG             (on macOS)
```

Outputs land in `apps/desktop/release/` (git-ignored):

| Artifact | Target |
| --- | --- |
| `linux-unpacked/deurge` | Linux unpacked (input for the Flatpak build) |
| `deUrge-<version>-x86_64.AppImage` | Linux AppImage |
| `deUrge-Setup-<version>-x64.exe` | Windows NSIS installer |
| `deUrge-<version>-<arch>.dmg` | macOS disk image |

Icons are committed in `apps/desktop/build/` (`icon.png` 1024², `icon.ico`,
`icon.icns`, `icons/<n>x<n>.png`). Regenerate them with the icon script (§7) if
the mark changes — never edit PNGs by hand.

Signing is optional for local builds. Real releases: see
[RELEASING.md](RELEASING.md) (Windows code signing via `CSC_LINK`/`CSC_KEY_PASSWORD`,
macOS Developer ID + notarization via `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/
`APPLE_TEAM_ID`). No certificates are stored in the repository.

---

## 4. Android (Capacitor)

The committed `apps/mobile/android/` project wraps the same web bundle. It
requests **no INTERNET permission** — the WebView serves assets from the local
`https://localhost` asset loader via Capacitor. Cleartext traffic and backups are
disabled; data is app-private.

Prerequisites: JDK 21 (`JAVA_HOME`), Android SDK 36 (`ANDROID_HOME`). If
`ANDROID_HOME` is unset, Gradle falls back to the git-ignored
`apps/mobile/android/local.properties`:

```properties
sdk.dir=/path/to/Android/Sdk
```

### Build

```bash
# debug APK (debug keystore, installable, not for stores)
pnpm build:android:debug

# auto: release if signing env vars are present, otherwise debug
pnpm build:android

# signed release: APK + AAB (requires the four DEURGE_* signing variables)
pnpm build:android:release
```

Each script builds `apps/web`, runs `cap sync android`, then Gradle. Outputs
(git-ignored):

| Artifact | Path |
| --- | --- |
| debug APK | `apps/mobile/dist/apk/deUrge-<version>-debug.apk` |
| release APK | `apps/mobile/dist/apk/deUrge-<version>-release.apk` |
| release AAB (Play Store) | `apps/mobile/dist/aab/deUrge-<version>-release.aab` |
| checksums | `apps/mobile/dist/SHA256SUMS.txt` |

The release APK is verified with `apksigner verify` automatically. Install a
debug build on a device/emulator with
`adb install -r apps/mobile/dist/apk/deUrge-<version>-debug.apk`.

### Signing (no secrets in the repository)

Create a keystore once, **outside** the repo, and back it up securely:

```bash
keytool -genkeypair -v \
  -keystore "$HOME/deurge-release.jks" \
  -alias deurge \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12
```

> PKCS12 keystores require the **key password to equal the store password**
> (`keytool` ignores a different `-keypass` for PKCS12). Use the same value for
> `DEURGE_KEYSTORE_PASSWORD` and `DEURGE_KEY_PASSWORD`, or create a JKS keystore
> if you need distinct passwords.

Then export the four variables for a signed build:

```bash
export DEURGE_KEYSTORE="$HOME/deurge-release.jks"
export DEURGE_KEYSTORE_PASSWORD='…'
export DEURGE_KEY_ALIAS='deurge'
export DEURGE_KEY_PASSWORD='…'
pnpm build:android:release
```

CI stores the same keystore base64-encoded as `ANDROID_KEYSTORE_BASE64`
(plus the three other secrets) — see [RELEASING.md](RELEASING.md).

### Gradle / Capacitor notes

* `applicationId` is `app.deurge.DeUrge`; `versionCode`/`versionName` live in
  `apps/mobile/android/app/build.gradle` and must be bumped for each release.
* `compileSdk`/`targetSdk` = 36, `minSdk` = 24 (Capacitor defaults, in
  `variables.gradle`).
* Edge-to-edge is enforced for `targetSdk 36`; the Capacitor **SystemBars**
  plugin (`insetsHandling: 'css'`) exposes `env(safe-area-inset-*)` and the
  launch theme uses `shortEdges` cutout mode, so the UI paints behind system
  bars and pads with safe-area insets.
* Adaptive launcher icons (`mipmap-*/ic_launcher_foreground.png` + brand
  background `#0071E3`), legacy launcher/round icons, and the Android 12+ splash
  icon are all generated from the deUrge mark (§7).
* `npx cap sync android` (run inside `apps/mobile`) copies `apps/web/dist` into
  `android/app/src/main/assets/public/` (git-ignored) and regenerates the
  Capacitor gradle config.

---

## 5. iOS (Capacitor)

The committed `apps/mobile/ios/` Xcode project wraps the same web bundle.
Capacitor 8 uses **Swift Package Manager** (generated `ios/App/CapApp-SPM`) —
CocoaPods is only used if a `Podfile` exists. Building requires macOS + Xcode.

```bash
pnpm --filter @deurge/mobile sync:ios          # web build + cap sync ios
pnpm --filter @deurge/mobile build:ios         # unsigned simulator build
bash apps/mobile/scripts/build-ios.sh archive  # unsigned .xcarchive for signing
```

* Bundle id `app.deurge.DeUrge`, `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`
  in `ios/App/App.xcodeproj/project.pbxproj` (bump for each release).
* `ITSAppUsesNonExemptEncryption = false` (no cryptography beyond platform
  APIs), portrait/landscape iPhone + iPad, arm64 only.
* App icon and launch-screen splash images are committed under
  `ios/App/App/Assets.xcassets/` and generated from the same mark (§7).
* Signing is configured in Xcode/CI with an Apple Developer account
  (`DEVELOPMENT_TEAM`, provisioning profile) — never committed. Unsigned CI
  builds prove compilation only; a store build requires the signing secrets
  described in [RELEASING.md](RELEASING.md).
* **Linux limits**: on Linux you can scaffold/sync the iOS project and edit its
  files, but you cannot compile it — Xcode is macOS-only. The `ios.yml` CI job
  therefore runs on a macOS runner and produces **unsigned** artifacts: a
  simulator `.app` and an unsigned `.xcarchive`. Signed `.ipa`/App Store
  uploads are a manual (or separately-secured signing job) step.
* Modifying `capacitor.config.ts` requires re-running `cap sync ios` on macOS.

---

## 6. Linux Flatpak

The Flatpak packages the same Electron `linux-unpacked` payload with `zypak`,
so Chromium's sandbox runs inside the Flatpak sandbox.

```
flatpak/
  org.deurge.DeUrge.yml          manifest (runtime/base 24.08, zypak, sandbox policy)
  org.deurge.DeUrge.metainfo.xml AppStream metadata (offline; no remote URLs/screenshots)
  org.deurge.DeUrge.desktop      desktop entry
  deurge-wrapper.sh              launcher (zypak-wrapper + Ozone flags + TMPDIR)
  build.sh                       web + Electron build -> stage -> flatpak-builder -> .flatpak
  dist/                          output (git-ignored)
```

### Build

```bash
pnpm build:flatpak                    # bash flatpak/build.sh (auto-detects builder)
BUILD=direct  bash flatpak/build.sh   # require flatpak-builder on PATH
BUILD=docker  bash flatpak/build.sh   # use ghcr.io/flathub-infra/flatpak-builder image
SKIP_APP_BUILD=1 bash flatpak/build.sh  # reuse existing web/Electron build
FLATPAK_BUILDER=/path/to/flatpak-builder bash flatpak/build.sh
```

Requirements: `flatpak` CLI with the `flathub` remote (user or system), and one
of: `flatpak-builder` on `PATH`, the `org.flatpak.Builder` Flatpak app, or
Docker. `--install-deps-from=flathub` downloads the 24.08 SDK/runtime/base app on
first build (~1.5 GB) and then builds offline.

Output: `flatpak/dist/deUrge-<version>-<arch>.flatpak` + `SHA256SUMS.txt`.

```bash
flatpak install --user --bundle flatpak/dist/deUrge-*.flatpak
flatpak run org.deurge.DeUrge
```

### Sandbox permissions (deliberately minimal)

```
--share=ipc --socket=wayland --socket=fallback-x11 --device=dri
--filesystem=xdg-download:rw        # only for user-initiated backup export/import
--talk-name=org.freedesktop.Notifications
```

No `--share=network` and no `--filesystem=home`: the app cannot reach the
network and its database stays inside the sandbox. File import/export uses the
Downloads folder and desktop portals.

### Known limitations

* **Architecture**: the bundle is built for the host architecture (`x86_64`
  here). Cross-arch Flatpaks need a matching Electron build and an
  arch-specific manifest; CI builds x86_64 only.
* **Runtime EOL**: `org.freedesktop.Platform//24.08` is the last runtime the
  Electron2 BaseApp 24.08 supports and prints an end-of-life warning. When
  Flathub ships an Electron2 BaseApp for 25.08/26.08, bump `runtime-version`,
  `base-version` and `RUNTIME_VERSION` in `flatpak/build.sh` together.
* **AppStream workaround**: some distributions ship `appstreamcli` linked
  against libvips without JPEG-XL, which makes `appstreamcli compose` fail with
  `media-worker-error`. `flatpak/build.sh` detects this, retries the compose
  step through the AppStream shipped in the org.freedesktop.Sdk runtime, and
  logs the retry in `flatpak/build/flatpak-builder.log`. CI does not need this.
* **AppStream**: the metainfo intentionally references no remote URLs or
  screenshots (offline bundle). A Flathub submission would add project URLs and
  screenshots.
* **Docker mode** expects the `ghcr.io/flathub-infra/flatpak-builder` image to be
  readable by your Docker daemon; otherwise use `BUILD=direct` or the
  `org.flatpak.Builder` app.

---

## 7. Icons and brand assets

The mark lives in **one** place: `apps/web/public/icons/icon.svg` (512²
rounded-square clock, `#0071E3`) plus the 64² `apps/web/public/favicon.svg`.
Generated assets are committed so normal builds and CI need no image tooling:

```bash
node scripts/gen-icons.mjs           # all: web + desktop + android + ios
node scripts/gen-icons.mjs web       # PWA + favicon PNGs
node scripts/gen-icons.mjs desktop   # 1024 png, sizes, .ico, .icns
node scripts/gen-icons.mjs android   # adaptive/legacy launcher + splash PNGs
node scripts/gen-icons.mjs ios       # 1024 AppIcon + 2732 splash images
```

| Output | Consumer |
| --- | --- |
| `apps/web/public/icons/icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png`, `apps/web/public/favicon-32.png` | PWA manifest / `index.html` |
| `apps/desktop/build/icon.png`, `icon.ico`, `icon.icns`, `icons/*.png` | electron-builder |
| `apps/mobile/android/app/src/main/res/mipmap-*`, `drawable-*/splash_icon.png` | Android launcher + splash |
| `apps/mobile/ios/App/App/Assets.xcassets/**` | iOS AppIcon + launch screen |

Requires `rsvg-convert` (librsvg) or ImageMagick. Output is deterministic for a
given source SVG and tool version; the PNGs are committed so CI never runs it.

---

## 8. Privacy audit

```bash
pnpm audit:privacy   # node scripts/audit-privacy.mjs
```

Scans `apps/web/dist` and the shipped `package.json` files and fails (exit 1) if
it finds:

* known advertising/analytics/telemetry hosts anywhere in the bundle;
* absolute `http(s)`/`ws(s)` URLs in network-capable positions
  (`fetch`, `XMLHttpRequest.open`, `WebSocket`/`EventSource`, `sendBeacon`,
  dynamic `import()`, service-worker registration);
* remote `src`/`href`/`poster` assets in HTML or `url(http…)` in CSS;
* telemetry/analytics SDKs in any dependency list.

Inert namespace/documentation URLs (W3C namespaces, library error-doc links) are
reported for review but do not fail. CI runs this on every push and at release
time. It complements the design rule: no network calls in product code.

---

## 9. Reproducibility

* Toolchain versions are pinned: `packageManager: pnpm@10.15.0`, Electron
  `44.9.0`, electron-builder `26.18.0`, Capacitor `8.6.0`, AGP `8.13.0`,
  Gradle `8.14.3` (wrapper), `pnpm-lock.yaml` committed; CI installs with
  `--frozen-lockfile`.
* Icons, desktop files, manifest and native project files are committed, so
  packaging does not depend on local image tooling or machine paths. Machine
  paths (`local.properties`, `JAVA_HOME`, `ANDROID_HOME`, signing files) are
  git-ignored or environment variables.
* The same inputs produce the same *content* on every machine. Byte-identical
  artifacts are not guaranteed (ASAR/ZIP metadata timestamps differ); therefore
  every release publishes `SHA256SUMS.txt` next to the binaries so any artifact
  can be verified against the recorded hash.
* CI uses Node 22 + pnpm 10.15.0 everywhere; keep local versions aligned to
  reproduce CI failures.

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `JAVA_HOME is not set` / wrong Java version | Point `JAVA_HOME` at JDK 21; `java -version` must report 21. |
| `Android SDK not found` | Set `ANDROID_HOME` or create the git-ignored `apps/mobile/android/local.properties` with `sdk.dir=…`. |
| `sdkmanager: command not found` | Install `cmdline-tools;latest` in the SDK, or use Android Studio's SDK manager; CI uses `android-actions/setup-android`. |
| Electron binary download fails / is slow | Cache `~/.cache/electron`; Electron is a dev dependency (`electron` package) and electron-builder has its own cache (`~/.cache/electron-builder`). CI caches both. |
| `Electron failed to install correctly` | Run `node node_modules/electron/install.js` inside `apps/desktop`, or re-run `pnpm install` with the electron build script allowed. |
| White window in Electron | Build the web app first (`pnpm --filter @deurge/web build`); the shell serves `apps/web/dist`. Check the console for `[deurge] blocked navigation`. |
| `cap sync` says web assets missing | Run `pnpm --filter @deurge/web build` first (or use the `sync:android`/`sync:ios` scripts, which do it for you). |
| Flatpak `appstreamcli compose failed … media-worker-error` | See §6: `build.sh` retries with the SDK's AppStream automatically. |
| Flatpak `Refspec … not found` | Old flatpak-builder default branch; `build.sh` passes `--default-branch=stable`. Use the provided script. |
| iOS `xcodebuild` can't resolve Capacitor packages | First `cap sync ios` needs network for the `capacitor-swift-pm` package; then SPM caches it. Run `xcodebuild -resolvePackageDependencies` (the build script does). |
| `pnpm audit:privacy` fails on a new dependency | Do not add analytics/remote assets. Inspect the reported file and remove the offending import; report it as a privacy regression. |

---

## 11. What CI runs

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | push/PR | typecheck, unit tests, web build, privacy audit, Electron linux unpacked smoke packaging |
| `android.yml` | push/PR (app paths), tags, manual | debug APK, or signed APK+AAB when secrets are configured |
| `flatpak.yml` | push/PR (flatpak/desktop paths), tags, manual | `deUrge-<version>-<arch>.flatpak` |
| `desktop-linux.yml` | push/PR, tags | AppImage |
| `desktop-windows.yml` | push/PR, tags | NSIS installer |
| `desktop-macos.yml` | push/PR, tags | DMG |
| `ios.yml` | push/PR (ios paths), tags | unsigned simulator app + unsigned `.xcarchive` |
| `release.yml` | tag `v*` | builds everything, writes `SHA256SUMS.txt`, creates a **draft** GitHub release |

See [RELEASING.md](RELEASING.md) for the release procedure itself.
