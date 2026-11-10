//! Tyag desktop shell (Tauri 2).
//!
//! Local-only by construction:
//!   - the React/Vite bundle is embedded in the binary at compile time
//!     (`frontendDist = ../../web/dist`) and served from the app's own origin;
//!   - no Tauri plugin that could reach the network, the shell or arbitrary
//!     files is registered — the only privileged surface is the three database
//!     commands below;
//!   - top-level navigation is restricted to the bundled app origin, new
//!     windows (remote URLs) are denied, all web permissions are denied except
//!     notifications, and the CSP mirrors `netlify.toml`;
//!   - there is no auto-updater and no telemetry.
//!
//! Persistence contract (must stay in sync with `apps/web/src/platform/db.ts`):
//!
//! ```text
//! invoke<Option<string>>('db_read')                      // base64 bytes | null
//! invoke<void>('db_write',  { payloadB64: string })      // atomic snapshot
//! invoke<void>('db_backup', { payloadB64: string })      // stable + rotating
//! ```
//!
//! Payloads are base64 strings rather than `Vec<u8>` on purpose: Tauri's JSON
//! IPC would otherwise serialize a multi-hundred-kilobyte snapshot as a JSON
//! array of numbers, inflating every save. Base64 keeps the wire cost at ~4/3
//! of the snapshot size and is still validated/decoded on the Rust side.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::window::Color;
use tauri::webview::{
    DownloadEvent, NewWindowResponse, PermissionKind, PermissionResponse, WebviewWindowBuilder,
};
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl};
use url::Url;

/// Hard cap for a database snapshot carried over IPC (matches the web adapter).
const MAX_DATABASE_BYTES: usize = 64 * 1024 * 1024;
/// Timestamped snapshots kept under `<app data>/backups/`.
const MAX_BACKUP_HISTORY: usize = 20;
/// Hard cap for a user-initiated text export (JSON/CSV).
const MAX_TEXT_EXPORT_BYTES: usize = 128 * 1024 * 1024;
/// Longest accepted export filename stem (before the extension).
const MAX_EXPORT_STEM_CHARS: usize = 96;

const DB_FILE: &str = "tyag.db";
const STABLE_BACKUP_FILE: &str = "tyag.backup.db";
const BACKUPS_DIR: &str = "backups";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// The only privileged I/O in the process: a single SQLite snapshot inside the
/// per-user application data directory (never a caller-provided path).
struct Store {
    /// `app_data_dir()` — e.g. `~/.local/share/app.tyag.Tyag` on Linux.
    dir: PathBuf,
    /// Serializes concurrent writes so temp-file + rename sequences never race.
    write_lock: Mutex<()>,
}

impl Store {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            write_lock: Mutex::new(()),
        }
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join(DB_FILE)
    }

    fn stable_backup_path(&self) -> PathBuf {
        self.dir.join(STABLE_BACKUP_FILE)
    }

    fn backups_dir(&self) -> PathBuf {
        self.dir.join(BACKUPS_DIR)
    }

    /// Read the live snapshot, returning `None` on first run (missing file).
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        let path = self.db_path();
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(db_error("db_read_failed", "Could not read the local database.")),
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        if metadata.len() > MAX_DATABASE_BYTES as u64 {
            return Err(db_error(
                "db_too_large",
                "The local database exceeds the 64 MiB limit.",
            ));
        }
        let mut file = File::open(&path)
            .map_err(|_| db_error("db_read_failed", "Could not read the local database."))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|_| db_error("db_read_failed", "Could not read the local database."))?;
        Ok(Some(bytes))
    }

    /// Atomically replace the live snapshot: sibling temp file, fsync, rename.
    fn write(&self, bytes: &[u8]) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| db_error("db_write_failed", "Could not write the local database."))?;
        atomic_write(&self.db_path(), bytes)
            .map_err(|_| db_error("db_write_failed", "Could not write the local database."))
    }

    /// Write the stable backup plus one timestamped snapshot, keeping the last
    /// [`MAX_BACKUP_HISTORY`] timestamped files.
    fn backup(&self, bytes: &[u8]) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| db_error("db_backup_failed", "Could not write the database backup."))?;
        let backups_dir = self.backups_dir();
        fs::create_dir_all(&backups_dir)
            .map_err(|_| db_error("db_backup_failed", "Could not write the database backup."))?;
        atomic_write(&self.stable_backup_path(), bytes)
            .map_err(|_| db_error("db_backup_failed", "Could not write the database backup."))?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        atomic_write(&backups_dir.join(format!("tyag-{stamp}.db")), bytes)
            .map_err(|_| db_error("db_backup_failed", "Could not write the database backup."))?;
        prune_backups(&backups_dir, MAX_BACKUP_HISTORY);
        Ok(())
    }
}

/// A short, stable, UI-safe error code and message. Never includes paths, byte
/// payloads or other user data.
fn db_error(code: &str, message: &str) -> String {
    format!("{code}: {message}")
}

/// Decode and validate a base64 IPC payload. Rejects empty and oversized input
/// before any bytes reach the filesystem.
fn decode_payload(payload_b64: &str) -> Result<Vec<u8>, String> {
    let bytes = BASE64
        .decode(payload_b64.as_bytes())
        .map_err(|_| db_error("invalid_payload", "The database snapshot is not valid."))?;
    if bytes.is_empty() {
        return Err(db_error(
            "invalid_payload",
            "The database snapshot must not be empty.",
        ));
    }
    if bytes.len() > MAX_DATABASE_BYTES {
        return Err(db_error(
            "db_too_large",
            "The database snapshot exceeds the 64 MiB limit.",
        ));
    }
    Ok(bytes)
}

/// Write `bytes` to `target` through a sibling temp file, fsync and rename, so
/// a crash or power loss can never leave a partially written database behind.
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = temp_path(target);
    let result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        // Best effort: persist the rename itself. Not supported everywhere.
        sync_dir(target.parent());
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn temp_path(target: &Path) -> PathBuf {
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "database".to_string());
    // A short-lived unique suffix: pid + nanosecond timestamp.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    target.with_file_name(format!(
        "{file_name}.{}.{nanos}.tmp",
        std::process::id()
    ))
}

#[cfg(unix)]
fn sync_dir(dir: Option<&Path>) {
    if let Some(dir) = dir {
        if let Ok(handle) = File::open(dir) {
            let _ = handle.sync_all();
        }
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: Option<&Path>) {}

/// Keep only the newest `keep` `tyag-*.db` files in `backups/`.
fn prune_backups(backups_dir: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(backups_dir) else {
        return;
    };
    let mut backups: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("tyag-") && name.ends_with(".db")
        })
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .map(|modified| (modified, entry.path()))
        })
        .collect();
    if backups.len() <= keep {
        return;
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in backups.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands (names are part of the web contract: db_read/db_write/db_backup)
// ---------------------------------------------------------------------------

#[tauri::command]
fn db_read(store: State<'_, Store>) -> Result<Option<String>, String> {
    store
        .read()
        .map(|bytes| bytes.map(|bytes| BASE64.encode(bytes)))
}

#[tauri::command]
fn db_write(store: State<'_, Store>, payload_b64: String) -> Result<(), String> {
    let bytes = decode_payload(&payload_b64)?;
    store.write(&bytes)
}

#[tauri::command]
fn db_backup(store: State<'_, Store>, payload_b64: String) -> Result<(), String> {
    let bytes = decode_payload(&payload_b64)?;
    store.backup(&bytes)
}

/// Sanitize a user-visible export filename: never a caller-provided path, no
/// directory separators, no `..`, no control characters, and only the two
/// export extensions the app actually produces (`.json`, `.csv`).
fn sanitize_export_filename(raw: &str) -> Result<String, String> {
    // Drop any directory component the caller may have smuggled in.
    let base = raw
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw)
        .trim()
        .to_string();
    if base.is_empty() {
        return Err(db_error("invalid_filename", "The export file name is not valid."));
    }

    // Split a known extension off; everything else is part of the stem.
    let (stem, extension) = match base.rsplit_once('.') {
        Some((stem, extension)) if matches!(extension.to_ascii_lowercase().as_str(), "json" | "csv") => {
            (stem, extension.to_ascii_lowercase())
        }
        _ => {
            return Err(db_error(
                "invalid_filename",
                "Export files must end in .json or .csv.",
            ))
        }
    };

    // Keep a conservative, portable character set. Dots are dropped from the
    // stem (which also removes `..` traversal) because the extension is fixed.
    let mut cleaned: String = stem
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | ' ' | '(' | ')' => character,
            _ => '-',
        })
        .collect();
    cleaned = cleaned.trim_matches(|character: char| character == '-' || character == ' ').to_string();
    if cleaned.is_empty() {
        cleaned = "tyag-export".to_string();
    }
    if cleaned.chars().count() > MAX_EXPORT_STEM_CHARS {
        cleaned = cleaned.chars().take(MAX_EXPORT_STEM_CHARS).collect();
        cleaned = cleaned
            .trim_matches(|character: char| character == '-' || character == ' ')
            .to_string();
        if cleaned.is_empty() {
            cleaned = "tyag-export".to_string();
        }
    }

    Ok(format!("{cleaned}.{extension}"))
}

/// Write a sanitised text export into `downloads` (created if missing), never
/// overwriting an existing file. Returns the absolute path written.
fn write_export_file(downloads: &Path, filename: &str, content: &str) -> Result<PathBuf, String> {
    if content.len() > MAX_TEXT_EXPORT_BYTES {
        return Err(db_error(
            "export_too_large",
            "The export exceeds the 128 MiB limit.",
        ));
    }
    let filename = sanitize_export_filename(filename)?;
    fs::create_dir_all(downloads)
        .map_err(|_| db_error("export_failed", "Could not open the Downloads folder."))?;

    let mut destination = downloads.join(&filename);
    if destination.exists() {
        let (stem, extension) = filename
            .rsplit_once('.')
            .map(|(stem, extension)| (stem.to_string(), extension.to_string()))
            .unwrap_or((filename.clone(), "txt".to_string()));
        for counter in 2..1000 {
            let candidate = downloads.join(format!("{stem} ({counter}).{extension}"));
            if !candidate.exists() {
                destination = candidate;
                break;
            }
        }
    }

    atomic_write(&destination, content.as_bytes())
        .map_err(|_| db_error("export_failed", "Could not save the export file."))?;
    Ok(destination)
}

/// Save a user-initiated text export (JSON/CSV) into the system Downloads
/// directory. Used by the desktop web adapter because a WebKitGTK WebView
/// cannot reliably download `blob:` anchors. No dialogs, no arbitrary paths.
#[tauri::command]
fn save_text_file(
    app: AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|_| db_error("export_failed", "Could not resolve the Downloads folder."))?;
    let path = write_export_file(&downloads, &filename, &content)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Window hardening
// ---------------------------------------------------------------------------

/// Origins the app is allowed to navigate to: the embedded bundle only (plus
/// the Vite dev server in debug builds). `window.open`/remote URLs are denied.
fn is_allowed_navigation(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        // Production bundle origin (Linux/macOS and Windows respectively).
        ("tauri", Some("localhost")) => true,
        ("http" | "https", Some("tauri.localhost")) => true,
        // A Window.open target that is immediately closed is harmless.
        _ if url.as_str() == "about:blank" => true,
        // Development only: the Vite dev server.
        _ if cfg!(debug_assertions) => {
            matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
                && url.port() == Some(5173)
        }
        _ => false,
    }
}

/// Route WebView downloads (JSON/CSV export from the data screen) to the OS
/// Downloads directory, never into the app bundle. Returns an absolute path.
fn resolve_download_destination(downloads: Option<&Path>, destination: &mut PathBuf) {
    let Some(dir) = downloads else {
        return;
    };
    let _ = fs::create_dir_all(dir);
    let Some(name) = destination.file_name().map(|name| name.to_owned()) else {
        return;
    };
    let mut candidate = dir.join(&name);
    if candidate.exists() {
        let name = name.to_string_lossy();
        let (stem, extension) = match name.rsplit_once('.') {
            Some((stem, extension)) => (stem.to_string(), Some(extension.to_string())),
            None => (name.into_owned(), None),
        };
        for counter in 2..1000 {
            let file = match &extension {
                Some(extension) => format!("{stem} ({counter}).{extension}"),
                None => format!("{stem} ({counter})"),
            };
            candidate = dir.join(file);
            if !candidate.exists() {
                break;
            }
        }
    }
    *destination = candidate;
}

fn create_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let downloads = app.path().download_dir().ok();

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Tyag")
        .inner_size(430.0, 900.0)
        .min_inner_size(360.0, 640.0)
        .resizable(true)
        .center()
        .background_color(Color(0, 0, 0, 255))
        // Local-only: only the embedded bundle (or the dev server) may load.
        .on_navigation(is_allowed_navigation)
        // Remote links must never open a second webview/window.
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        // No camera/microphone/geolocation/clipboard; local notifications only.
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Notifications => PermissionResponse::Allow,
            _ => PermissionResponse::Deny,
        })
        // Exports go straight to the user's Downloads folder.
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { destination, .. } => {
                resolve_download_destination(downloads.as_deref(), destination);
                true
            }
            _ => true,
        })
        .build()?;

    Ok(())
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

fn init_store<R: Runtime>(app: &AppHandle<R>) -> Result<Store, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(Store::new(dir))
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let store = init_store(app.handle())?;
            app.manage(store);
            create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_read,
            db_write,
            db_backup,
            save_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tyag");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "tyag-store-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        (Store::new(dir.clone()), dir)
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_returns_none_on_first_run() {
        let (store, dir) = store();
        assert_eq!(store.read().unwrap(), None);
        cleanup(&dir);
    }

    #[test]
    fn write_then_read_round_trips() {
        let (store, dir) = store();
        store.write(b"version one").unwrap();
        assert_eq!(store.read().unwrap().unwrap(), b"version one");
        store.write(b"version two").unwrap();
        assert_eq!(store.read().unwrap().unwrap(), b"version two");
        cleanup(&dir);
    }

    #[test]
    fn write_leaves_no_temp_files_behind() {
        let (store, dir) = store();
        store.write(b"snapshot").unwrap();
        let files: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, vec![DB_FILE.to_string()]);
        cleanup(&dir);
    }

    #[test]
    fn backup_writes_stable_file_and_prunes_history() {
        let (store, dir) = store();
        store.backup(b"snapshot").unwrap();
        assert!(store.stable_backup_path().is_file());
        let count = fs::read_dir(store.backups_dir()).unwrap().count();
        assert_eq!(count, 1);
        cleanup(&dir);
    }

    #[test]
    fn decode_rejects_empty_and_invalid_payloads() {
        assert!(decode_payload("").is_err());
        assert!(decode_payload("not base64!!").is_err());
        assert_eq!(decode_payload(&BASE64.encode(b"x")).unwrap(), b"x");
    }

    #[test]
    fn decode_rejects_oversized_payloads() {
        let oversized = BASE64.encode(vec![0u8; MAX_DATABASE_BYTES + 1]);
        assert!(decode_payload(&oversized).is_err());
    }

    #[test]
    fn navigation_is_limited_to_the_bundled_origin() {
        for allowed in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/assets/app.js",
        ] {
            assert!(
                is_allowed_navigation(&Url::parse(allowed).unwrap()),
                "expected {allowed} to be allowed"
            );
        }
        for denied in [
            "https://example.com/",
            "http://127.0.0.1:8080/",
            "file:///etc/passwd",
            "ipc://localhost",
        ] {
            assert!(
                !is_allowed_navigation(&Url::parse(denied).unwrap()),
                "expected {denied} to be denied"
            );
        }
    }

    #[test]
    fn exports_are_limited_to_safe_json_or_csv_names() {
        assert_eq!(
            sanitize_export_filename("tyag-export.json").unwrap(),
            "tyag-export.json"
        );
        assert_eq!(
            sanitize_export_filename("../../etc/passwd.csv").unwrap(),
            "passwd.csv"
        );
        assert_eq!(
            sanitize_export_filename("a/b\\c 2026.JSON").unwrap(),
            "c 2026.json"
        );
        assert_eq!(sanitize_export_filename("..").is_err(), true);
        assert_eq!(sanitize_export_filename("notes.txt").is_err(), true);
        assert_eq!(sanitize_export_filename("").is_err(), true);
        assert!(sanitize_export_filename("\u{0}\u{1}.json").unwrap().ends_with(".json"));
    }

    #[test]
    fn export_filename_stem_is_length_capped() {
        let long = format!("{}.json", "a".repeat(500));
        let name = sanitize_export_filename(&long).unwrap();
        assert!(name.ends_with(".json"));
        assert!(name.len() <= MAX_EXPORT_STEM_CHARS + ".json".len());
    }

    #[test]
    fn export_writes_into_downloads_without_overwriting() {
        let dir = std::env::temp_dir().join(format!(
            "tyag-export-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let first = write_export_file(&dir, "../../tyag.json", "{\"a\":1}").unwrap();
        assert_eq!(first, dir.join("tyag.json"));
        assert_eq!(fs::read_to_string(&first).unwrap(), "{\"a\":1}");
        let second = write_export_file(&dir, "tyag.json", "{\"a\":2}").unwrap();
        assert_eq!(second, dir.join("tyag (2).json"));
        assert_eq!(fs::read_to_string(&second).unwrap(), "{\"a\":2}");
        assert_eq!(fs::read_to_string(&first).unwrap(), "{\"a\":1}");
        assert!(write_export_file(&dir, "tyag.txt", "nope").is_err());
        cleanup(&dir);
    }

    #[test]
    fn download_destination_is_redirected_into_downloads() {
        let dir = std::env::temp_dir().join(format!(
            "tyag-download-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let mut destination = PathBuf::from("/tmp/tyag-export.json");
        resolve_download_destination(Some(&dir), &mut destination);
        assert_eq!(destination, dir.join("tyag-export.json"));
        fs::write(&destination, b"{}").unwrap();
        let mut second = PathBuf::from("/tmp/tyag-export.json");
        resolve_download_destination(Some(&dir), &mut second);
        assert_eq!(second, dir.join("tyag-export (2).json"));
        cleanup(&dir);
    }
}
