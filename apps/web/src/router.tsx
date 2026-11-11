/** Tiny hash router: works identically on Netlify, the Tauri asset protocol
 * and the Capacitor WebViews (no server-side rewrites needed).
 *
 * Navigation is written with the History API (`pushState`/`replaceState`) and
 * a synthetic `hashchange` instead of assigning `location.hash`:
 *
 *   - a synthetic event keeps `useRoute` as the single source of truth while
 *     making the history write explicit (needed for `replace` and for clearing
 *     a previous entry's `history.state`);
 *   - programmatic navigation never fires a native `popstate`, so the back
 *     dispatcher (platform/back.ts) cannot mistake a route change for a
 *     browser/hardware back press.
 *
 * When a back-layer sentinel is holding the current history entry (an overlay,
 * the lock screen or an onboarding step is open), the write is deferred until
 * the sentinel has been unwound. Writing on top of the sentinel would leave a
 * duplicate entry behind and a later back press could replay an already
 * consumed `?new=1` deep link.
 */
import { useCallback, useEffect, useState } from 'react';
import { isOnBackSentinel, queueAfterSentinelPop } from './platform/back';

export type RouteName = 'trackers' | 'tracker' | 'journal' | 'insights' | 'settings' | 'data';

export interface Route {
  name: RouteName;
  trackerId?: string;
  query: URLSearchParams;
  hash: string;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  replace?: boolean;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/trackers';
  const [pathPart = '/trackers', searchPart = ''] = raw.split('?');
  const query = new URLSearchParams(searchPart);
  const segments = pathPart.split('/').filter(Boolean);
  const head = segments[0] ?? 'trackers';
  if (head === 'tracker' && segments[1]) return { name: 'tracker', trackerId: segments[1], query, hash: raw };
  if (head === 'journal') return { name: 'journal', query, hash: raw };
  if (head === 'insights') return { name: 'insights', query, hash: raw };
  if (head === 'settings') return { name: 'settings', query, hash: raw };
  if (head === 'data') return { name: 'data', query, hash: raw };
  return { name: 'trackers', query, hash: raw };
}

/**
 * Write the new URL and notify `useRoute` without relying on the browser's
 * native `hashchange` (which `pushState`/`replaceState` do not emit).
 */
function commitNavigation(target: string, replace: boolean): void {
  const before = window.location.hash;
  if (typeof HashChangeEvent !== 'function') {
    // Ancient WebViews without the constructor: let the browser perform a
    // real fragment navigation (which does emit `hashchange` natively).
    if (replace) window.location.replace(target);
    else window.location.hash = target;
    return;
  }
  if (replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  if (window.location.hash !== before) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

export function navigate(path: string, options: NavigateOptions = {}): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  const replace = options.replace === true;
  // Push-style navigation to the current route is a no-op, exactly like the
  // old `location.hash` assignment (which ignored identical hashes).
  if (!replace && window.location.hash === target) return;
  const commit = () => commitNavigation(target, replace);
  if (isOnBackSentinel()) {
    queueAfterSentinelPop(commit);
    return;
  }
  commit();
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const onChange = useCallback(() => {
    setRoute(parseRoute(window.location.hash));
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);
  useEffect(() => {
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, [onChange]);
  return route;
}
