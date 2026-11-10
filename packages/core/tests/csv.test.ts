import { describe, expect, it } from 'vitest';
import { DeUrgeError, MS_PER_DAY, toIsoUtc } from '../src/index';
import {
  DAILY_SUMMARY_COLUMNS,
  JOURNAL_COLUMNS,
  LAPSE_COLUMNS,
  STATISTICS_COLUMNS,
  TRACKER_COLUMNS,
  URGE_COLUMNS,
} from '../src/backup/csv';
import { createTestCore } from './helpers';
import { seedRichCore } from './helpers/engines';

/** Minimal RFC 4180 parser used to prove the exported quoting round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('csv: RFC 4180 formatting', () => {
  it('quotes commas, quotes and newlines and uses CRLF line endings', async () => {
    const test = await createTestCore({ now: Date.UTC(2026, 0, 1, 12) });
    const created = await test.core.trackers.create({
      name: 'A, "quoted"\nname',
      description: 'line one, line two',
      notes: 'He said "hi"',
    });
    const result = test.core.backup.exportCsv('trackers');
    expect(result.filename).toMatch(/^deurge-trackers-\d{8}-\d{6}\.csv$/);
    expect(result.content.endsWith('\r\n')).toBe(true);
    // Record separators are CRLF; the quoted name keeps its own embedded LF.
    expect(result.content.split('\r\n').length).toBeGreaterThanOrEqual(2);
    expect(result.content).toContain('"A, ""quoted""\nname"');
    expect(result.content).toContain('"line one, line two"');
    expect(result.content).toContain('"He said ""hi"""');

    const rows = parseCsv(result.content);
    expect(rows[0]).toEqual([...TRACKER_COLUMNS]);
    // Tracker categories were removed from the data model.
    expect(rows[0]).not.toContain('category_id');
    expect(rows).toHaveLength(2);
    expect(result.rows).toBe(1);
    const byColumn = new Map(rows[0]!.map((column, index) => [column, rows[1]![index]!]));
    expect(byColumn.get('id')).toBe(created.id);
    expect(byColumn.get('name')).toBe('A, "quoted"\nname');
    expect(byColumn.get('description')).toBe('line one, line two');
    expect(byColumn.get('notes')).toBe('He said "hi"');
    expect(byColumn.get('reminder_enabled')).toBe('false');
    expect(byColumn.get('archived_at_utc')).toBe('');
  });

  it('renders null values as empty fields', async () => {
    const seeded = await seedRichCore();
    const result = seeded.core.backup.exportCsv('trackers');
    const rows = parseCsv(result.content);
    const byColumn = new Map(rows[0]!.map((column, index) => [column, rows[1]![index]!]));
    expect(byColumn.get('description')).toBe('Daily habit');
    expect(byColumn.get('archived_at_utc')).toBe('');
  });
});

describe('csv: datasets and columns', () => {
  it('exports lapses with UTC and local timestamp columns', async () => {
    const seeded = await seedRichCore();
    const result = seeded.core.backup.exportCsv('lapses');
    const rows = parseCsv(result.content);
    expect(rows[0]).toEqual([...LAPSE_COLUMNS]);
    expect(rows).toHaveLength(5); // header + 4 lapses
    expect(result.rows).toBe(4);
    const byColumn = new Map(rows[0]!.map((column, index) => [column, rows[1]![index]!]));
    expect(byColumn.get('occurred_at_utc')).toBe('2025-12-14T12:00:00.000Z');
    expect(byColumn.get('occurred_at_local')).toBe('Dec 14, 2025, 12:00 PM');
    expect(byColumn.get('tracker_name')).toBe('Smoking');
    expect(byColumn.get('occurred_time_zone')).toBe('UTC');
    expect(byColumn.get('retrospective')).toBe('false');
    expect(byColumn.get('notes')).toBe('');
  });

  it('honours timezone and date/time format options for local columns', async () => {
    const seeded = await seedRichCore();
    const result = seeded.core.backup.exportCsv('lapses', {
      timeZone: 'America/New_York',
      dateFormat: 'yyyy-MM-dd',
      timeFormat: '24h',
    });
    const rows = parseCsv(result.content);
    const byColumn = new Map(rows[0]!.map((column, index) => [column, rows[1]![index]!]));
    expect(byColumn.get('occurred_at_utc')).toBe('2025-12-14T12:00:00.000Z');
    expect(byColumn.get('occurred_at_local')).toBe('2025-12-14, 07:00');
    // Stored zone/offset are preserved, not rewritten.
    expect(byColumn.get('occurred_time_zone')).toBe('UTC');
    expect(byColumn.get('occurred_utc_offset_minutes')).toBe('0');
  });

  it('exports urges and journal entries with stable columns and ordering', async () => {
    const seeded = await seedRichCore();
    const urges = parseCsv(seeded.core.backup.exportCsv('urges').content);
    expect(urges[0]).toEqual([...URGE_COLUMNS]);
    expect(urges).toHaveLength(3);
    const urgeByColumn = new Map(urges[0]!.map((column, index) => [column, urges[1]![index]!]));
    expect(urgeByColumn.get('intensity')).toBe('6');
    expect(urgeByColumn.get('outcome')).toBe('passed');
    expect(urgeByColumn.get('duration_seconds')).toBe('300');
    expect(urgeByColumn.get('trigger')).toBe('Stress');

    const journal = parseCsv(seeded.core.backup.exportCsv('journal').content);
    expect(journal[0]).toEqual([...JOURNAL_COLUMNS]);
    expect(journal).toHaveLength(2);
    const journalByColumn = new Map(journal[0]!.map((column, index) => [column, journal[1]![index]!]));
    expect(journalByColumn.get('title')).toBe('Day 17');
    expect(journalByColumn.get('body')).toBe('Felt better today.');
    expect(journalByColumn.get('tracker_name')).toBe('Smoking');
  });

  it('exports a daily summary with one row per local day', async () => {
    const seeded = await seedRichCore();
    const result = seeded.core.backup.exportCsv('daily-summary');
    const rows = parseCsv(result.content);
    expect(rows[0]).toEqual([...DAILY_SUMMARY_COLUMNS]);
    const now = seeded.clock.now();
    const earliest = now - 20 * MS_PER_DAY; // primary tracker start
    expect(result.rows).toBe(21); // inclusive window of 20 days
    expect(rows[1]![0]).toBe('2025-12-12');
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow[0]).toBe('2026-01-01');
    expect(lastRow[1]).toBe('Thursday');

    const byDate = new Map(rows.slice(1).map((row) => [row[0]!, row]));
    const lapseDay = byDate.get('2025-12-14')!;
    expect(lapseDay[1]).toBe('Sunday');
    expect(lapseDay[4]).toBe('1'); // lapse_count
    // Active milliseconds across the summary match the sum of tracker metrics.
    const metrics = seeded.core.allMetrics();
    const expectedActive = metrics.reduce((total, entry) => total + entry.activeTrackedMs, 0);
    const exportedActive = rows
      .slice(1)
      .reduce((total, row) => total + Number(row[2]), 0);
    expect(exportedActive).toBe(expectedActive);
    void earliest;
  });

  it('exports statistics that match the metrics engine', async () => {
    const seeded = await seedRichCore();
    const result = seeded.core.backup.exportCsv('statistics');
    const rows = parseCsv(result.content);
    expect(rows[0]).toEqual([...STATISTICS_COLUMNS]);
    expect(result.rows).toBe(2);
    const metrics = seeded.core.metrics(seeded.trackerId);
    const primaryRow = rows.find((row) => row[1] === seeded.trackerId)!;
    expect(primaryRow[0]).toBe('tracker');
    expect(primaryRow[4]).toBe(toIsoUtc(metrics.now));
    expect(primaryRow[9]).toBe(String(metrics.currentStreakMs));
    expect(primaryRow[12]).toBe(String(metrics.accumulatedAbstinenceMs));
    expect(primaryRow[14]).toBe(String(metrics.lapseCount));
  });

  it('rejects unknown time zones', async () => {
    const seeded = await seedRichCore();
    expect(() =>
      seeded.core.backup.exportCsv('lapses', { timeZone: 'Mars/Olympus_Mons' }),
    ).toThrow(DeUrgeError);
    try {
      seeded.core.backup.exportCsv('lapses', { timeZone: 'Mars/Olympus_Mons' });
    } catch (error) {
      expect((error as DeUrgeError).code).toBe('VALIDATION');
    }
  });
});
