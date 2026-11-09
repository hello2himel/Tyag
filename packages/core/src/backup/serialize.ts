/**
 * Canonical JSON serialisation, integrity hashing and export assembly.
 *
 * The integrity hash must be reproducible on another device after the export
 * file has been written, parsed and re-serialised. `JSON.stringify` alone is
 * unsuitable because object key order is insertion order; `canonicalJson`
 * sorts keys recursively, so the same data always hashes to the same digest.
 */
import type { DeUrgeExport, DeUrgeExportData, ExportCounts } from '../domain';
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from '../domain';
import { SCHEMA_VERSION } from '../db/migrations';
import { zonedAt } from '../time/temporal';
import type { AllData } from '../services/data';
import { sha256Hex } from './crypto';

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * Values are already JSON-safe (they come from SQLite rows or validated
 * imports); non-finite numbers are normalised to `null` for robustness.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts = keys
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      return 'null';
  }
}

/** SHA-256 integrity block over canonical JSON of the export data. */
export async function computeIntegrity(
  data: DeUrgeExportData,
): Promise<{ algorithm: 'SHA-256'; hash: string }> {
  return { algorithm: 'SHA-256', hash: await sha256Hex(canonicalJson(data)) };
}

/** Counts for every exported collection (also validated on import). */
export function countExportData(data: DeUrgeExportData): ExportCounts {
  return {
    trackers: data.trackers.length,
    sessions: data.sessions.length,
    lapses: data.lapses.length,
    urges: data.urges.length,
    journalEntries: data.journalEntries.length,
    checkIns: data.checkIns.length,
    categories: data.categories.length,
    settings: data.settingsRows.length,
    historyEvents: data.historyEvents.length,
  };
}

/** Build the portable export object from an already loaded data snapshot. */
export async function buildExport(
  data: AllData,
  meta: { appVersion: string; exportedAt: number; timeZone: string },
): Promise<DeUrgeExport> {
  const exportData: DeUrgeExportData = {
    trackers: data.trackers,
    sessions: data.sessions,
    lapses: data.lapses,
    urges: data.urges,
    journalEntries: data.journalEntries,
    checkIns: data.checkIns,
    categories: data.categories,
    settings: data.settings,
    settingsRows: data.settingsRows,
    historyEvents: data.historyEvents,
  };
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: meta.appVersion,
    exportedAt: meta.exportedAt,
    timeZone: meta.timeZone,
    counts: countExportData(exportData),
    data: exportData,
    integrity: await computeIntegrity(exportData),
  };
}

/** `YYYYMMDD-HHmmss` in the given zone, safe for filenames. */
export function timestampSlug(epochMs: number, timeZone: string): string {
  const zdt = zonedAt(epochMs, timeZone);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${zdt.year}${pad(zdt.month)}${pad(zdt.day)}-${pad(zdt.hour)}${pad(zdt.minute)}${pad(zdt.second)}`;
}

/** Filename for a JSON/CSV/encrypted deliverable (filenames are metadata only). */
export function exportFilename(prefix: string, epochMs: number, timeZone: string, extension: string): string {
  return `${prefix}-${timestampSlug(epochMs, timeZone)}.${extension}`;
}

/** Human summary used in the `data_imported` history event. */
export function summariseCounts(counts: Record<string, number>): string {
  const labels: [string, string][] = [
    ['trackers', 'trackers'],
    ['sessions', 'sessions'],
    ['lapses', 'lapses'],
    ['urges', 'urges'],
    ['journalEntries', 'journal entries'],
    ['checkIns', 'check-ins'],
    ['categories', 'categories'],
    ['settings', 'settings'],
    ['historyEvents', 'history events'],
  ];
  const parts = labels
    .filter(([key]) => (counts[key] ?? 0) > 0)
    .map(([key, label]) => `${counts[key]} ${label}`);
  return parts.length > 0 ? parts.join(', ') : 'no records';
}
