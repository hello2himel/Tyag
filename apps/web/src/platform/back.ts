/**
 * Unified logical "back" dispatcher for every Tyag target.
 *
 * Tyag ships one shared web bundle to four shells with very different back
 * affordances:
 *
 *   - web / PWA          browser back button, Alt+Left / Cmd+[ keyboard
 *   - Android Capacitor  hardware / gesture back, forwarded by the local
 *                        `TyagBack` Capacitor plugin as a `backButton` event
 *   - iOS Capacitor      edge-swipe gesture (owned natively, forwarded through
 *                        the same plugin) plus keyboard on iPad
 *   - Tauri desktop      Alt+Left / Cmd+[ keyboard only
 *
 * Everything is funnelled through a single LIFO stack of logical handlers, so
 * a sheet, an onboarding step, the app lock and the router all agree on what
 * "back" means without knowing which platform fired it:
 *
 *   runBack() asks the topmost handler. A handler that returns `false` says
 *   "not handled" and stays registered (the next back press asks it again);
 *   returning `true`/`void` consumes the press.
 *
 * History sentinels (web/PWA + iOS)
 * ---------------------------------
 * A browser/system back that nothing intercepts navigates the WebView's
 * session history away from the app. To keep that logical back inside the
 * app, every registered handler ("layer") implicitly owns the task of keeping
 * a sentinel history entry on top of the stack:
 *
 *   - when the first handler is registered we `pushState({__tyagBack: id})`
 *     with the *current* URL (same URL => popping it never changes the route);
 *   - a `popstate` that consumes that entry is translated into `runBack()`;
 *     after a handled press we immediately push a fresh sentinel so nested
 *     layers stay protected;
 *   - on a programmatic close we unwind the sentinel ourselves with a
 *     suppressed `history.back()` so no duplicate/dangling entries remain;
 *   - layers share one sentinel instead of one each: only the *count* of open
 *     layers matters for the sentinel, and `runBack()` already unwinds the
 *     logical stack one layer at a time.
 *
 * Android deliberately does not use sentinels: the native side forwards every
 * hardware back press through the plugin, so the WebView history must stay
 * untouched. Tauri has no system back at all (keyboard only), so sentinels
 * are skipped there too.
 *
 * Navigation while a sentinel is armed
 * ------------------------------------
 * `router.navigate()` may run while a layer sentinel is on the current entry
 * (e.g. a sheet closes and navigates in the same event). Replacing/pushing on
 * top of the sentinel would leave a stale entry behind (and a later back click
 * could replay an already-consumed `?new=1` target). `queueAfterSentinelPop()`
 * therefore unwinds the sentinel first and runs the navigation once the pop
 * has landed, so the resulting stack is exactly what a user expects.
 *
 * The module is dependency-free apart from the already-bundled Capacitor core,
 * SSR-safe (every entry point guards for `window`) and StrictMode-safe: effects
 * register once per enabled transition, clean up by identity and tolerate the
 * mount -> unmount -> mount cycle React performs in development.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { useEffect, useRef } from 'react';
import { isTauriDesktop } from './db';

/* ------------------------------- platform -------------------------------- */

export type BackPlatform = 'web' | 'android' | 'ios' | 'tauri';

/** Where this bundle is running. Safe to call before the DOM exists. */
export function backPlatform(): BackPlatform {
  if (typeof window === 'undefined') return 'web';
  if (isTauriDesktop()) return 'tauri';
  if (Capacitor.isNativePlatform()) {
    const platform = Capacitor.getPlatform();
    if (platform === 'android') return 'android';
    if (platform === 'ios') return 'ios';
  }
  return 'web';
}

/**
 * Sentinel entries are required wherever there is a browser/system UI back
 * that would otherwise navigate the document: the web/PWA browser chrome and
 * the iOS swipe gesture. Android gets native events instead and Tauri only has
 * keyboard shortcuts (which we dispatch ourselves).
 */
function usesHistorySentinel(): boolean {
  const platform = backPlatform();
  return platform === 'web' || platform === 'ios';
}

/* ----------------------------- native bridge ----------------------------- */

interface TyagBackPlugin {
  exitApp(): Promise<void>;
  addListener(
    eventName: 'backButton',
    listener: (payload: { canGoBack: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

/** Local Capacitor plugin implemented by apps/mobile (see android/.../back). */
const TyagBack = registerPlugin<TyagBackPlugin>('TyagBack');

/**
 * Ask the native Android shell to close the app. No-op everywhere else: a web
 * page cannot close itself, and both iOS and the desktop shells keep the
 * window in the user's hands.
 */
export function requestExit(): void {
  if (typeof window === 'undefined') return;
  if (backPlatform() !== 'android') return;
  try {
    void Promise.resolve(TyagBack.exitApp()).catch(() => undefined);
  } catch {
    /* Native build without the TyagBack plugin: nothing else we can do. */
  }
}

/* ----------------------------- handler stack ----------------------------- */

export type BackHandler = () => boolean | void;

type BackAction = () => void;

interface RegisteredHandler {
  readonly id: number;
  readonly handler: BackHandler;
}

let handlerSequence = 0;
let sentinelSequence = 0;

/** LIFO stack: the last entry is the first thing back presses reach. */
const handlers: RegisteredHandler[] = [];

/**
 * True while we are deliberately traversing back to unwind our own sentinel.
 * The `popstate` that follows must not be interpreted as a user back press.
 */
let sentinelPopInFlight = false;

/** Id of the sentinel entry we pushed for the current logical layer stack. */
let armedSentinelId: number | null = null;

/** Navigations that must run once an in-flight sentinel pop has landed. */
const afterSentinelPop: BackAction[] = [];

let listenersInstalled = false;
let navigationInitialised = false;

/**
 * The `__tyagBack` marker of the current session-history entry, if any. Only
 * entries we pushed carry it; regular route entries have a `null` state.
 */
function currentSentinelId(): number | null {
  if (typeof window === 'undefined') return null;
  const state: unknown = window.history.state;
  if (state !== null && typeof state === 'object' && '__tyagBack' in state) {
    const marker = (state as { __tyagBack?: unknown }).__tyagBack;
    if (typeof marker === 'number') return marker;
  }
  return null;
}

/** True when the current history entry is a layer sentinel. */
export function isOnBackSentinel(): boolean {
  return currentSentinelId() !== null;
}

/* ------------------------------- sentinels ------------------------------- */

function flushAfterSentinelPop(): void {
  const actions = afterSentinelPop.splice(0);
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      console.warn('[back] deferred navigation failed', error);
    }
  }
}

/**
 * Make sure exactly one sentinel entry protects the currently open layers.
 * Idempotent: registrations from every open layer (and StrictMode remounts)
 * share the same single entry.
 */
function armSentinel(): void {
  if (typeof window === 'undefined') return;
  if (!usesHistorySentinel()) return;
  installListeners();
  if (handlers.length === 0) return;
  if (sentinelPopInFlight) return;
  if (currentSentinelId() !== null) return;
  const id = sentinelSequence + 1;
  try {
    // The URL argument is omitted on purpose: the sentinel entry keeps the very
    // same URL as the current one (so popping it restores the same route, and
    // the dispatcher, not the router, owns the press), and relative-only
    // history writes stay valid on the Capacitor/Tauri custom schemes.
    window.history.pushState({ __tyagBack: id }, '');
  } catch {
    /* History unavailable (e.g. file:// with strict settings): keyboard and
       native handling still work, so degrade silently. */
    return;
  }
  sentinelSequence = id;
  armedSentinelId = id;
}

/**
 * Unwind the sentinel entry we own, then run `after` once the browser has
 * actually traversed back. Used both for programmatic closes (releasing the
 * last layer) and for router navigations that must not leave the sentinel
 * buried underneath a newer entry.
 */
function unwindSentinel(after?: BackAction): void {
  if (typeof window === 'undefined') return;
  if (after) afterSentinelPop.push(after);
  if (sentinelPopInFlight) return;
  if (!usesHistorySentinel() || currentSentinelId() === null) {
    flushAfterSentinelPop();
    return;
  }
  sentinelPopInFlight = true;
  armedSentinelId = null;
  window.history.back();
}

/** Pop the sentinel once the last logical layer has gone away. */
function releaseSentinel(): void {
  if (typeof window === 'undefined') return;
  if (!usesHistorySentinel()) return;
  if (handlers.length > 0) return;
  unwindSentinel();
}

/**
 * Run `action` after the current layer sentinel has been unwound. This is the
 * hook the router uses so `navigate()` during a sheet close never leaves a
 * duplicate history entry or a stale `?new=1` back target behind.
 */
export function queueAfterSentinelPop(action: BackAction): void {
  unwindSentinel(action);
}

/* ----------------------------- dispatching ------------------------------- */

/**
 * Invoke the topmost logical back handler.
 *
 * Returns `true` when the press was consumed (also when a handler threw, a
 * broken handler must never drop the user out of the app) and `false` when
 * nothing is registered or the topmost handler explicitly declined it.
 */
export function runBack(): boolean {
  const top = handlers[handlers.length - 1];
  if (!top) return false;
  try {
    return top.handler() !== false;
  } catch (error) {
    console.warn('[back] handler failed', error);
    return true;
  }
}

/** Browser back / Android hardware back translation. */
function onPopState(): void {
  if (sentinelPopInFlight) {
    // Our own unwind: finish deferred navigations and re-protect any layers
    // that are still open (a StrictMode remount may have re-registered one).
    sentinelPopInFlight = false;
    armedSentinelId = null;
    flushAfterSentinelPop();
    armSentinel();
    return;
  }
  if (armedSentinelId !== null) {
    // The user's back press consumed our sentinel: it is a logical back.
    armedSentinelId = null;
    if (runBack()) {
      // Nested layers remain, so lay down a fresh sentinel for the next press.
      armSentinel();
    }
    return;
  }
  // Ordinary route traversal (hash history): let the router handle it, but
  // make sure a still-registered handler has its sentinel back.
  armSentinel();
}

/* ------------------------------ keyboard -------------------------------- */

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * Desktop keyboard back: Alt+Left everywhere, plus Cmd+[ on Apple keyboards
 * (the Safari/Chrome convention). Text fields keep their own navigation keys.
 *
 * When the dispatcher consumes the press we call `preventDefault()`; when
 * nothing is registered we perform the history step ourselves (the desktop
 * shell has no browser chrome to do it, and the web shortcut would otherwise
 * be the only way forward). Both paths prevent the default so a real browser
 * never performs a second back on top of ours.
 */
function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return;
  const altLeft = event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowLeft';
  const commandBracket =
    isApplePlatform() && event.metaKey && !event.ctrlKey && !event.altKey && event.key === '[';
  if (!altLeft && !commandBracket) return;
  if (isTextEntryTarget(event.target)) return;
  if (runBack()) {
    event.preventDefault();
    return;
  }
  if (window.history.length > 1) {
    event.preventDefault();
    window.history.back();
  }
}

/* ----------------------------- installation ------------------------------ */

function installListeners(): void {
  if (typeof window === 'undefined' || listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener('popstate', onPopState);
  window.addEventListener('keydown', onKeyDown);
}

/** Forward Android hardware back presses into the logical dispatcher. */
function installNativeBackListener(): void {
  if (backPlatform() !== 'android') return;
  try {
    const handle = TyagBack.addListener('backButton', (payload) => {
      if (runBack()) return;
      if (payload && payload.canGoBack) {
        window.history.back();
        return;
      }
      requestExit();
    });
    void Promise.resolve(handle).catch(() => undefined);
  } catch {
    /* Older native build without the plugin: keyboard/sentinel paths remain. */
  }
}

/**
 * Install the global triggers once per app lifetime. Called from `main.tsx`
 * before the React tree mounts; idempotent so tests/HMR may call it again.
 */
export function initBackNavigation(): void {
  if (typeof window === 'undefined') return;
  installListeners();
  if (navigationInitialised) return;
  navigationInitialised = true;
  installNativeBackListener();
}

/* --------------------------------- hooks --------------------------------- */

/**
 * Register a logical back handler.
 *
 * The effect only depends on `enabled`, so a handler that changes every render
 * (the common case: it closes over current state) never re-registers. The
 * latest handler is kept in a ref and read at invocation time, which keeps the
 * LIFO stack stable across renders.
 *
 * On web/PWA and iOS this also arms the shared history sentinel, so a browser
 * or gesture back reaches the dispatcher instead of leaving the app.
 */
export function useBackHandler(handler: BackHandler, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    const registration: RegisteredHandler = {
      id: handlerSequence + 1,
      handler: () => handlerRef.current(),
    };
    handlerSequence = registration.id;
    handlers.push(registration);
    armSentinel();
    return () => {
      const index = handlers.indexOf(registration);
      if (index !== -1) handlers.splice(index, 1);
      releaseSentinel();
    };
  }, [enabled]);
}

/**
 * Overlay primitive: while `open`, back closes the layer by calling `onClose`.
 * The handler is consuming (void return), so nothing else sees the press.
 * Covered here (instead of a separate sentinel bookkeeping) because every
 * logical layer maintains the same single sentinel entry.
 */
export function useBackLayer(open: boolean, onClose: () => void): void {
  useBackHandler(onClose, open);
}
