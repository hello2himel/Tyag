/**
 * Boots the deUrge core on the current platform.
 *
 * Persistence order:
 *   1. Electron preload bridge (local file, exposed by apps/desktop)
 *   2. Capacitor native filesystem (Android/iOS app-private storage)
 *   3. IndexedDB (browser/PWA), with a localStorage fallback
 *   4. In-memory (last resort; the UI warns that data will not be kept)
 */
import { DeUrgeCore, loadSqlJs, MemoryPersistence, type PersistenceAdapter } from '@deurge/core';
import { Capacitor } from '@capacitor/core';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { idbGet, idbSet } from './idb';

class DesktopPersistence implements PersistenceAdapter {
  readonly kind = 'desktop' as const;
  constructor(private readonly bridge: NonNullable<Window['deurgeDesktop']>) {}
  async load(): Promise<Uint8Array | null> {
    const value = await this.bridge.readDatabase();
    return value ? new Uint8Array(value) : null;
  }
  async save(data: Uint8Array): Promise<void> {
    const copy = new Uint8Array(data);
    await this.bridge.writeDatabase(copy.buffer);
  }
  async backup(data: Uint8Array): Promise<void> {
    const copy = new Uint8Array(data);
    await this.bridge.backupDatabase(copy.buffer);
  }
}

class IdbPersistence implements PersistenceAdapter {
  readonly kind = 'indexeddb' as const;
  async load(): Promise<Uint8Array | null> {
    return idbGet('database');
  }
  async save(data: Uint8Array): Promise<void> {
    await idbSet('database', data);
  }
  async backup(data: Uint8Array): Promise<void> {
    await idbSet('database-backup', data);
  }
}

/** localStorage fallback for environments where IndexedDB is blocked. */
class LocalStoragePersistence implements PersistenceAdapter {
  readonly kind = 'localstorage' as const;
  private readonly key = 'deurge.database';
  private readonly backupKey = 'deurge.database.backup';
  private encode(data: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < data.length; index += chunk) {
      binary += String.fromCharCode(...data.subarray(index, index + chunk));
    }
    return btoa(binary);
  }
  private decode(value: string | null): Uint8Array | null {
    if (!value) return null;
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  async load(): Promise<Uint8Array | null> {
    return this.decode(localStorage.getItem(this.key));
  }
  async save(data: Uint8Array): Promise<void> {
    localStorage.setItem(this.key, this.encode(data));
  }
  async backup(data: Uint8Array): Promise<void> {
    localStorage.setItem(this.backupKey, this.encode(data));
  }
}

export interface BootResult {
  core: DeUrgeCore;
  persistenceKind: PersistenceAdapter['kind'];
  /** Set when the platform had to fall back to memory (data not saved). */
  storageWarning: string | null;
}

async function loadWasm(): Promise<ArrayBuffer> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`Could not load the local database engine (${response.status}).`);
  return response.arrayBuffer();
}

async function createPersistence(): Promise<{ persistence: PersistenceAdapter; warning: string | null }> {
  if (typeof window !== 'undefined' && window.deurgeDesktop) {
    return { persistence: new DesktopPersistence(window.deurgeDesktop), warning: null };
  }
  if (Capacitor.isNativePlatform()) {
    try {
      const { createCapacitorPersistence } = await import('./capacitorPersistence');
      return { persistence: await createCapacitorPersistence(), warning: null };
    } catch {
      // Fall through to browser storage inside the WebView.
    }
  }
  try {
    const persistence = new IdbPersistence();
    await idbSet('probe', new Uint8Array([1]));
    return { persistence, warning: null };
  } catch {
    try {
      const persistence = new LocalStoragePersistence();
      await persistence.save(new Uint8Array([1]));
      return {
        persistence,
        warning:
          'This browser blocked IndexedDB, so deUrge is using small local storage instead. Export a backup regularly.',
      };
    } catch {
      return {
        persistence: new MemoryPersistence(),
        warning:
          'This browser is blocking local storage. deUrge will work for this session, but your data will not be kept. Export a backup before closing.',
      };
    }
  }
}

export async function openDeUrgeCore(): Promise<BootResult> {
  const wasmBinary = await loadWasm();
  const SQL = await loadSqlJs({ wasmBinary });
  const { persistence, warning } = await createPersistence();
  const core = await DeUrgeCore.open({ SQL, persistence });
  return { core, persistenceKind: persistence.kind, storageWarning: warning };
}

export async function resetWebStorage(): Promise<void> {
  try {
    await idbSet('database', new Uint8Array());
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem('deurge.database');
    localStorage.removeItem('deurge.database.backup');
  } catch {
    /* ignore */
  }
}
