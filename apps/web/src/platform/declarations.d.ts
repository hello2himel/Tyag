export {};

declare global {
  interface DesktopBridge {
    platform: 'electron';
    versions?: Record<string, string>;
    readDatabase: () => Promise<ArrayBuffer | null>;
    writeDatabase: (bytes: ArrayBuffer) => Promise<void>;
    backupDatabase: (bytes: ArrayBuffer) => Promise<void>;
  }

  interface Window {
    deurgeDesktop?: DesktopBridge;
  }
}
