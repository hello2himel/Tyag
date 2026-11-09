/** Tiny hash router: works identically on Netlify, Electron's custom
 * protocol and the Capacitor WebViews (no server-side rewrites needed). */
import { useCallback, useEffect, useState } from 'react';

export type RouteName = 'trackers' | 'tracker' | 'journal' | 'insights' | 'settings' | 'data';

export interface Route {
  name: RouteName;
  trackerId?: string;
  query: URLSearchParams;
  hash: string;
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

export function navigate(path: string): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const onChange = useCallback(() => {
    setRoute(parseRoute(window.location.hash));
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);
  useEffect(() => {
    window.addEventListener('hashchange', onChange);
    if (!window.location.hash) window.location.replace('#/trackers');
    return () => window.removeEventListener('hashchange', onChange);
  }, [onChange]);
  return route;
}
