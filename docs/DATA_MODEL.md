# deUrge — Data model and database schema

Storage: **SQLite** (via sql.js WebAssembly) with foreign keys enabled,
CHECK constraints, a migration table and one open session per tracker enforced
by a partial unique index. All timestamps are UTC epoch milliseconds
(`INTEGER`). IDs are UUID v4 strings.

Schema version: **2** (see `packages/core/src/db/migrations.ts`).

## Entity relationship overview

```
trackers ──< tracker_sessions
        ├──< lapse_events
        ├──< urge_events
        ├──< check_ins
        └──< journal_entries (nullable tracker)

custom_categories (kind = trigger | reason)
        └── referenced by lapse/urge `trigger_category_id`

history_events — append-only timeline referencing trackers and record ids
application_settings — key/value JSON settings
meta — internal key/value metadata
schema_migrations — applied migration versions
```

## Tables

### `trackers`
| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | UUID v4 |
| `name` | TEXT NOT NULL | trimmed, 1–120 chars (validated) |
| `description` | TEXT | optional |
| `status` | TEXT | `active` \| `paused` \| `archived` |
| `started_at` | INTEGER | original commitment start (backdatable) |
| `started_time_zone` | TEXT | IANA zone used at entry |
| `started_utc_offset_minutes` | INTEGER | offset at that instant |
| `created_at`, `updated_at` | INTEGER | record timestamps |
| `archived_at` | INTEGER | null unless archived |
| `notes`, `reasons` | TEXT | optional personal notes/reasons |
| `reminder_enabled` | INTEGER | 0/1 |
| `reminder_interval_minutes` | INTEGER | ≥ 60 or null |

### `tracker_sessions`
Half-open active intervals. `ended_at IS NULL` = running. Partial unique index
`ux_sessions_open` ensures at most one open session per tracker. `start_kind`
is `created` \| `resumed` \| `imported` \| `restored`.

### `lapse_events`
Instantaneous events: `occurred_at`, recorded `occurred_time_zone` /
`occurred_utc_offset_minutes`, `created_at`, `updated_at`, optional `reason`,
`trigger`, `trigger_category_id`, `description`, `notes`, `context`, and
`retrospective` (0/1). The tracked behaviour's current streak ends here; prior
progress is never removed.

### `urge_events`
Separate from lapses and never affects streak math: `intensity` 1–10,
`duration_seconds` (optional), trigger/context/notes, `outcome`
(`passed` \| `lapse` \| `unknown`), `retrospective`.

### `journal_entries`
Free writing. `tracker_id` is nullable (global journal) and becomes NULL if the
tracker is permanently deleted — the writing survives. `title` optional,
`body` required.

### `check_ins`
Lightweight check-in attached to a tracker: optional `note`, optional `mood`
1–5. Appears in the activity log.

### `custom_categories`
Only the trigger and reason lists used by the record sheet: `kind` ∈
`trigger` \| `reason`; unique `(kind, name)`; `is_default` flags the seeded
entries (which may be archived but not deleted); `archived` hides them from
pickers without touching history. Deleting a custom entry nulls references but
leaves the plain-text trigger on historic events, so old records remain
readable. (Schema v1 also had `tracker_category` rows for the removed tracker
category feature; migration 2 deletes them.)

### `application_settings`
Key/value rows with JSON values (`theme`, date/time formats, first day of week,
timezone mode, duration format, notification settings, export preference,
default trigger categories, last export/backup metadata, onboarding flag).
Unknown keys are preserved on save so future versions can extend settings.

### `history_events`
Append-only activity log: `tracker_id` (nullable for global events), `type`
(creation, start, update, pause, resume, archive, restore, delete, lapse/urge/
journal/check-in create/update/delete, category/settings changes, imports/
exports), `occurred_at` (when it really happened), `created_at` (when it was
recorded), `ref_id` (underlying record id) and non-sensitive `metadata` JSON.
Deleting a lapse/urge/journal entry writes a `*_deleted` history row before
removing the payload; deleting a tracker writes a global `tracker_deleted` row
that survives the cascade.

### `schema_migrations`
Applied migration versions (`version`, `name`, `applied_at`). Migrations are
append-only and applied in order inside transactions.

### `meta`
Internal key/value metadata (database identity/format hints, and local-only
app-lock state under `security.*`: PBKDF2 password hash, salt, iteration count
and the biometric preference). `meta` is deliberately **not** part of JSON
backups, so app-lock credentials never leave the device and a restored database
gets a fresh password.

## Invariants

1. All timestamps are finite integers in UTC ms; the earliest accepted value is
   2000-01-01 and future values are rejected beyond a 5-minute tolerance.
2. Lapse/urge/check-in `occurred_at` ≥ their tracker's `started_at` (services
   validate; the engine ignores impossible lapses defensively).
3. At most one open session per tracker; sessions do not overlap after
   normalisation.
4. Foreign keys are enabled; tracker deletion cascades to sessions/events and
   tracker-scoped history, while journal entries/check-ins are detached.
5. Derived statistics are never stored as the sole source of truth; everything
   is recomputable from raw records.
6. History events are written in the same transaction as the change they
   describe.
7. Updates never silently drop user data. The only destructive operation is an
   explicitly confirmed permanent tracker delete or a confirmed replace
   import, and both take a backup snapshot first where the platform supports it.

## Migrations

`MIGRATIONS` is an ordered array. On open, the database connection:

1. creates `schema_migrations` if needed,
2. reads applied versions,
3. disables foreign-key enforcement for the duration of the run (SQLite cannot
   change `PRAGMA foreign_keys` inside a transaction, and table rebuilds must
   not cascade-delete child rows when the old table is dropped),
4. applies each pending migration inside its own transaction and records it,
5. re-enables foreign-key enforcement and verifies `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check` before the database is used.

Future versions append new entries; shipped migrations are never edited.

### Migration 2 — remove the tracker-category feature

- Rebuilds `trackers` without `category_id` (new table, copy every other
  column, drop old table, rename, recreate `idx_trackers_status`).
- Deletes `custom_categories` rows with `kind = 'tracker_category'` and rebuilds
  the table with `CHECK (kind IN ('trigger','reason'))`, preserving all other
  rows, ids and timestamps.
- Runs for fresh databases too (they apply migration 1 then migration 2), and is
  recorded in `schema_migrations` so it never runs twice.

Export format versioning is separate (`schemaVersion` in the JSON export) and
older exports are migrated by the import pipeline before validation.
