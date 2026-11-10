/**
 * Boots the deUrge core on the current platform.
 *
 * Persistence order:
 *   1. Tauri desktop commands (atomic local file in the app data directory)
 *   2. Capacitor native filesystem (Android/iOS app-private storage)
 *   3. IndexedDB (browser/PWA), with a localStorage fallback
 *   4. In-memory (last resort; the UI warns that data will not be kept)
 */
import { DeUrgeCore, loadSqlJs, MemoryPersistence, type PersistenceAdapter } from '@deurge/core';
import { Capacitor } from '@capacitor/core';
import { invoke } from '@tauri-apps/api/core';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { idbGet, idbSet } from './idb';

/** True when the bundle is running inside the Tauri desktop shell. */
export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < data.length; index += chunk) {
    binary += String.fromCharCode(...data.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Desktop persistence through the app's own Tauri commands. Payloads travel as
 * base64 strings so the JSON IPC never inflates a snapshot into a number array;
 * the Rust side validates the size and writes atomically (temp file + fsync +
 * rename) inside the per-user app data directory.
 */
class TauriPersistence implements PersistenceAdapter {
  readonly kind = 'desktop' as const;
  async load(): Promise<Uint8Array | null> {
    const value = await invoke<string | null>('db_read');
    return value ? base64ToBytes(value) : null;
  }
  async save(data: Uint8Array): Promise<void> {
    await invoke('db_write', { payloadB64: bytesToBase64(data) });
  }
  async backup(data: Uint8Array): Promise<void> {
    await invoke('db_backup', { payloadB64: bytesToBase64(data) });
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
  if (isTauriDesktop()) {
    return { persistence: new TauriPersistence(), warning: null };
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
