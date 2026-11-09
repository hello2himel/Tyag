/** Native Android/iOS persistence: the database snapshot lives in app-private storage. */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { PersistenceAdapter } from '@deurge/core';

const FILE = 'deurge.sqlite';
const BACKUP = 'deurge.backup.sqlite';

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

class CapacitorFilesystemPersistence implements PersistenceAdapter {
  readonly kind = 'filesystem' as const;

  private async read(path: string): Promise<Uint8Array | null> {
    try {
      const result = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
      const data = typeof result.data === 'string' ? result.data : await (result.data as Blob).text();
      return base64ToBytes(data);
    } catch {
      return null;
    }
  }

  private async write(path: string, data: Uint8Array): Promise<void> {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: bytesToBase64(data),
      encoding: Encoding.UTF8,
      recursive: true,
    });
  }

  async load(): Promise<Uint8Array | null> {
    return this.read(FILE);
  }

  async save(data: Uint8Array): Promise<void> {
    await this.write(FILE, data);
  }

  async backup(data: Uint8Array): Promise<void> {
    await this.write(BACKUP, data);
  }
}

export async function createCapacitorPersistence(): Promise<PersistenceAdapter> {
  return new CapacitorFilesystemPersistence();
}
