/**
 * Local file save/open helpers.
 * Exports use the operating system's own file handling: a normal browser
 * download on the web, and the app-private file system on Android/iOS. Nothing
 * is uploaded anywhere.
 */
import { Capacitor } from '@capacitor/core';
import { invoke } from '@tauri-apps/api/core';
import { isTauriDesktop } from './db';

export interface SavedFile {
  filename: string;
  location: string;
}

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export async function saveTextFile(
  filename: string,
  content: string,
  mimeType = 'application/json',
): Promise<SavedFile> {
  if (isTauriDesktop()) {
    // The desktop shell writes through a Rust command into the user's
    // Downloads folder — no remote handling, no dialogs blocking the renderer.
    try {
      const location = await invoke<string>('save_text_file', { filename, content });
      return { filename, location };
    } catch {
      // Fall through to the browser download path if the command is missing.
    }
  }
  if (isNative()) {
    const { Directory, Filesystem } = await import('@capacitor/filesystem');
    const path = `deUrge/${filename}`;
    await Filesystem.writeFile({
      path,
      data: content,
      directory: Directory.Documents,
      encoding: 'utf8' as never,
      recursive: true,
    }).catch(async () => {
      // Some Android versions restrict the shared Documents folder; fall back
      // to the app's own documents directory, still user-accessible.
      await Filesystem.writeFile({
        path,
        data: content,
        directory: Directory.Data,
        encoding: 'utf8' as never,
        recursive: true,
      });
    });
    const uri = await Filesystem.getUri({ path, directory: Directory.Documents }).catch(() => null);
    return { filename, location: uri?.uri ?? path };
  }
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { filename, location: 'Downloads' };
}

export function pickTextFile(accept = '.json,application/json,text/plain'): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (value: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      try {
        const text = await file.text();
        finish({ name: file.name, text });
      } catch {
        finish(null);
      }
    });
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}
