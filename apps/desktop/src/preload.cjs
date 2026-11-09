/**
 * deUrge desktop preload (sandboxed, CommonJS).
 *
 * Exposes exactly one object — window.deurgeDesktop — and nothing else. The
 * renderer never receives Node.js, require(), ipcRenderer, or any fs access;
 * only the three database calls are forwarded to the main process.
 *
 * Contract (must match the web adapter's desktop detection):
 *   readDatabase():          Promise<ArrayBuffer | null>  null on first run
 *   writeDatabase(bytes):    Promise<void>                atomic snapshot write
 *   backupDatabase(bytes):   Promise<void>                stable + timestamped backup
 *   platform:                'electron'
 *   versions:                { electron, chrome }
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deurgeDesktop', {
  platform: 'electron',
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
  readDatabase: () => ipcRenderer.invoke('deurge:db:read'),
  writeDatabase: (bytes) => ipcRenderer.invoke('deurge:db:write', bytes),
  backupDatabase: (bytes) => ipcRenderer.invoke('deurge:db:backup', bytes),
});
