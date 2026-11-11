#!/usr/bin/env node
/**
 * collect-tauri-artifacts.mjs, normalise and checksum Tauri 2 bundle output.
 *
 * `tauri build` writes platform bundles into
 * `apps/desktop/src-tauri/target/release/bundle/<target>/…` with names such as
 * `Tyag_1.0.0_amd64.AppImage`. Release assets use one stable scheme across
 * platforms and release jobs, so this script copies each produced file into
 * `apps/desktop/release/` with a predictable name and writes SHA256SUMS.txt:
 *
 *   linux    Tyag-<version>-x86_64.AppImage
 *            Tyag-<version>-amd64.deb
 *            Tyag-<version>-x86_64.rpm
 *   windows  Tyag-Setup-<version>-x64.exe          (NSIS)
 *            Tyag-<version>-x64.msi
 *   macos    Tyag-<version>-<arch>.dmg             (x64 | arm64)
 *
 * Usage: node scripts/collect-tauri-artifacts.mjs [linux|windows|macos]
 *        (derived from the host platform when omitted)
 *
 * No network. Copies local files only. Exits non-zero when no bundle at all was
 * produced; missing individual targets are reported as warnings (the release
 * workflows assert the expected set for their runner).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ROOT = join(ROOT, 'apps/desktop/src-tauri/target/release/bundle');
const OUT_DIR = join(ROOT, 'apps/desktop/release');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const HOST_TO_PLATFORM = { linux: 'linux', win32: 'windows', darwin: 'macos' };
const platform = (process.argv[2] ?? HOST_TO_PLATFORM[process.platform] ?? '').toLowerCase();
if (!['linux', 'windows', 'macos'].includes(platform)) {
  console.error(`collect-tauri-artifacts: unsupported platform "${platform}"`);
  process.exit(1);
}

const arch = process.arch;
const LINUX_ARCH = { x64: 'x86_64', arm64: 'aarch64', arm: 'armv7l', ia32: 'i686' }[arch] ?? arch;
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'armhf', ia32: 'i386' }[arch] ?? arch;
const WINDOWS_ARCH = { x64: 'x64', arm64: 'arm64', ia32: 'x86' }[arch] ?? arch;
const MAC_ARCH = { x64: 'x64', arm64: 'arm64' }[arch] ?? arch;

/**
 * target = Tauri bundle subdirectory; expected = release-automation contract
 * (used by docs and the release workflows); name = normalised release asset.
 */
const TARGETS = {
  linux: [
    { subdir: 'appimage', name: `Tyag-${VERSION}-${LINUX_ARCH}.AppImage` },
    { subdir: 'deb', name: `Tyag-${VERSION}-${DEB_ARCH}.deb` },
    { subdir: 'rpm', name: `Tyag-${VERSION}-${LINUX_ARCH}.rpm` },
  ],
  windows: [
    { subdir: 'nsis', name: `Tyag-Setup-${VERSION}-${WINDOWS_ARCH}.exe` },
    { subdir: 'msi', name: `Tyag-${VERSION}-${WINDOWS_ARCH}.msi` },
  ],
  macos: [{ subdir: 'dmg', name: `Tyag-${VERSION}-${MAC_ARCH}.dmg` }],
};

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const human = (bytes) => {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
};

mkdirSync(OUT_DIR, { recursive: true });

const collected = [];
for (const { subdir, name } of TARGETS[platform]) {
  const dir = join(BUNDLE_ROOT, subdir);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => statSync(join(dir, file)).isFile())
        .sort()
    : [];
  if (files.length === 0) {
    console.warn(`collect-tauri-artifacts: no ${subdir} bundle found in ${dir}`);
    continue;
  }
  // Tauri emits one file per target for the host arch; if several exist, take
  // the largest (a stale extra build must not shadow the newest artifact).
  const source = join(dir, files.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size)[0]);
  const destination = join(OUT_DIR, name);
  copyFileSync(source, destination);
  collected.push({ name, source, destination, bytes: statSync(destination).size });
}

if (collected.length === 0) {
  console.error(
    `collect-tauri-artifacts: no ${platform} bundles under ${BUNDLE_ROOT}, build the desktop app first.`,
  );
  process.exit(1);
}

const sums = collected
  .map(({ name, destination }) => ({ name, hash: sha256(destination) }))
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  join(OUT_DIR, 'SHA256SUMS.txt'),
  `${sums.map(({ hash, name }) => `${hash}  ${name}`).join('\n')}\n`,
);

console.log(`collect-tauri-artifacts: ${collected.length} artifact(s) in apps/desktop/release/`);
for (const { name, bytes } of collected.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${name}  (${human(bytes)})`);
}
