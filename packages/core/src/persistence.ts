/**
 * Platform storage for the SQLite snapshot.
 *
 * The engines never know where bytes live: the browser uses IndexedDB,
 * Capacitor uses the app's private filesystem, Electron uses a local file via
 * IPC. Tests use memory. Adapters must persist atomically (temp file + rename
 * or a single IndexedDB put) and must never send data off device.
 */
export interface PersistenceAdapter {
  readonly kind: 'indexeddb' | 'localstorage' | 'filesystem' | 'desktop' | 'memory';
  load(): Promise<Uint8Array | null>;
  save(data: Uint8Array): Promise<void>;
  /** Optional rolling snapshot kept for recovery before destructive imports. */
  backup?(data: Uint8Array): Promise<void>;
}

export class MemoryPersistence implements PersistenceAdapter {
  readonly kind = 'memory' as const;
  private data: Uint8Array | null;
  private backupData: Uint8Array | null = null;
  saves = 0;

  constructor(initial: Uint8Array | null = null) {
    this.data = initial ? new Uint8Array(initial) : null;
  }

  async load(): Promise<Uint8Array | null> {
    return this.data ? new Uint8Array(this.data) : null;
  }

  async save(data: Uint8Array): Promise<void> {
    this.data = new Uint8Array(data);
    this.saves += 1;
  }

  async backup(data: Uint8Array): Promise<void> {
    this.backupData = new Uint8Array(data);
  }

  snapshot(): Uint8Array | null {
    return this.data ? new Uint8Array(this.data) : null;
  }

  backupSnapshot(): Uint8Array | null {
    return this.backupData ? new Uint8Array(this.backupData) : null;
  }

  corrupt(): void {
    this.data = new Uint8Array([1, 2, 3, 4, 5]);
  }
}
