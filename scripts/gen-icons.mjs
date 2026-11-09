#!/usr/bin/env node
/**
 * gen-icons.mjs — every deUrge icon, generated from one source of truth.
 *
 * Source of truth (owned by the web app):
 *   apps/web/public/icons/icon.svg  512x512 rounded-square deUrge mark
 *   apps/web/public/favicon.svg      64x64  simplified mark
 *
 * Generated (committed; regenerate with `pnpm icons`):
 *   apps/web/public/icons/icon-192.png             PWA any
 *   apps/web/public/icons/icon-512.png             PWA any
 *   apps/web/public/icons/icon-maskable-512.png    PWA maskable (full-bleed, 80% safe-area inset)
 *   apps/web/public/icons/apple-touch-icon-180.png iOS home screen (full-bleed)
 *   apps/web/public/favicon-32.png                 legacy favicon
 *   apps/desktop/build/icon.png                    electron-builder source (1024)
 *   apps/desktop/build/icons/<n>.png                Linux icon set 16..512
 *   apps/desktop/build/icon.ico                    Windows
 *   apps/desktop/build/icon.icns                   macOS (PNG-in-ICNS container)
 *   apps/mobile/android/app/src/main/res/**        adaptive + legacy launcher icons
 *   apps/mobile/ios/App/App/Assets.xcassets/**     iOS app icon + launch splash
 *
 * Usage: node scripts/gen-icons.mjs [web|desktop|android|ios|all]   (default: all)
 *
 * Tooling: librsvg (`rsvg-convert`) is preferred; ImageMagick (`magick`) is a
 * fallback. Both are only needed to *regenerate* icons — the generated PNGs
 * are committed, so normal builds and CI do not need them.
 *
 * No network access, no third-party services.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PUBLIC = join(ROOT, 'apps/web/public');
const WEB_ICONS = join(WEB_PUBLIC, 'icons');
const DESKTOP_BUILD = join(ROOT, 'apps/desktop/build');
const ANDROID_RES = join(ROOT, 'apps/mobile/android/app/src/main/res');
const IOS_ASSETS = join(ROOT, 'apps/mobile/ios/App/App/Assets.xcassets');
const TMP = join(tmpdir(), `deurge-icons-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const BRAND = '#0071E3';

/* ------------------------------------------------------------------ tools */

function findTool() {
  const candidates = [
    ['rsvg-convert', (svg, size, out) => ['-w', String(size), '-h', String(size), svg, '-o', out]],
    [
      'magick',
      (svg, size, out) => ['-background', 'none', '-density', '384', svg, '-resize', `${size}x${size}`, out],
    ],
  ];
  for (const [bin, args] of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return { bin, args };
    } catch {
      /* try next */
    }
  }
  throw new Error('gen-icons: need librsvg (rsvg-convert) or ImageMagick (magick) on PATH');
}

const RASTER = findTool();

function render(svgText, size, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const svgPath = join(TMP, `src-${size}-${Math.random().toString(36).slice(2, 8)}.svg`);
  writeFileSync(svgPath, svgText, 'utf8');
  execFileSync(RASTER.bin, RASTER.args(svgPath, size, outPath), { stdio: 'ignore' });
  rmSync(svgPath, { force: true });
}

/* --------------------------------------------------- svg variant builders */

/** Split a single-root inline SVG into `<svg attrs>` header and inner markup. */
function svgParts(text) {
  const m = text.match(/^(<svg\b[^>]*>)([\s\S]*?)(<\/svg>\s*)$/);
  if (!m) throw new Error('gen-icons: unexpected SVG structure');
  return { open: m[1], inner: m[2] };
}

const MARK = svgParts(readFileSync(join(WEB_ICONS, 'icon.svg'), 'utf8'));
const markInner = MARK.inner;
/** The rounded-square background rect of the mark (also used as its own bg). */
const markBgRe = /<rect\b[^>]*\bfill="#0071E3"[^>]*\/>/;
if (!markBgRe.test(markInner)) {
  throw new Error('gen-icons: icon.svg background rect (fill="#0071E3") not found');
}

/** Wrap the full mark in an extra transform, preserving its own background. */
function wrapMark(transform) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><g transform="${transform}">${markInner}</g></svg>\n`;
}

/** Mark with no background rect — for adaptive-icon foreground layers. */
function transparentMark(scale = 1) {
  const inner = markInner.replace(markBgRe, '');
  const xform = `translate(256 256) scale(${scale}) translate(-256 -256)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><g transform="${xform}">${inner}</g></svg>\n`;
}

/** Full-bleed brand background + inset mark (safe area for platform masks). */
function fullBleed(scale) {
  return wrapMark(`translate(256 256) scale(${scale}) translate(-256 -256)`);
}

/* ------------------------------------------------------------- icns (mac) */

/**
 * Minimal PNG-in-ICNS writer. macOS 10.7+ accepts PNG payloads for the
 * ic07..ic14 element types, which is exactly what electron-builder expects.
 */
function writeIcns(outPath, entries) {
  const chunks = [];
  for (const [type, png] of entries) {
    const len = 8 + png.length;
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(len, 4);
    chunks.push(head, png);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(8 + body.length, 4);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.concat([header, body]));
}

/* ------------------------------------------------------------------- main */

const targets = new Set(
  (process.argv[2] ?? 'all') === 'all'
    ? ['web', 'desktop', 'android', 'ios']
    : [process.argv[2]].filter(Boolean),
);

const written = [];
function record(p) {
  written.push(p);
}

/* web (PWA + favicon) — the mark is already a rounded square, so `any` icons
   keep its transparent corners; maskable/apple variants are full-bleed. */
if (targets.has('web')) {
  const any = (size, name) => {
    const out = join(WEB_ICONS, name);
    render(`${MARK.open}${markInner}</svg>\n`, size, out);
    record(out);
  };
  any(192, 'icon-192.png');
  any(512, 'icon-512.png');

  const maskable = join(WEB_ICONS, 'icon-maskable-512.png');
  render(fullBleed(0.8), 512, maskable);
  record(maskable);

  const apple = join(WEB_ICONS, 'apple-touch-icon-180.png');
  render(fullBleed(0.86), 180, apple);
  record(apple);

  // Legacy favicon PNG: the 64-unit viewBox favicon.svg scales cleanly.
  const favicon = svgParts(readFileSync(join(WEB_PUBLIC, 'favicon.svg'), 'utf8'));
  const fav = join(WEB_PUBLIC, 'favicon-32.png');
  render(`${favicon.open.replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64"')}${favicon.inner}</svg>\n`, 32, fav);
  record(fav);
}

/* desktop (Electron) — electron-builder reads build/icon.png + icon.ico/icns */
if (targets.has('desktop')) {
  const big = join(DESKTOP_BUILD, 'icon.png');
  render(`${MARK.open}${markInner}</svg>\n`, 1024, big);
  record(big);

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const out = join(DESKTOP_BUILD, 'icons', `${size}x${size}.png`);
    render(`${MARK.open}${markInner}</svg>\n`, size, out);
    record(out);
  }

  try {
    const ico = join(DESKTOP_BUILD, 'icon.ico');
    execFileSync('magick', [
      big,
      '-define',
      'icon:auto-resize=256,128,64,48,32,16',
      ico,
    ]);
    record(ico);
  } catch {
    console.warn('gen-icons: ImageMagick missing — skipped desktop icon.ico');
  }

  try {
    const entries = [];
    for (const [type, size] of [
      ['ic11', 32],
      ['ic12', 64],
      ['ic07', 128],
      ['ic13', 256],
      ['ic09', 512],
      ['ic14', 512],
      ['ic10', 1024],
    ]) {
      const png = join(TMP, `icns-${size}-${type}.png`);
      render(`${MARK.open}${markInner}</svg>\n`, size, png);
      entries.push([type, readFileSync(png)]);
    }
    const icns = join(DESKTOP_BUILD, 'icon.icns');
    writeIcns(icns, entries);
    record(icns);
  } catch (err) {
    console.warn(`gen-icons: skipped icon.icns (${err.message})`);
  }
}

/* android — Capacitor project must exist (npx cap add android) */
if (targets.has('android')) {
  if (!existsSync(ANDROID_RES)) {
    console.warn('gen-icons: apps/mobile/android missing — run `npx cap add android` first; skipped.');
  } else {
    const densities = {
      mdpi: 1,
      hdpi: 1.5,
      xhdpi: 2,
      xxhdpi: 3,
      xxxhdpi: 4,
    };
    const full = `${MARK.open}${markInner}</svg>\n`;
    for (const [density, factor] of Object.entries(densities)) {
      const dir = join(ANDROID_RES, `mipmap-${density}`);
      // Legacy launcher icon: 48dp
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
        const out = join(dir, name);
        render(full, Math.round(48 * factor), out);
        record(out);
      }
      // Adaptive foreground: 108dp canvas, mark kept inside the 66dp safe circle
      const fg = join(dir, 'ic_launcher_foreground.png');
      render(transparentMark(0.95), Math.round(108 * factor), fg);
      record(fg);
    }
    // Android 12+ splash icon (240dp masked by the system) + legacy splash
    // drawable (120dp intrinsic size, centered by launch_background.xml).
    for (const [density, factor] of Object.entries(densities)) {
      const splash = join(ANDROID_RES, `drawable-${density}`, 'splash_icon.png');
      render(transparentMark(1), Math.round(120 * factor), splash);
      record(splash);
    }
    // Keep a base-density fallback for resource resolution edge cases.
    const splashFallback = join(ANDROID_RES, 'drawable', 'splash_icon.png');
    render(transparentMark(1), 240, splashFallback);
    record(splashFallback);
  }
}

/* ios — AppIcon + launch screen splash (SPM project, no CocoaPods) */
if (targets.has('ios')) {
  if (!existsSync(IOS_ASSETS)) {
    console.warn('gen-icons: apps/mobile/ios missing — run `npx cap add ios` first; skipped.');
  } else {
    // iOS masks the icon itself; use a full-bleed brand field with the mark inset.
    const icon = join(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png');
    render(fullBleed(0.82), 1024, icon);
    record(icon);

    // LaunchScreen.storyboard scales Splash aspect-fill to the whole screen.
    for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
      const splash = join(IOS_ASSETS, 'Splash.imageset', name);
      render(fullBleed(0.22), 2732, splash);
      record(splash);
    }
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`gen-icons: ${written.length} file(s) written with ${RASTER.bin}`);
for (const p of written) console.log(`  ${p.replace(ROOT + '/', '')}`);
