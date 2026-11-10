#!/usr/bin/env node
/**
 * gen-icons.mjs — every deUrge icon, generated from the official logo kit.
 *
 * Source of truth (committed):
 *   assets/brand/deurge-icon-light-rounded.svg   app icon, light
 *   assets/brand/deurge-icon-dark-rounded.svg    app icon, dark
 *   assets/brand/deurge-mark-primary.svg         bare mark (black)
 *   assets/brand/deurge-mark-reversed.svg        bare mark (white)
 *   assets/brand/favicon.svg                     adaptive favicon
 *
 * Generated (committed):
 *   apps/web/public/{favicon-32.png, icons/icon-{192,512,maskable-512,1024}.png,
 *                    icons/apple-touch-icon-180.png}
 *   apps/mobile/android/app/src/main/res/**       launcher + splash icons
 *   apps/mobile/ios/App/App/Assets.xcassets/**    app icon + launch splash
 *   apps/desktop/src-tauri/icons/**               Tauri bundle icons
 *
 * Usage: node scripts/gen-icons.mjs [web|android|ios|desktop|all]   (default all)
 * Tooling: librsvg (rsvg-convert) or ImageMagick (magick) — regeneration only;
 * generated PNGs/ICO/ICNS are committed, so normal builds need neither.
 * No network access.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'assets/brand');
const WEB_PUBLIC = join(ROOT, 'apps/web/public');
const WEB_ICONS = join(WEB_PUBLIC, 'icons');
const ANDROID_RES = join(ROOT, 'apps/mobile/android/app/src/main/res');
const IOS_ASSETS = join(ROOT, 'apps/mobile/ios/App/App/Assets.xcassets');
const TAURI_ICONS = join(ROOT, 'apps/desktop/src-tauri/icons');
const TMP = join(tmpdir(), `deurge-icons-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const read = (name) => readFileSync(join(BRAND, name), 'utf8');
const MARK_PATH = (() => {
  const svg = read('deurge-mark-primary.svg');
  const m = svg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) throw new Error('gen-icons: unexpected mark SVG');
  return m[1];
})();
const MARK_INNER = (color) => MARK_PATH.replace(/fill="[^"]*"/g, `fill="${color}"`);
const LIGHT_ROUNDED = read('deurge-icon-light-rounded.svg');
const DARK_ROUNDED = read('deurge-icon-dark-rounded.svg');
const FAVICON = read('favicon.svg');

function findTool() {
  const candidates = [
    ['rsvg-convert', (svg, size, out) => ['-w', String(size), '-h', String(size), svg, '-o', out]],
    ['magick', (svg, size, out) => ['-background', 'none', '-density', '384', svg, '-resize', `${size}x${size}`, out]],
  ];
  for (const [bin, args] of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return { bin, args };
    } catch {
      /* next */
    }
  }
  throw new Error('gen-icons: need librsvg (rsvg-convert) or ImageMagick (magick) on PATH');
}
const RASTER = findTool();

let written = 0;

/** Tauri requires RGBA PNGs; librsvg emits RGB for fully opaque images. */
function ensureRgba(outPath) {
  try {
    execFileSync('magick', [outPath, '-alpha', 'on', `PNG32:${outPath}`], { stdio: 'ignore' });
  } catch {
    console.warn(`gen-icons: could not force RGBA on ${outPath} (ImageMagick missing)`);
  }
}

function render(svg, size, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const svgPath = join(TMP, `src-${size}-${Math.random().toString(36).slice(2, 8)}.svg`);
  writeFileSync(svgPath, svg, 'utf8');
  execFileSync(RASTER.bin, RASTER.args(svgPath, size, outPath), { stdio: 'ignore' });
  rmSync(svgPath, { force: true });
  written += 1;
  console.log(`  ${outPath.replace(ROOT + '/', '')}`);
}

/** Full-bleed square with the mark inset. `scale` is the mark's share of the canvas. */
function fullBleed(scale, bg = '#FFFFFF', fg = '#000000') {
  const factor = (1024 * scale) / 120;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/><g transform="translate(512 512) scale(${factor}) translate(-60 -60)">${MARK_INNER(fg)}</g></svg>\n`;
}

/** Transparent canvas with the mark inset (launcher foregrounds, splash marks). */
function transparent(scale, fg = '#000000') {
  const factor = (1024 * scale) / 120;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><g transform="translate(512 512) scale(${factor}) translate(-60 -60)">${MARK_INNER(fg)}</g></svg>\n`;
}

/* --------------------------------------------------------------- icns/ico */

function writeIcns(outPath, entries) {
  const chunks = [];
  for (const [type, png] of entries) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(8 + png.length, 4);
    chunks.push(head, png);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + body.length, 4);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.concat([header, body]));
}

function writeIco(outPath, pngPaths) {
  try {
    execFileSync('magick', [...pngPaths, '-define', 'icon:auto-resize=256,128,64,48,32,16', outPath]);
    return true;
  } catch {
    return false;
  }
}

const targets = new Set(
  (process.argv[2] ?? 'all') === 'all' ? ['web', 'android', 'ios', 'desktop'] : [process.argv[2]].filter(Boolean),
);

/* ------------------------------------------------------------------- web */
if (targets.has('web')) {
  render(LIGHT_ROUNDED, 192, join(WEB_ICONS, 'icon-192.png'));
  render(LIGHT_ROUNDED, 512, join(WEB_ICONS, 'icon-512.png'));
  render(fullBleed(0.8), 512, join(WEB_ICONS, 'icon-maskable-512.png'));
  render(LIGHT_ROUNDED, 180, join(WEB_PUBLIC, 'icons/apple-touch-icon-180.png'));
  render(fullBleed(0.82), 1024, join(WEB_ICONS, 'icon-1024.png'));
  render(FAVICON, 32, join(WEB_PUBLIC, 'favicon-32.png'));
  // Dark-theme app icon source (used by the UI where an explicit dark mark is needed).
  render(DARK_ROUNDED, 512, join(WEB_ICONS, 'icon-dark-512.png'));
}

/* --------------------------------------------------------------- android */
if (targets.has('android')) {
  if (!existsSync(ANDROID_RES)) {
    console.warn('gen-icons: apps/mobile/android missing — skipped.');
  } else {
    const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    for (const [density, factor] of Object.entries(densities)) {
      const dir = join(ANDROID_RES, `mipmap-${density}`);
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
        render(LIGHT_ROUNDED, Math.round(48 * factor), join(dir, name));
      }
      render(transparent(0.62), Math.round(108 * factor), join(dir, 'ic_launcher_foreground.png'));
    }
    // Adaptive-icon background is pure white so the black mark is always visible.
    const bgXml = join(ANDROID_RES, 'values/ic_launcher_background.xml');
    mkdirSync(dirname(bgXml), { recursive: true });
    writeFileSync(bgXml, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n');
    written += 1;
    // Android 12+ splash: transparent mark; the launch background provides the field.
    for (const [density, factor] of Object.entries(densities)) {
      const dir = join(ANDROID_RES, `drawable-${density}`);
      render(transparent(0.6), Math.round(120 * factor), join(dir, 'splash_icon.png'));
    }
    render(transparent(0.6), 240, join(ANDROID_RES, 'drawable/splash_icon.png'));
  }
}

/* ------------------------------------------------------------------- ios */
if (targets.has('ios')) {
  if (!existsSync(IOS_ASSETS)) {
    console.warn('gen-icons: apps/mobile/ios missing — skipped.');
  } else {
    render(fullBleed(0.8), 1024, join(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'));
    for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
      render(fullBleed(0.22), 2732, join(IOS_ASSETS, 'Splash.imageset', name));
    }
  }
}

/* --------------------------------------------------------------- desktop */
if (targets.has('desktop')) {
  // Tauri icon set (regenerate with `pnpm tauri icon` if the bundle format changes).
  const tauriPng = (size, name) => {
    const out = join(TAURI_ICONS, name);
    render(fullBleed(0.82), size, out);
    ensureRgba(out);
    return out;
  };
  tauriPng(1024, 'icon.png');
  tauriPng(32, '32x32.png');
  tauriPng(128, '128x128.png');
  tauriPng(256, '128x128@2x.png');
  if (
    !writeIco(join(TAURI_ICONS, 'icon.ico'), [
      join(TAURI_ICONS, '128x128@2x.png'),
      join(TAURI_ICONS, '128x128.png'),
      join(TAURI_ICONS, '32x32.png'),
    ])
  ) {
    console.warn('gen-icons: ImageMagick missing — skipped Tauri icon.ico');
  } else {
    written += 1;
  }
  try {
    const entries = [];
    for (const [type, size] of [['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024]]) {
      const png = join(TMP, `icns-${size}-${type}.png`);
      render(fullBleed(0.82), size, png);
      ensureRgba(png);
      entries.push([type, readFileSync(png)]);
    }
    writeIcns(join(TAURI_ICONS, 'icon.icns'), entries);
    written += 1;
    console.log(`  apps/desktop/src-tauri/icons/icon.icns`);
  } catch (err) {
    console.warn(`gen-icons: skipped Tauri icon.icns (${err.message})`);
  }
  for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    const out = join(TAURI_ICONS, `Square${size}x${size}Logo.png`);
    render(fullBleed(0.82), size, out);
    ensureRgba(out);
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`gen-icons: ${written} file(s) written with ${RASTER.bin}`);
