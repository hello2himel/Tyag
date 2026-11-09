#!/usr/bin/env node
/**
 * audit-privacy.mjs — fail the build if the shipped web bundle could talk to
 * the network or pull in third-party resources.
 *
 * deUrge is a local-first, offline app: the built bundle must be fully
 * self-contained. This audit scans apps/web/dist (and the app manifests) for:
 *
 *   FAIL
 *     - known analytics/telemetry/ad hosts anywhere in the bundle
 *     - absolute http(s)/ws(s) URLs in network-capable positions:
 *         fetch('https://…'), new WebSocket('wss://…'), EventSource,
 *         navigator.sendBeacon, XMLHttpRequest.open(…, 'https://…'),
 *         dynamic import('https://…'), serviceWorker.register('https://…')
 *     - remote assets referenced from HTML (src/href/poster) or CSS url(…)
 *     - analytics SDKs in any package.json dependency list
 *   INFO
 *     - inert absolute URLs that only appear as strings (XML namespaces,
 *       library documentation links). Reported so reviewers can see them, but
 *       they are not network calls.
 *
 * Usage: node scripts/audit-privacy.mjs [distDir]
 * Exit:  0 clean, 1 violations (or missing build), 2 usage error.
 *
 * No network access, no third-party dependencies.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(process.argv[2] ?? join(ROOT, 'apps/web/dist'));

const SCANNED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.txt',
  '.xml',
]);

/** Hosts that must never appear in a local-first bundle. */
const FORBIDDEN_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'app-measurement.com',
  'firebaseio.com',
  'crashlytics.com',
  'sentry.io',
  'sentry-cdn.com',
  'segment.com',
  'segment.io',
  'mixpanel.com',
  'amplitude.com',
  'heap.io',
  'fullstory.com',
  'hotjar.com',
  'hotjar.io',
  'mouseflow.com',
  'logrocket.com',
  'smartlook.com',
  'inspectlet.com',
  'clarity.ms',
  'posthog.com',
  'plausible.io',
  'umami.is',
  'matomo.cloud',
  'statcounter.com',
  'quantserve.com',
  'scorecardresearch.com',
  'connect.facebook.net',
  'analytics.twitter.com',
  'ads-twitter.com',
  'static.licdn.com',
  'tiktok.com',
  'appsflyer.com',
  'adjust.com',
  'branch.io',
  'kochava.com',
  'newrelic.com',
  'nr-data.net',
  'datadoghq.com',
  'bugsnag.com',
  'rollbar.com',
  'raygun.io',
  'honeybadger.io',
  'cloudflareinsights.com',
  'vercel-insights.com',
  'optimizely.com',
  'vwo.com',
  'crazyegg.com',
];

/** Package names we refuse to ship (telemetry/analytics SDKs). */
const FORBIDDEN_PACKAGES = [
  /^@sentry\//,
  /^@datadog\//,
  /^@amplitude\//,
  /^@segment\//,
  /^@vercel\/(analytics|speed-insights)$/,
  /^@google-analytics\//,
  /^@firebase\//,
  /^firebase$/,
  /^posthog-js$/,
  /^mixpanel/,
  /^amplitude/,
  /^bugsnag/,
  /^newrelic$/,
  /^react-ga/,
  /^react-gtm/,
  /^umami/,
  /^plausible/,
  /^matomo/,
  /^hotjar/,
  /^fullstory/,
  /^logrocket/,
  /^statsig/,
  /^launchdarkly/,
  /^@growthbook\//,
];

/** Absolute URLs that are only inert strings (namespaces / docs). */
const INERT_URL_PREFIXES = [
  'http://www.w3.org/',
  'https://www.w3.org/',
  'http://www.w3.org/1999/',
  'https://react.dev/',
  'https://bugs.chromium.org/',
  'https://bit.ly/',
  'https://developer.mozilla.org/',
  'https://developer.chrome.com/',
  'https://developer.apple.com/',
  'https://capacitorjs.com/',
  'https://github.com/',
  'https://flathub.org/',
  'https://dl.flathub.org/',
  'https://unpkg.com/',
];

const problems = [];
const infoHosts = new Map();

const fail = (file, message) => problems.push({ file, message });
const addHost = (host, file) => {
  if (!host) return;
  if (!infoHosts.has(host)) infoHosts.set(host, new Set());
  infoHosts.get(host).add(file);
};

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }
  return files;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function scanText(file, text) {
  const rel = relative(DIST, file) || file;

  // 1. known tracker hosts, anywhere.
  const lower = text.toLowerCase();
  for (const host of FORBIDDEN_HOSTS) {
    const at = lower.indexOf(host);
    if (at !== -1) {
      fail(rel, `forbidden third-party host "${host}" (line ~${lineOf(text, at)})`);
    }
  }

  // 2. absolute URLs in network-capable calls.
  const networkPatterns = [
    [/\bfetch\s*\(\s*([`'"])(?:https?|wss?):\/\//gi, 'fetch() to an absolute URL'],
    [/\bimportScripts\s*\(\s*([`'"])(?:https?):\/\//gi, 'importScripts() remote script'],
    [/\bnew\s+(?:WebSocket|EventSource)\s*\(\s*([`'"])(?:https?|wss?):\/\//gi, 'WebSocket/EventSource to an absolute URL'],
    [/\bsendBeacon\s*\(\s*([`'"])(?:https?):\/\//gi, 'navigator.sendBeacon() to an absolute URL'],
    [/\.open\s*\(\s*[`'"](?:GET|POST|PUT|DELETE|PATCH|HEAD)[`'"]\s*,\s*[`'"](?:https?):\/\//gi, 'XMLHttpRequest to an absolute URL'],
    [/\bimport\s*\(\s*[`'"](?:https?):\/\//gi, 'dynamic import() of a remote module'],
    [/\.register\s*\(\s*[`'"](?:https?):\/\//gi, 'service worker registered from a remote URL'],
    [/\bfetch\s*\(\s*[`'"]\/\//gi, 'protocol-relative fetch() URL'],
  ];
  for (const [pattern, label] of networkPatterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      fail(rel, `${label} (line ~${lineOf(text, match.index)}): ${match[0].slice(0, 90)}`);
    }
  }

  // 3. remote assets from markup / stylesheets.
  const attributePattern = /\b(?:src|href|poster|data|action|formaction)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi;
  let attrMatch;
  while ((attrMatch = attributePattern.exec(text)) !== null) {
    fail(rel, `remote resource reference "${attrMatch[1]}" (line ~${lineOf(text, attrMatch.index)})`);
  }
  const cssUrlPattern = /url\(\s*['"]?((?:https?:)?\/\/[^)'"]+)['"]?\s*\)/gi;
  let cssMatch;
  while ((cssMatch = cssUrlPattern.exec(text)) !== null) {
    fail(rel, `remote CSS resource "${cssMatch[1]}" (line ~${lineOf(text, cssMatch.index)})`);
  }

  // 4. informational: every remaining absolute URL host.
  const urlPattern = /\bhttps?:\/\/([a-z0-9.-]+)/gi;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(text)) !== null) {
    const full = urlMatch[0].endsWith('/') ? urlMatch[0] : `${urlMatch[0]}/`;
    if (INERT_URL_PREFIXES.some((prefix) => full.startsWith(prefix))) continue;
    addHost(urlMatch[1], rel);
  }
}

/** Scan the dependency lists of the shipped app packages. */
function scanPackages() {
  const packages = [
    join(ROOT, 'package.json'),
    join(ROOT, 'apps/web/package.json'),
    join(ROOT, 'apps/mobile/package.json'),
    join(ROOT, 'apps/desktop/package.json'),
  ];
  for (const pkgs of packages) {
    if (!existsSync(pkgs)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgs, 'utf8'));
    } catch (error) {
      fail(relative(ROOT, pkgs), `unreadable package.json: ${error.message}`);
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(deps)) {
      if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(name))) {
        fail(relative(ROOT, pkgs), `forbidden telemetry/analytics dependency "${name}"`);
      }
    }
  }
}

function main() {
  if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
    console.error(`audit-privacy: dist directory not found: ${DIST}`);
    console.error('audit-privacy: build the web app first (pnpm --filter @deurge/web build)');
    process.exit(2);
  }

  const files = walk(DIST);
  let bytes = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    bytes += text.length;
    scanText(file, text);
  }
  scanPackages();

  console.log(`audit-privacy: scanned ${files.length} files (${(bytes / 1024).toFixed(1)} KB) in ${relative(ROOT, DIST)}/`);

  if (infoHosts.size > 0) {
    console.log('audit-privacy: external URL hosts found as inert strings (not fetched):');
    for (const [host, sources] of [...infoHosts.entries()].sort()) {
      const list = [...sources].slice(0, 3).join(', ');
      console.log(`  - ${host} (${sources.size} file(s): ${list}${sources.size > 3 ? ', …' : ''})`);
    }
  }

  if (problems.length > 0) {
    console.error(`\naudit-privacy: FAILED — ${problems.length} violation(s):`);
    for (const { file, message } of problems) console.error(`  ✗ ${file}: ${message}`);
    console.error('\nThe shipped bundle must be fully offline. Remove the offending asset/call.');
    process.exit(1);
  }

  console.log('audit-privacy: PASS — bundle is self-contained and offline-only');
}

main();
