/**
 * deUrge desktop persistence — the only privileged I/O the renderer can reach.
 *
 * A single SQLite snapshot (sql.js/OPFS-style export) is persisted as one file
 * under Electron's per-user data directory. Nothing here touches the network,
 * the filesystem outside the app's own data directory, or the process shell.
 *
 * File layout (all inside app.getPath('userData')):
 *   deurge.db                              live snapshot
 *   deurge.backup.db                       stable pre-write backup
 *   backups/deurge-<ISO-8601>.db           rotating history (last 20)
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ipcMain } from 'electron';

export const DB_CHANNELS = Object.freeze({
  read: 'deurge:db:read',
  write: 'deurge:db:write',
  backup: 'deurge:db:backup',
});

/** Hard cap for an IPC-carried snapshot (mirrors the renderer-side limit). */
export const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
/** Number of timestamped snapshots kept in userData/backups. */
export const MAX_BACKUP_HISTORY = 20;

const isTrustedFrame = (event, trustedOrigins) => {
  const url = event.senderFrame?.url ?? '';
  return trustedOrigins.some((origin) => url === origin || url.startsWith(`${origin}/`));
};

const assertTrustedFrame = (event, trustedOrigins) => {
  if (!isTrustedFrame(event, trustedOrigins)) {
    throw new Error(`Refusing IPC from untrusted frame: ${event.senderFrame?.url ?? 'unknown'}`);
  }
};

/** Accept ArrayBuffer, TypedArray/DataView or Buffer-shell payloads. */
function toBuffer(payload) {
  let bytes;
  if (payload instanceof ArrayBuffer) {
    bytes = new Uint8Array(payload);
  } else if (ArrayBuffer.isView(payload)) {
    bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  } else if (
    payload &&
    typeof payload === 'object' &&
    payload.type === 'Buffer' &&
    Array.isArray(payload.data)
  ) {
    bytes = Uint8Array.from(payload.data);
  } else {
    throw new TypeError('Database payload must be an ArrayBuffer or Uint8Array');
  }
  if (bytes.byteLength === 0) throw new RangeError('Database payload must not be empty');
  if (bytes.byteLength > MAX_DATABASE_BYTES) {
    throw new RangeError(
      `Database payload exceeds ${MAX_DATABASE_BYTES} bytes (got ${bytes.byteLength})`,
    );
  }
  return Buffer.from(bytes);
}

const toArrayBuffer = (buffer) =>
  buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

/** Write file via sibling temp file + fsync + rename, so crashes never corrupt it. */
async function atomicWrite(targetPath, bytes) {
  await mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(tmpPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmpPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  // Persist the rename itself (best effort; not supported on every platform).
  try {
    const dir = await open(dirname(targetPath), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* ignore */
  }
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function registerDatabaseHandlers({ userDataDir, trustedOrigins }) {
  const dbPath = join(userDataDir, 'deurge.db');
  const stableBackupPath = join(userDataDir, 'deurge.backup.db');
  const backupsDir = join(userDataDir, 'backups');

  const pruneBackups = async () => {
    let entries;
    try {
      entries = await readdir(backupsDir);
    } catch {
      return;
    }
    const files = entries.filter((name) => name.startsWith('deurge-') && name.endsWith('.db'));
    if (files.length <= MAX_BACKUP_HISTORY) return;
    const stats = await Promise.all(
      files.map(async (name) => ({ name, mtime: (await stat(join(backupsDir, name))).mtimeMs })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const stale of stats.slice(MAX_BACKUP_HISTORY)) {
      await unlink(join(backupsDir, stale.name)).catch(() => {});
    }
  };

  ipcMain.handle(DB_CHANNELS.read, async (event) => {
    assertTrustedFrame(event, trustedOrigins);
    try {
      const info = await stat(dbPath);
      if (!info.isFile()) return null;
      if (info.size > MAX_DATABASE_BYTES) {
        throw new RangeError(`Database file exceeds ${MAX_DATABASE_BYTES} bytes`);
      }
      const bytes = await readFile(dbPath);
      return toArrayBuffer(bytes);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  });

  ipcMain.handle(DB_CHANNELS.write, async (event, payload) => {
    assertTrustedFrame(event, trustedOrigins);
    const bytes = toBuffer(payload);
    await atomicWrite(dbPath, bytes);
  });

  ipcMain.handle(DB_CHANNELS.backup, async (event, payload) => {
    assertTrustedFrame(event, trustedOrigins);
    const bytes = toBuffer(payload);
    await mkdir(backupsDir, { recursive: true });
    await atomicWrite(stableBackupPath, bytes);
    await atomicWrite(join(backupsDir, `deurge-${timestamp()}.db`), bytes);
    await pruneBackups();
  });

  return { dbPath, stableBackupPath, backupsDir };
}
