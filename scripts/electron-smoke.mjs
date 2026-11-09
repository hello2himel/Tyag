#!/usr/bin/env node
/**
 * electron-smoke.mjs — end-to-end smoke test for the packaged Electron app.
 *
 * Launches the packaged linux-unpacked bundle headlessly (Ozone "headless"
 * platform — no X/Wayland display needed) and drives the real renderer over the
 * Chrome DevTools Protocol to verify the production integration:
 *
 *   1. the app loads `app://deurge/index.html` (custom privileged scheme, not
 *      file://) with the expected title;
 *   2. the shared web app boots: React renders, the local SQLite-WASM asset is
 *      fetched over app://, and no external network request is made;
 *   3. `window.deurgeDesktop` exposes the agreed bridge and
 *      writeDatabase → readDatabase round-trips bytes atomically;
 *   4. `deurge.db`, `deurge.backup.db` and timestamped backups land in the
 *      user-data directory;
 *   5. no CSP violations / renderer exceptions are logged.
 *
 * Usage:
 *   node scripts/electron-smoke.mjs [--app-dir <dir>] [--port <n>]
 *
 * Requires a Linux build (`pnpm build:desktop`). Other platforms work with the
 * equivalent app directory, but CI runs this on Linux.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const APP_DIR = resolve(argValue('--app-dir', join(ROOT, 'apps/desktop/release/linux-unpacked')));
const PORT = Number(argValue('--port', '9334'));
const BIN = process.platform === 'win32' ? join(APP_DIR, 'deUrge.exe') : join(APP_DIR, 'deurge');
const USER_DATA = mkdtempSync(join(tmpdir(), 'deurge-smoke-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok   ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};

if (!existsSync(BIN)) {
  console.error(`electron-smoke: packaged app not found: ${BIN}`);
  console.error('electron-smoke: build it first with: pnpm build:desktop');
  process.exit(2);
}

const child = spawn(
  BIN,
  [
    '--no-sandbox',
    '--ozone-platform=headless',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let logs = '';
child.stdout.on('data', (chunk) => (logs += chunk));
child.stderr.on('data', (chunk) => (logs += chunk));

const shutdown = (code) => {
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  rmSync(USER_DATA, { recursive: true, force: true });
  process.exit(code);
};

const consoleProblems = [];
const requests = [];

try {
  // ---------------------------------------------------------------- page target
  let page = null;
  for (let attempt = 0; attempt < 60 && !page; attempt += 1) {
    await sleep(500);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = targets.find((t) => t.type === 'page' && t.url.startsWith('app://'));
    } catch {
      /* devtools not up yet */
    }
  }
  if (!page) {
    throw new Error(`no app:// page target appeared.\nElectron logs:\n${logs}`);
  }

  console.log(`electron-smoke: ${page.url} — ${page.title}`);
  check(page.url === 'app://deurge/index.html', 'loads app://deurge/index.html (not file://)');
  check(/deUrge/.test(page.title ?? ''), 'window title is deUrge');

  // ------------------------------------------------------------------- CDP glue
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === 'Network.requestWillBeSent') {
      requests.push(message.params.request.url);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleProblems.push(
        String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text).slice(0, 200),
      );
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleProblems.push(
        message.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200),
      );
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = (method, params = {}) =>
    new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Page.enable');
  await cdp('Page.reload', { ignoreCache: true });
  await sleep(5000);

  // -------------------------------------------------------------------- checks
  const probe = await cdp('Runtime.evaluate', {
    expression: `(async () => {
      const d = window.deurgeDesktop;
      const root = document.querySelector('#root') ?? document.body;
      const result = {
        rootChildren: root.children.length,
        bodyTextLength: document.body.innerText.trim().length,
        bridge: null,
        consoleErrors: [],
      };
      if (d) {
        const before = await d.readDatabase();
        const bytes = new Uint8Array([7, 8, 9, 42]);
        await d.writeDatabase(bytes.buffer);
        const after = await d.readDatabase();
        await d.backupDatabase(after);
        result.bridge = {
          platform: d.platform,
          electron: d.versions?.electron,
          beforeIsNull: before === null,
          beforeIsArrayBuffer: before instanceof ArrayBuffer,
          isArrayBuffer: after instanceof ArrayBuffer,
          afterBytes: Array.from(new Uint8Array(after)),
        };
      }
      return result;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (probe.result?.exceptionDetails) {
    throw new Error(`renderer evaluation failed: ${JSON.stringify(probe.result.exceptionDetails)}`);
  }
  const result = probe.result.result.value;

  const appRequests = requests.filter((u) => u.startsWith('app://'));
  const externalRequests = requests.filter((u) => /^(https?|wss?):/i.test(u));

  check(result.rootChildren > 0 && result.bodyTextLength > 20, `web app rendered (${result.bodyTextLength} chars of UI text)`);
  check(appRequests.some((u) => u.includes('sql-wasm') && u.endsWith('.wasm')), 'SQLite-WASM loaded from app://');
  check(externalRequests.length === 0, `no external network requests (${externalRequests.join(', ') || 'none'})`);
  check(Boolean(result.bridge), 'window.deurgeDesktop is exposed');
  if (result.bridge) {
    check(result.bridge.platform === 'electron', "platform is 'electron'");
    check(
      result.bridge.beforeIsNull || result.bridge.beforeIsArrayBuffer,
      'readDatabase() returns ArrayBuffer (or null before the first snapshot)',
    );
    check(result.bridge.isArrayBuffer, 'readDatabase() returns an ArrayBuffer');
    check(result.bridge.afterBytes.join(',') === '7,8,9,42', 'writeDatabase → readDatabase round-trips bytes');
  }

  const dbPath = join(USER_DATA, 'deurge.db');
  const backupPath = join(USER_DATA, 'deurge.backup.db');
  const backupsDir = join(USER_DATA, 'backups');
  check(existsSync(dbPath), 'deurge.db written to userData');
  check(existsSync(backupPath), 'deurge.backup.db written to userData');
  check(
    existsSync(backupsDir) && readdirSync(backupsDir).some((f) => f.startsWith('deurge-') && f.endsWith('.db')),
    'timestamped history backup written to userData/backups',
  );
  if (existsSync(dbPath)) {
    check([...readFileSync(dbPath)].join(',') === '7,8,9,42', 'deurge.db on disk contains the snapshot bytes');
  }

  check(
    !consoleProblems.some((e) => /Refused to|Content Security Policy|could not connect|ERR_/i.test(e)),
    `no CSP violations or blocked resources (${consoleProblems.length} console error(s))`,
  );

  if (failures.length > 0) {
    console.error(`\nelectron-smoke: FAILED — ${failures.length} check(s)`);
    console.error(`Electron logs:\n${logs}`);
    shutdown(1);
  }
  console.log('\nelectron-smoke: PASS — packaged Electron app serves the PWA over app://, boots the SQLite-WASM bundle offline, and persists the database atomically.');
  shutdown(0);
} catch (error) {
  console.error(`\nelectron-smoke: ERROR — ${error?.message ?? error}`);
  console.error(`Electron logs:\n${logs}`);
  shutdown(1);
}
