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
| Rust | stable toolchain (`rustup`), `cargo`/`rustc` | Tauri desktop |
| Linux Tauri libs | `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev build-essential pkg-config` (Debian/Ubuntu) | Tauri desktop (Linux) |
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
| (none) | Tauri dev | `tauri dev` uses the Vite dev server from `tauri.conf.json` (`http://localhost:5173`) |
| `DEURGE_KEYSTORE`, `DEURGE_KEYSTORE_PASSWORD`, `DEURGE_KEY_ALIAS`, `DEURGE_KEY_PASSWORD` | Android release | release signing (never committed) |
| `FLATPAK_BUILDER` | Flatpak | explicit path to a `flatpak-builder` binary |
| `BUILD` | Flatpak | `direct`, `docker` or `auto` |
| `SKIP_APP_BUILD` | Flatpak | `1` reuses an existing web + Tauri build |

CI additionally uses `ANDROID_KEYSTORE_BASE64` (base64 of the release keystore)
and platform signing secrets; see [RELEASING.md](RELEASING.md).

### Repository layout

```
apps/web/          React 19 + Vite 8 PWA (the single shared UI bundle)
apps/desktop/      Tauri 2 shell (src-tauri: Rust commands + window hardening)
apps/mobile/       Capacitor shell + committed android/ and ios/ projects
packages/core/     domain, persistence, engines, analytics, insights
flatpak/           Flatpak manifest (GNOME/WebKitGTK runtime), AppStream metadata, launcher, build.sh
scripts/           privacy audit, icon generation, Tauri artifact collection
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

## 3. Tauri 2 desktop (Windows, macOS, Linux)

The desktop shell is **Tauri 2**: the same React/Vite bundle from `apps/web/dist`
is embedded in a small Rust binary and rendered by the operating system WebView
(WebKitGTK 4.1 on Linux, WKWebView on macOS, WebView2 on Windows). There is no
bundled Chromium and no Node.js runtime.

```
apps/desktop/
  package.json              scripts: dev / build / dist:linux / dist:win / dist:mac
  src-tauri/
    Cargo.toml, Cargo.lock  Rust app (@tauri-apps 2), committed lockfile
    build.rs                tauri-build (config/capability/codegen validation)
    tauri.conf.json         productName, identifier, CSP, bundle targets, icons
    capabilities/default.json  main window may only call the app's own commands
    icons/                  committed RGBA icon set generated from the brand kit
    src/main.rs, src/lib.rs window hardening + db_read/db_write/db_backup
  release/                  normalised artifacts (git-ignored, written by
                            scripts/collect-tauri-artifacts.mjs)
```

### How the shell loads the app

`tauri.conf.json` points `frontendDist` at `../../web/dist`, so the built PWA is
compiled into the binary and served from the app's own origin:
`tauri://localhost` on Linux/macOS and `http://tauri.localhost` on Windows.
WebKitGTK/WKWebView/WebView2 render it, so `fetch()`, SQLite-WASM, IndexedDB and
the service worker behave exactly as on the web — with no network access.

The window is created in Rust (`WebviewWindowBuilder`) so the hardening lives in
code rather than in the web bundle:

* **navigation** — only the embedded bundle origin is allowed; remote URLs are
  cancelled (`on_navigation`), and in debug builds the Vite dev server at
  `http://localhost:5173` is the only extra origin;
* **new windows** — `window.open`/`target=_blank` is denied outright
  (`on_new_window` → `Deny`), so nothing can hand a URL to the system browser;
* **permissions** — camera, microphone, geolocation, clipboard, etc. are denied;
  only `Notifications` is granted (local reminders);
* **CSP** — mirrors `netlify.toml`, including `script-src 'self'
  'wasm-unsafe-eval'` for SQLite-WASM, with `connect-src 'self' ipc:
  http://ipc.localhost` for Tauri's local IPC (the IPC is a custom protocol
  inside the webview, never a network socket);
* **capabilities** — `capabilities/default.json` grants no plugin permissions at
  all: no fs, shell, http, opener, process or updater plugin is linked or
  exposed. The only privileged API is the four commands below;
* **downloads** — WebView downloads (JSON/CSV export) are redirected to the
  user's Downloads folder (`on_download`), avoiding a WebKitGTK blob-download
  limitation;
* **devtools** — available in debug builds only; release builds are compiled
  without the `devtools` feature.

### Local persistence contract (must stay in sync with the web adapter)

The web adapter (`apps/web/src/platform/db.ts`) detects
`'__TAURI_INTERNALS__' in window` and calls exactly these Tauri commands:

```ts
invoke<ArrayBuffer | null>('db_read')                     // base64 decoded by the adapter
invoke<void>('db_write',  { payloadB64: string })
invoke<void>('db_backup', { payloadB64: string })
invoke<string>('save_text_file', { filename, content })    // JSON/CSV export
```

Payloads are **base64 strings**, not `Vec<u8>`/ArrayBuffer: Tauri's JSON IPC
would otherwise send a multi-hundred-kilobyte snapshot as a JSON number array
on every save. Rust decodes with `base64` 0.22 and validates the result:

| Command | Behaviour |
| --- | --- |
| `db_read` | base64 of `deurge.db`, or `null` on first run |
| `db_write` | atomic snapshot write (sibling temp file → `fsync` → `rename`) |
| `db_backup` | stable `deurge.backup.db` + `backups/deurge-<epoch-ms>.db`, last 20 kept |
| `save_text_file` | sanitised filename (no paths/`..`/control chars, `.json`/`.csv` only) written atomically to the Downloads folder; returns the absolute path |

Files live in the Tauri **app data dir** (identifier `app.deurge.DeUrge`):

| Path | Purpose |
| --- | --- |
| `<app data>/deurge.db` | live SQLite snapshot (atomic writes, 64 MiB cap) |
| `<app data>/deurge.backup.db` | stable pre-write backup (overwritten each backup) |
| `<app data>/backups/deurge-<epoch-ms>.db` | rotating history, last 20 kept |

Typical locations: `~/.local/share/app.deurge.DeUrge` (Linux),
`~/Library/Application Support/app.deurge.DeUrge` (macOS),
`%APPDATA%\app.deurge.DeUrge` (Windows). Inside the Flatpak it is
`~/.var/app/org.deurge.DeUrge/data/app.deurge.DeUrge/`.

Errors returned to the UI are short, stable strings such as
`invalid_payload: …`, `db_too_large: …`, `db_write_failed: …`,
`export_failed: …` — they never contain paths or user data.

### Develop

```bash
pnpm install
pnpm --filter @deurge/desktop dev   # tauri dev: starts Vite (beforeDevCommand) + the shell
```

The first Rust build downloads crates and takes a few minutes; subsequent
builds are incremental. `RUST_LOG`/`WEBKIT_INSPECTOR_SERVER` are not needed for
normal development (devtools are available in debug builds via the webview
context menu / inspector).

### Test and validate

```bash
cd apps/desktop/src-tauri
cargo test                 # storage/atomic-write/navigation/export unit tests
cargo clippy --all-targets # lint
```

CI additionally builds the release binary and asserts it links the system
WebKitGTK 4.1 (`ldd … | grep webkit2gtk-4.1`) and contains the strict CSP. A
fully headless end-to-end boot is **not** part of CI: Tauri has no
`--ozone-platform=headless` equivalent and WebKitGTK needs a real display
(X11/Wayland) plus a compositor; driving it headlessly is flaky on CI runners.
Local validation is therefore: build, launch on a real desktop session, confirm
the UI renders and `deurge.db` is created under the app data dir, then quit.
The Rust unit tests cover the atomic-write/backup/sanitisation logic, and the
launch check is documented in [RELEASING.md](RELEASING.md) §5.

### Package

```bash
pnpm build:desktop                            # release binary, no bundles
pnpm --filter @deurge/desktop dist:linux      # AppImage + deb + rpm
pnpm --filter @deurge/desktop dist:win        # NSIS + MSI          (on Windows)
pnpm --filter @deurge/desktop dist:mac        # DMG                 (on macOS)
```

Each `dist:*` script builds the web app first, runs `tauri build`, then
normalises the bundle names and writes checksums via
`scripts/collect-tauri-artifacts.mjs`. Outputs land in `apps/desktop/release/`
(git-ignored):

| Artifact | Target |
| --- | --- |
| `deUrge-<version>-x86_64.AppImage` | Linux AppImage |
| `deUrge-<version>-amd64.deb` | Debian/Ubuntu package |
| `deUrge-<version>-x86_64.rpm` | Fedora/RHEL package (needs `rpmbuild`; available in CI) |
| `deUrge-Setup-<version>-x64.exe` | Windows NSIS installer |
| `deUrge-<version>-x64.msi` | Windows MSI |
| `deUrge-<version>-<arch>.dmg` | macOS disk image |
| `SHA256SUMS.txt` | checksums for the artifacts above |

Raw Tauri output lives in `apps/desktop/src-tauri/target/release/bundle/` and
the Flatpak input binary is `apps/desktop/src-tauri/target/release/deurge`.

Icons are committed in `apps/desktop/src-tauri/icons/` (RGBA PNG set, `icon.ico`,
`icon.icns`). Tauri refuses non-RGBA icons, so regenerate with
`pnpm --filter @deurge/desktop exec tauri icon ../web/public/icons/icon-1024.png`
if the mark changes (§7).

Signing is optional for local builds and CI requires **no** signing secrets (see
[RELEASING.md](RELEASING.md)): Windows installers are unsigned unless Tauri
signing options are configured, and the macOS config has
`bundle.macOS.signingIdentity: null` so the DMG is unsigned. No certificates or
keys are stored in the repository.

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

The Flatpak ships the **prebuilt Tauri binary** and runs it on the WebKitGTK 4.1
that comes with `org.gnome.Platform//48`. There is no Electron base app, no
zypak and no bundled Chromium; the app is a normal GTK 3 + WebKitGTK program.

```
flatpak/
  org.deurge.DeUrge.yml          manifest (org.gnome.Platform//48, simple prebuilt module,
                                 sandbox policy: no network, no home)
  org.deurge.DeUrge.metainfo.xml AppStream metadata (offline; no remote URLs/screenshots)
  org.deurge.DeUrge.desktop      desktop entry (Exec=deurge-wrapper)
  deurge-wrapper.sh              launcher -> /app/bin/deurge
  build.sh                       web + Tauri build -> stage -> flatpak-builder -> .flatpak
  dist/                          output (git-ignored)
```

### Build

```bash
pnpm build:flatpak                      # bash flatpak/build.sh (auto-detects builder)
BUILD=direct  bash flatpak/build.sh     # require flatpak-builder on PATH
BUILD=docker  bash flatpak/build.sh     # use ghcr.io/flathub-infra/flatpak-builder image
SKIP_APP_BUILD=1 bash flatpak/build.sh  # reuse existing web/desktop build
FLATPAK_BUILDER=/path/to/flatpak-builder bash flatpak/build.sh
```

Requirements: `flatpak` CLI with the `flathub` remote (user or system), a Rust
toolchain with the Tauri Linux libraries (§1), and one of: `flatpak-builder` on
`PATH`, the `org.flatpak.Builder` Flatpak app, or Docker. On first use,
`--install-deps-from=flathub` fetches `org.gnome.Platform//48` and
`org.gnome.Sdk//48` (~1 GB); afterwards the build is fully offline for the
runtime.

Output: `flatpak/dist/deUrge-<version>-<arch>.flatpak` + `SHA256SUMS.txt`.

```bash
flatpak install --user --bundle flatpak/dist/deUrge-*.flatpak
flatpak run org.deurge.DeUrge
flatpak info --user --show-permissions org.deurge.DeUrge   # audit the sandbox
```

### Sandbox permissions (deliberately minimal)

```
Shared: ipc
Sockets: wayland, fallback-x11
Devices: dri
Filesystems: xdg-download:rw
```

No `--share=network` and no `--filesystem=home`: the app cannot reach the
network and its database stays inside `~/.var/app/org.deurge.DeUrge/`. The only
host filesystem access is the Downloads folder, for user-initiated JSON/CSV
exports and database backups. The only session-bus name is
`org.freedesktop.Notifications` (local reminders).

### Known limitations

* **Architecture**: the bundle is built for the host architecture (`x86_64`
  here). Cross-arch Flatpaks need a matching Tauri build; CI builds x86_64 only.
* **Runtime pinning**: `org.gnome.Platform//48` is the runtime that ships
  WebKitGTK 4.1; when bumping it, update `runtime-version` in
  `flatpak/org.deurge.DeUrge.yml` and `RUNTIME_VERSION` in `flatpak/build.sh`
  together (the Tauri binary must link the runtime's
  `libwebkit2gtk-4.1.so.0`).
* **AppStream workaround**: some distributions ship `appstreamcli` linked
  against libvips without JPEG-XL, which makes `appstreamcli compose` fail with
  `media-worker-error`. `flatpak/build.sh` detects this, retries the compose
  step through the AppStream shipped in `org.gnome.Sdk//48`, and logs the retry
  in `flatpak/build/flatpak-builder.log`. CI installs a working `appstream` and
  does not need the shim.
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
node scripts/gen-icons.mjs desktop   # Tauri icons (32/128/256/1024, .ico, .icns)
node scripts/gen-icons.mjs android   # adaptive/legacy launcher + splash PNGs
node scripts/gen-icons.mjs ios       # 1024 AppIcon + 2732 splash images

# Canonical Tauri icon set (always produces the RGBA PNGs Tauri requires):
pnpm --filter @deurge/desktop exec tauri icon ../web/public/icons/icon-1024.png
```

> Tauri rejects icon PNGs without an alpha channel (`icon … is not RGBA`).
> After regenerating icons, verify with `file apps/desktop/src-tauri/icons/32x32.png`
> (must say `RGBA`) or simply re-run the `tauri icon` command above.

| Output | Consumer |
| --- | --- |
| `apps/web/public/icons/icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon-180.png`, `apps/web/public/favicon-32.png` | PWA manifest / `index.html` |
| `apps/desktop/src-tauri/icons/**` (RGBA PNGs, `icon.ico`, `icon.icns`) | Tauri bundles + Flatpak |
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

* Toolchain versions are pinned: `packageManager: pnpm@10.15.0`, Tauri CLI
  `2.12.4`, the Rust `tauri` crate resolved by the committed
  `apps/desktop/src-tauri/Cargo.lock`, Capacitor `8.6.0`, AGP `8.13.0`, Gradle
  `8.14.3` (wrapper), `pnpm-lock.yaml` committed; CI installs with
  `--frozen-lockfile` and builds the Rust side with `--locked`.
* Icons, desktop files, Flatpak manifest, `Cargo.lock`, capabilities, desktop
  files and native project files are committed, so packaging does not depend on
  local image tooling or machine paths. Machine
  paths (`local.properties`, `JAVA_HOME`, `ANDROID_HOME`, signing files) are
  git-ignored or environment variables.
* The same inputs produce the same *content* on every machine. Byte-identical
  artifacts are not guaranteed (AppImage/deb/rpm/NSIS/dmg metadata timestamps
  differ); therefore every release publishes `SHA256SUMS.txt` next to the
  binaries so any artifact can be verified against the recorded hash.
* CI uses Node 22 + pnpm 10.15.0 everywhere; keep local versions aligned to
  reproduce CI failures.

---

## 10. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `JAVA_HOME is not set` / wrong Java version | Point `JAVA_HOME` at JDK 21; `java -version` must report 21. |
| `Android SDK not found` | Set `ANDROID_HOME` or create the git-ignored `apps/mobile/android/local.properties` with `sdk.dir=…`. |
| `sdkmanager: command not found` | Install `cmdline-tools;latest` in the SDK, or use Android Studio's SDK manager; CI uses `android-actions/setup-android`. |
| `tauri: command not found` | Run `pnpm install` (the CLI is a devDependency of `apps/desktop`) and use the pnpm scripts, not a global `tauri`. |
| `error: failed to run custom build command for …` (webkit2gtk-sys / glib-sys) | Install the Tauri Linux libraries from §1 (pkg-config must find `webkit2gtk-4.1`, `gtk+-3.0`, `libsoup-3.0`). |
| `icon … is not RGBA` at `generate_context!` | Regenerate the Tauri icon set (all PNGs must have an alpha channel), see §7. |
| Blank/white Tauri window | Build the web app first (`pnpm --filter @deurge/web build`) — `frontendDist` embeds it at compile time; after changing the web bundle re-run `tauri build`. Check the WebView inspector (debug builds) for CSP errors. |
| Rust release build is slow the first time | Normal: ~2–5 min for the Tauri/Wry dependency graph with LTO. CI caches `target/` via `Swatinem/rust-cache`. |
| `cargo build` fails with `Unsupported class file` / linker errors | The Tauri Linux prerequisites (build-essential, pkg-config, webkit2gtk-4.1-dev) are missing; the macOS/Windows runners build natively in CI. |
| `flatpak` runs the old Electron build | Uninstall the previous bundle first: `flatpak uninstall --user org.deurge.DeUrge`, then install the new `.flatpak`. |
| `cap sync` says web assets missing | Run `pnpm --filter @deurge/web build` first (or use the `sync:android`/`sync:ios` scripts, which do it for you). |
| Flatpak `appstreamcli compose failed … media-worker-error` | See §6: `build.sh` retries with the SDK's AppStream automatically. |
| Flatpak `Refspec … not found` | Old flatpak-builder default branch; `build.sh` passes `--default-branch=stable`. Use the provided script. |
| iOS `xcodebuild` can't resolve Capacitor packages | First `cap sync ios` needs network for the `capacitor-swift-pm` package; then SPM caches it. Run `xcodebuild -resolvePackageDependencies` (the build script does). |
| `pnpm audit:privacy` fails on a new dependency | Do not add analytics/remote assets. Inspect the reported file and remove the offending import; report it as a privacy regression. |

---

## 11. What CI runs

| Workflow | Trigger | Result |
| --- | --- | --- |
| `ci.yml` | push/PR | typecheck, unit tests, web build, privacy audit, Tauri release binary build + WebKitGTK linkage check, Rust command tests |
| `android.yml` | push/PR (app paths), tags, manual | debug APK, or signed APK+AAB when secrets are configured |
| `flatpak.yml` | push/PR (flatpak/desktop paths), tags, manual | `deUrge-<version>-<arch>.flatpak` |
| `desktop-linux.yml` | push/PR, tags | AppImage + deb + rpm (Tauri) |
| `desktop-windows.yml` | push/PR, tags | NSIS installer + MSI (Tauri) |
| `desktop-macos.yml` | push/PR, tags | DMG (Tauri, unsigned) |
| `ios.yml` | push/PR (ios paths), tags | unsigned simulator app + unsigned `.xcarchive` |
| `release.yml` | tag `v*` | builds everything, writes `SHA256SUMS.txt`, creates a **draft** GitHub release |

See [RELEASING.md](RELEASING.md) for the release procedure itself.
