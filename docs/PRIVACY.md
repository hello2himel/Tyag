# Tyag: Privacy and local-only architecture

Tyag is local-first by design. There is no account, no server, no cloud
service, no advertising, no telemetry, no crash reporting, no third-party
analytics and no external AI service. The application is fully functional in
airplane mode after installation/first load.

## What Tyag never does

- Never requires an account, email, phone number or sign-in.
- Never makes background network requests with personal information.
- Never uploads, synchronises or mirrors the database.
- Never includes advertising, tracking pixels, analytics SDKs or crash
  reporters.
- Never loads remote scripts, fonts, images, styles or configuration.
- Never sends push notifications through a remote service.
- Never uses a cloud AI/model for insights. Insights are deterministic rules
  evaluated locally.
- Never implements custom cryptography. Encrypted backups use WebCrypto:
  AES-GCM 256 with PBKDF2-SHA-256 (310,000 iterations, random 16-byte salt).

## Where data lives

| Platform | Live database | Backups / exports |
| --- | --- | --- |
| Web / PWA | IndexedDB database `tyag-local` (plus a rolling backup copy). Service worker cache holds only the app bundle. | Files you download (`tyag-*.json`, `.csv`, `.tyag-backup`) |
| Android / iOS | App-private storage via Capacitor Filesystem: `tyag.sqlite` (and `tyag.backup.sqlite`) in the app's data directory | Files you export via the system file picker / Documents |
| Windows / macOS / Linux (Tauri) | App data directory: `tyag.db` (Linux: `~/.local/share/app.tyag.Tyag/`, macOS: `~/Library/Application Support/app.tyag.Tyag/`, Windows: `%APPDATA%/app.tyag.Tyag/`) with rolling backups under `backups/` | Files you export to Downloads |
| Linux Flatpak | Inside the Flatpak sandbox under `~/.var/app/org.tyag.Tyag/data/` | Files you export to `xdg-download` |

The app requests only the sandbox permissions it needs. In particular, the
Flatpak manifest does **not** request network access.

## The network

- The web build contains no remote URLs. A strict Content-Security-Policy is
  applied in `index.html` and in Netlify headers:
  `default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'`
  (the `wasm-unsafe-eval` allowance is required to instantiate SQLite's
  WebAssembly module from the locally bundled file).
- No runtime caching of third-party resources: the service worker precaches
  only files from the local build.
- `scripts/audit-privacy.mjs` scans the production build and fails if it finds
  external hosts, remote assets, sockets, beacons or known third-party SDKs.
- The dependency list is small and reviewed (see [DEPENDENCIES.md](DEPENDENCIES.md));
  none of the runtime dependencies includes networking or telemetry code.
- Tauri: the desktop shell links only the three database commands (and a
  text-export command); no filesystem, shell, HTTP, opener or updater plugin is
  registered. Capabilities are minimal, external navigation/popups are denied,
  the CSP mirrors the web app, and no auto-updater or analytics is included.
- Capacitor: the WebView loads only the bundled app over `https://localhost`;
  no server URL is configured and no cloud plugin is installed.

Verification is not based on "it looked quiet in the network tab". The build is
audited statically, the app is tested offline, and the only runtime bridges are
local file/notification APIs.

## Notifications (optional, off by default)

- Web/PWA: uses the browser's local Notification API **only while the app is
  open**. There is no push service and therefore no cloud dependency.
- Android/iOS: uses Capacitor LocalNotifications to schedule on-device
  reminders. No push token, no remote service.
- Notifications never contain milestone claims; they repeat the dynamically
  calculated progress acknowledgement or a simple "your progress continues".
  The user can disable them at any time.

## Security and threat model

Protected:

- Data stays within the app's sandbox / browser origin and is never transmitted.
- Exported encrypted backups are confidential without the password (AES-GCM,
  authenticated encryption; a wrong password fails loudly).
- The app's CSP and Tauri/Capacitor hardening reduce remote-code injection
  risk.

Not protected by Tyag itself:

- An unlocked, compromised or rooted device (OS-level malware, screen capture).
  Use the operating system's disk encryption and device lock.
- The live database is not application-level encrypted; the app lock gates
  access to the app, not to the SQLite file. Rely on OS full-disk encryption and
  app-private storage (and do not root/jailbreak the device or share app
  backups). Encrypt exported backups if you store them elsewhere.
- Browser/PWA storage can be cleared by the user or by "clear site data"
  actions; keep exported backups.

## User control

- Export a complete JSON backup at any time from **Data & Backups**.
- Export CSV datasets for spreadsheets/analysis.
- Create password-protected encrypted backups.
- Import a backup with merge or replace semantics; replace requires explicit
  confirmation and takes a pre-import snapshot where the platform supports it.
- Permanently delete a tracker (with confirmation). Journal writing is kept and
  detached. Uninstalling the app or clearing site data removes local storage.

There is no hidden copy of your data anywhere else.
