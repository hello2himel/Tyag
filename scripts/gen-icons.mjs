#!/usr/bin/env node
/**
 * gen-icons.mjs, every Tyag icon, generated from the official brand kit.
 *
 * Source of truth (committed):
 *   assets/brand/app-icons/{web,android,ios}/   prebuilt brand-kit exports
 *   assets/brand/logos/symbol-tile-*.svg        in-app tile/glyph
 *   assets/brand/og-image-1200x630.png          social card
 *
 * Outputs (committed):
 *   apps/web/public/**                          PWA/favicons/OG card
 *   apps/mobile/android/app/src/main/res/**      adaptive + legacy + splash
 *   apps/mobile/ios/App/App/Assets.xcassets/**  app icon + launch splash
 *   apps/desktop/src-tauri/icons/**             Tauri bundle icons
 *
 * Tooling: Python Pillow for raster work (regeneration only; outputs are
 * committed) and ImageMagick for .ico. No network access.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = join(ROOT, 'assets/brand');
const KIT_ICONS = join(BRAND, 'app-icons');
const KIT_LOGOS = join(BRAND, 'logos');
const WEB = join(ROOT, 'apps/web/public');
const WEB_ICONS = join(WEB, 'icons');
const ANDROID_RES = join(ROOT, 'apps/mobile/android/app/src/main/res');
const IOS_ASSETS = join(ROOT, 'apps/mobile/ios/App/App/Assets.xcassets');
const TAURI_ICONS = join(ROOT, 'apps/desktop/src-tauri/icons');
const TMP = join(tmpdir(), `tyag-icons-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const targets = new Set(
  (process.argv[2] ?? 'all') === 'all' ? ['web', 'android', 'ios', 'desktop'] : [process.argv[2]].filter(Boolean),
);

function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

function copy(src, dest) {
  mkdirp(dirname(dest));
  copyFileSync(src, dest);
}

/** Resize a PNG with Pillow and force the given mode (RGBA for Tauri, RGB for iOS). */
function resize(src, size, dest, mode = 'RGBA') {
  mkdirp(dirname(dest));
  execFileSync('python3', [
    '-c',
    [
      'from PIL import Image',
      'import sys',
      `im = Image.open(sys.argv[1]).convert(${JSON.stringify(mode)})`,
      `im = im.resize((int(sys.argv[2]), int(sys.argv[2])), Image.LANCZOS)`,
      'im.save(sys.argv[3])',
    ].join('\n'),
    src,
    String(size),
    dest,
  ]);
}

/** Compose the tile logo centred on a solid launch background. */
function splash(src, bg, width, dest) {
  mkdirp(dirname(dest));
  execFileSync('python3', [
    '-c',
    [
      'from PIL import Image',
      'import sys',
      'bg = Image.open(sys.argv[2]).convert("RGB").resize((2732, 2732))',
      'logo = Image.open(sys.argv[1]).convert("RGBA")',
      `w = int(sys.argv[3]); h = int(w * logo.height / logo.width)`,
      'logo = logo.resize((w, h), Image.LANCZOS)',
      'canvas = bg.copy()',
      'canvas.paste(logo, ((2732 - w) // 2, (2732 - h) // 2), logo)',
      'canvas.save(sys.argv[4])',
    ].join('\n'),
    src,
    bg,
    String(width),
    dest,
  ]);
}

const ICNS_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic09', 512],
  ['ic14', 512],
  ['ic10', 1024],
];

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
  mkdirp(dirname(outPath));
  writeFileSync(outPath, Buffer.concat([header, body]));
}

/* ------------------------------------------------------------------- web */
if (targets.has('web')) {
  for (const [name, dest] of [
    ['icon-192.png', join(WEB_ICONS, 'icon-192.png')],
    ['icon-512.png', join(WEB_ICONS, 'icon-512.png')],
    ['icon-maskable-512.png', join(WEB_ICONS, 'icon-maskable-512.png')],
    ['apple-touch-icon-180.png', join(WEB_ICONS, 'apple-touch-icon-180.png')],
    ['favicon.svg', join(WEB, 'favicon.svg')],
    ['favicon.ico', join(WEB, 'favicon.ico')],
    ['favicon-16.png', join(WEB, 'favicon-16.png')],
    ['favicon-32.png', join(WEB, 'favicon-32.png')],
    ['favicon-48.png', join(WEB, 'favicon-48.png')],
  ]) {
    copy(join(KIT_ICONS, 'web', name), dest);
  }
  copy(join(KIT_ICONS, 'ios', 'AppIcon-1024.png'), join(WEB_ICONS, 'icon-1024.png'));
  copy(join(BRAND, 'og-image-1200x630.png'), join(WEB, 'og-image-1200x630.png'));
  copy(join(KIT_LOGOS, 'symbol-tile-black.svg'), join(WEB_ICONS, 'icon.svg'));
  copy(join(KIT_LOGOS, 'symbol-tile-white.svg'), join(WEB_ICONS, 'icon-dark.svg'));
  copy(join(KIT_LOGOS, 'glyph-black.svg'), join(WEB_ICONS, 'mark.svg'));
  console.log('web icons copied');
}

/* --------------------------------------------------------------- android */
if (targets.has('android')) {
  if (!existsSync(ANDROID_RES)) {
    console.warn('gen-icons: apps/mobile/android missing, skipped.');
  } else {
    const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
    const layer = (name) => join(KIT_ICONS, 'android', name);
    for (const [density, factor] of Object.entries(densities)) {
      const dir = join(ANDROID_RES, `mipmap-${density}`);
      for (const [src, out] of [
        ['ic_launcher_foreground_432.png', 'ic_launcher_foreground.png'],
        ['ic_launcher_background_432.png', 'ic_launcher_background.png'],
        ['ic_launcher_monochrome_432.png', 'ic_launcher_monochrome.png'],
      ]) {
        resize(layer(src), Math.round(108 * factor), join(dir, out), 'RGBA');
      }
      for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
        resize(layer('playstore-icon-512.png'), Math.round(48 * factor), join(dir, name), 'RGBA');
      }
    }
    // Android 12+ splash: white peak on the black brand field.
    for (const [density, factor] of Object.entries(densities)) {
      const dir = join(ANDROID_RES, `drawable-${density}`);
      resize(layer('ic_launcher_foreground_432.png'), Math.round(120 * factor), join(dir, 'splash_icon.png'), 'RGBA');
    }
    resize(layer('ic_launcher_foreground_432.png'), 240, join(ANDROID_RES, 'drawable/splash_icon.png'), 'RGBA');
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
    for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      mkdirp(join(ANDROID_RES, 'mipmap-anydpi-v26'));
      writeFileSync(join(ANDROID_RES, 'mipmap-anydpi-v26', name), adaptive);
    }
    const colors = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Tyag brand (Nov 2026 kit): black/white core with an optional orange accent. -->
    <color name="colorPrimary">#000000</color>
    <color name="colorPrimaryDark">#000000</color>
    <color name="colorAccent">#FF4B2B</color>

    <color name="tyag_brand">#000000</color>
    <color name="tyag_canvas">#000000</color>
    <color name="tyag_ink">#FFFFFF</color>
</resources>
`;
    writeFileSync(join(ANDROID_RES, 'values/colors.xml'), colors);
    rmSync(join(ANDROID_RES, 'values/ic_launcher_background.xml'), { force: true });
    console.log('android icons generated');
  }
}

/* ------------------------------------------------------------------- ios */
if (targets.has('ios')) {
  if (!existsSync(IOS_ASSETS)) {
    console.warn('gen-icons: apps/mobile/ios missing, skipped.');
  } else {
    copy(join(KIT_ICONS, 'ios', 'AppIcon-1024.png'), join(IOS_ASSETS, 'AppIcon.appiconset/AppIcon-512@2x.png'));
    const white = join(TMP, 'white-2732.png');
    execFileSync('python3', [
      '-c',
      'from PIL import Image; Image.new("RGB", (2732, 2732), "#FFFFFF").save("' + white + '")',
    ]);
    for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
      splash(join(KIT_ICONS, 'android', 'playstore-icon-512.png'), white, 560, join(IOS_ASSETS, 'Splash.imageset', name));
    }
    console.log('ios icons generated');
  }
}

/* --------------------------------------------------------------- desktop */
if (targets.has('desktop')) {
  const source = join(KIT_ICONS, 'ios', 'AppIcon-1024.png');
  resize(source, 1024, join(TAURI_ICONS, 'icon.png'), 'RGBA');
  resize(source, 32, join(TAURI_ICONS, '32x32.png'), 'RGBA');
  resize(source, 128, join(TAURI_ICONS, '128x128.png'), 'RGBA');
  resize(source, 256, join(TAURI_ICONS, '128x128@2x.png'), 'RGBA');
  try {
    execFileSync('magick', [
      join(TAURI_ICONS, '128x128@2x.png'),
      join(TAURI_ICONS, '128x128.png'),
      join(TAURI_ICONS, '32x32.png'),
      '-define',
      'icon:auto-resize=256,128,64,48,32,16',
      join(TAURI_ICONS, 'icon.ico'),
    ]);
  } catch {
    console.warn('gen-icons: ImageMagick missing, skipped Tauri icon.ico');
  }
  const entries = [];
  for (const [type, size] of ICNS_TYPES) {
    const png = join(TMP, `icns-${size}-${type}.png`);
    resize(source, size, png, 'RGBA');
    entries.push([type, readFileSync(png)]);
  }
  writeIcns(join(TAURI_ICONS, 'icon.icns'), entries);
  for (const size of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    resize(source, size, join(TAURI_ICONS, `Square${size}x${size}Logo.png`), 'RGBA');
  }
  console.log('desktop (Tauri) icons generated');
}

rmSync(TMP, { recursive: true, force: true });
console.log('gen-icons: done');
