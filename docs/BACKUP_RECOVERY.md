# deUrge — Backup, export, import and recovery

Your data belongs to you. deUrge provides plain JSON, encrypted JSON, and CSV
exports, plus a transactional import pipeline with duplicate detection and
explicit merge/replace semantics.

## 1. JSON export (canonical backup)

`Data & Backups → Export JSON` produces a single file, e.g.
`deurge-export-2026-11-10T014500Z.json`:

```json
{
  "format": "deurge-export",
  "formatVersion": 1,
  "schemaVersion": 2,
  "appVersion": "1.0.0",
  "exportedAt": 1794357900000,
  "timeZone": "Asia/Dhaka",
  "counts": { "trackers": 3, "lapses": 3, "urges": 9, "...": 0 },
  "data": {
    "trackers": [], "sessions": [], "lapses": [], "urges": [],
    "journalEntries": [], "checkIns": [], "categories": [],
    "settings": {}, "settingsRows": [], "historyEvents": []
  },
  "integrity": { "algorithm": "SHA-256", "hash": "…" }
}
```

- IDs, timestamps and relationships are preserved exactly.
- `schemaVersion` allows future versions to migrate older backups. It is `2` in
  this release; schema-v1 backups (which still contain tracker categories) are
  upconverted during import.
- `integrity.hash` is SHA-256 over the canonical JSON of `data`. If present, it
  is verified before import.
- The export is sufficient to reconstruct the application state on any
  supported platform.

## 2. Encrypted backup

`Export encrypted backup` asks for a password (minimum 8 characters) and writes
a `deurge-backup-<timestamp>.deurge-backup` file:

```json
{
  "format": "deurge-encrypted-backup",
  "version": 1,
  "createdAt": 1794357900000,
  "appVersion": "1.0.0",
  "schemaVersion": 2,
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 310000, "salt": "…base64…" },
  "cipher": { "name": "AES-GCM", "iv": "…base64…" },
  "payload": "…base64 ciphertext of the UTF-8 JSON export…"
}
```

- Encryption: WebCrypto AES-GCM 256, PBKDF2-SHA-256, 310,000 iterations,
  random salt and IV. No custom cryptography.
- The password is never stored. There is no password recovery.
- A wrong password or tampered payload fails with a clear error.
- Encrypted backups are unreadable without the password, unlike JSON exports.

## 3. CSV exports

Available datasets (RFC 4180, UTF-8, CRLF line endings, ISO-8601 UTC
timestamps plus local-time columns):

- `trackers` — id, name, status, timestamps, notes/reasons.
- `lapses` — id, tracker, occurred UTC/local, trigger, reason, context, notes,
  retrospective.
- `urges` — id, tracker, occurred UTC/local, intensity, duration, trigger,
  outcome, notes.
- `journal` — id, tracker, occurred UTC/local, title, body.
- `daily-summary` — per local day: active time, abstinent time, lapses, urges,
  journal entries.
- `statistics` — per tracker metric snapshot (current/longest/accumulated/
  elapsed/lapses/urges/average/median/shares) with explicit column names.

CSV is intended for spreadsheets/analysis; JSON is the backup format.

## 4. Import

1. Choose a `.json` or `.deurge-backup` file.
2. deUrge validates: file structure, format identifier, `schemaVersion`
   (migrating older versions when supported), per-record types/enums/limits,
   ID uniqueness, timestamps, and relationships (sessions/lapses/urges must
   reference existing or newly imported trackers; trigger/reason references
   must resolve or are dropped to text-only values). Integrity hash is checked
   when present, against the original (pre-migration) data.
3. A preview shows format, app version, export time, timezone and counts.
4. Choose a mode:
   - **Merge** — inserts new records, keeps existing ones. Duplicate IDs that
     are identical are skipped. IDs that exist with *different* content are
     reported as conflicts:
     - default: **Skip** conflicting incoming records (never overwrite).
     - optional: **Keep both** — the conflicting incoming records get new IDs
       and all child references/references are remapped so relationships stay
       intact.
   - **Replace** — replaces all local data with the imported data. Requires
     explicit typed confirmation. A pre-import snapshot is written through the
     platform persistence adapter (and the UI recommends exporting a backup
     first). The wipe+insert runs in a single SQLite transaction; any failure
     rolls back, leaving the existing database intact.
5. The import report lists imported counts per collection, skipped duplicates,
   conflicts, re-keyed records and warnings. Invalid or corrupted files are
   rejected before any write; no partial import is ever committed.

### Older backups (schema version 1)

Schema v1 was written by releases that still had the tracker-category feature.
Import upconverts it in memory before validation: `categoryId` is removed from
every tracker and `custom_categories` rows of kind `tracker_category` are
discarded. Everything else — ids, timestamps, sessions, lapses, urges, journal
entries, check-ins, history and trigger/reason lists — is preserved exactly. The
import report includes a warning that the backup was upgraded and that tracker
categories were removed; the integrity hash (when present) is verified against
the original v1 data. Merge/replace semantics and rollback behaviour are the
same as for a current backup.

## 5. Integrity and recovery

| Situation | What to do |
| --- | --- |
| Web browser data cleared | Re-import your latest JSON/encrypted backup. |
| App reinstalled / device changed | Install deUrge, skip onboarding, open **Data & Backups → Import**, choose your backup. |
| Import fails validation | The local database was not modified. The report names the offending collection/record without exposing unrelated personal data. |
| Local database fails the integrity check at startup | deUrge refuses to silently start empty, shows a recovery screen, and asks you to restore a backup. |
| Tauri/desktop database file corrupted | Restore `deurge.db` from the app data directory's `backups/` folder or re-import an export. |
| Forgot encrypted-backup password | Not recoverable by design. Use a plain JSON export if you have one. |

### Platform locations

- Web/PWA: IndexedDB `deurge-local`; clearing site data deletes it.
- Android/iOS: app-private `deurge.sqlite`; uninstalling deletes it.
- Tauri desktop: the app data directory (`~/.local/share/app.deurge.DeUrge/`
  on Linux, `%APPDATA%/app.deurge.DeUrge/` on Windows,
  `~/Library/Application Support/app.deurge.DeUrge/` on macOS) with
  `deurge.db`, `deurge.backup.db` and `backups/`.
- Flatpak: the sandboxed app data directory under
  `~/.var/app/org.deurge.DeUrge/`.

## 6. Data ownership

No external service is involved in export, import, backup or restore. The files
are written using the operating system's native file handling and remain under
your control.
