/**
 * deUrge — Electron main process.
 *
 * Local-only by construction:
 *   - the web app is served from a privileged custom scheme (`app://deurge/`)
 *     that resolves files inside the packaged `web/` directory only; it is
 *     never loaded via file:// (SQLite-WASM needs fetch(), which file:// blocks);
 *   - every navigation outside `app://` (or the Vite dev server in dev) is
 *     blocked, and window.open()/webviews are denied outright;
 *   - permissions other than notifications are denied;
 *   - no auto-updater, no telemetry, no remote content.
 *
 * In development: `pnpm --filter @deurge/desktop dev` loads the Vite dev server
 * (default http://localhost:5173). Plain `start` serves the local
 * `apps/web/dist` build through app:// without packaging.
 */
import { app, BrowserWindow, Menu, net, protocol, session } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerDatabaseHandlers } from './db-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APP_SCHEME = 'app';
const APP_HOST = 'deurge';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_ENTRY = `${APP_ORIGIN}/index.html`;

const IS_DEV = !app.isPackaged;
const DEV_SERVER_URL = process.env.DEURGE_DEV_SERVER_URL || 'http://localhost:5173';
const USE_DEV_SERVER = IS_DEV && (process.argv.includes('--dev') || Boolean(process.env.DEURGE_DEV_SERVER_URL));

/** CSP for packaged content — mirrors netlify.toml; no remote origins at all. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Correct MIME types for the handful of assets that must not be sniffed wrong. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Must run before app is ready: app:// behaves as a secure, standard origin so
// fetch(), service workers, WASM and IndexedDB work exactly like on the web.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

const webRoot = () =>
  app.isPackaged ? join(process.resourcesPath, 'web') : resolve(__dirname, '../../web/dist');

/**
 * Serve the packaged web build. Only files inside `webRoot` are reachable;
 * extension-less URLs fall back to index.html (the app itself uses hash
 * routing, so this is belt-and-braces).
 */
async function handleAppRequest(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (!pathname || pathname === '/') pathname = '/index.html';

  const root = resolve(webRoot());
  let filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (extname(pathname) === '') {
      filePath = join(root, 'index.html');
    } else {
      return new Response('Not found', { status: 404 });
    }
  }

  const response = await net.fetch(pathToFileURL(filePath).toString());
  const headers = new Headers(response.headers);
  headers.set('Content-Type', MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

const allowedNavigation = (url) => {
  if (url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`)) return true;
  if (USE_DEV_SERVER) {
    try {
      const target = new URL(url);
      const dev = new URL(DEV_SERVER_URL);
      return target.origin === dev.origin;
    } catch {
      return false;
    }
  }
  return false;
};

/** Hard-lock every web contents: no external navigation, popups or webviews. */
function hardenContents(contents) {
  contents.on('will-navigate', (event, url) => {
    if (!allowedNavigation(url)) {
      event.preventDefault();
      console.warn('[deurge] blocked navigation to', url);
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!allowedNavigation(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function buildMenu() {
  if (process.platform !== 'darwin') {
    // App-like window on Windows/Linux; keyboard shortcuts still work.
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

function createWindow() {
  const iconPath = join(__dirname, '../build/icons/128x128.png');
  const win = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 380,
    minHeight: 600,
    resizable: true,
    show: false,
    backgroundColor: '#000000',
    title: 'deUrge',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: IS_DEV,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (USE_DEV_SERVER) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadURL(APP_ENTRY);
  }

  return win;
}

// Single instance: a second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => hardenContents(contents));

  app.whenReady().then(() => {
    app.setAppUserModelId('app.deurge.DeUrge');
    buildMenu();

    protocol.handle(APP_SCHEME, (request) =>
      handleAppRequest(request).catch((error) => {
        console.error('[deurge] failed to serve', request.url, error);
        return new Response('Internal error', { status: 500 });
      }),
    );

    const trustedOrigins = [APP_ORIGIN, ...(USE_DEV_SERVER ? [new URL(DEV_SERVER_URL).origin] : [])];
    registerDatabaseHandlers({ userDataDir: app.getPath('userData'), trustedOrigins });

    // Local-only app: allow notifications (local reminders), deny the rest.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'notifications');
    });
    session.defaultSession.setPermissionCheckHandler(
      (_wc, permission) => permission === 'notifications',
    );

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
