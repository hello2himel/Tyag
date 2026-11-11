# Tyag — Back navigation across platforms

Tyag ships one React bundle to four shells, and each shell has a different
"back" affordance. All of them are funnelled through a single logical
dispatcher in `apps/web/src/platform/back.ts`, so a sheet, an onboarding step,
the app lock and the hash router agree on what Back means.

## 1. Behaviour contract

A back press is processed in this order:

1. **Topmost logical layer** — an open sheet, modal, confirm dialog, PIN sheet,
   onboarding step, the app lock, or the change-PIN overlay consumes the press
   (LIFO: the last registered layer closes first).
2. **Route history** — on Android/iOS/web the WebView's own history moves back
   one app screen (tracker detail → trackers, Data & Backups → settings,
   previously visited tab → that tab). Popups and deep links are *replaced* out
   of the URL rather than pushed, so Back never reopens something already
   dismissed.
3. **Exit or nothing** — on Android the native shell closes the app when there
   is nothing left to go back to. On web, iOS and the desktop shells a press at
   the root is consumed / leaves the page (no app exit: neither platform allows
   an app to close itself).

A handler returns `false` only when it deliberately declines the press; `void`
or `true` means consumed.

## 2. Per-platform behaviour

| Platform | Trigger | Route back | Exit |
| --- | --- | --- | --- |
| Web / installed PWA | Browser Back button / Android system back gesture / **Alt+Left**, **Cmd+[** | Hash history (`history.back()`), or a layer close | Browser leaves the page |
| Android (Capacitor) | Hardware Back key / predictive gesture, forwarded by the local `TyagBack` Capacitor plugin as a `backButton` event | WebView `canGoBack` → `history.back()` | `TyagBack.exitApp()` → `Activity.finish()` |
| iOS (Capacitor) | WKWebView edge-swipe back gesture (enabled in `SceneDelegate`) | Hash history via the same `popstate` path as the web | Not possible; the swipe simply does nothing at the root |
| Desktop (Tauri) | **Alt+Left**, **Cmd+[** (the system WebView has no back UI) | Hash history | Window stays in the user's control |
| Desktop (web build in a browser) | Browser Back, Alt+Left, Cmd+[ | Hash history | Browser leaves the page |

### Android specifics

Capacitor 8 core registers **no** `onBackPressed` handling, so without a plugin
the Activity finished from anywhere — mid-onboarding, mid-sheet, mid-record.
`apps/mobile/android/app/src/main/java/app/tyag/Tyag/BackHandlerPlugin.java`
fixes this with a locally registered plugin (no npm dependency, registered
before the bridge is created, like the existing `BiometricsPlugin`):

- plugin name **`TyagBack`**, event **`backButton`** with
  `{ canGoBack: boolean }` (retained until consumed);
- method **`exitApp()`** resolves and then finishes the Activity;
- if the web layer is not listening yet (cold start, JS bundle still booting)
  the plugin mirrors the WebView history and otherwise finishes the Activity, so
  Back is never swallowed.

The web side (`installNativeBackListener()` in `platform/back.ts`) handles the
event as: `runBack() || (canGoBack ? history.back() : exitApp())`.

### iOS specifics

There is no hardware back button. The only native affordance is the WKWebView
edge-swipe gesture, which is off by default; `SceneDelegate.swift` enables
`allowsBackForwardNavigationGestures`. The web bundle keeps one history sentinel
entry (see §3) so the first swipe closes an open overlay and only the next one
moves to the previous screen — matching Android.

## 3. History sentinels (web/PWA and iOS only)

A browser or system back press that nothing intercepts navigates the WebView's
session history away from the app. On web/PWA and iOS the dispatcher therefore
keeps **one** sentinel entry on top of the current history entry whenever at
least one logical layer is open:

- the sentinel is pushed with `history.pushState({ __tyagBack: id }, '')`, i.e.
  the *same URL*, so popping it never changes the route;
- a `popstate` that consumes the sentinel is translated into `runBack()`; while
  layers remain, a fresh sentinel is pushed for the next press;
- programmatic closes unwind the sentinel with a suppressed `history.back()`, so
  no duplicate or dangling entries are left behind;
- `router.navigate()` defers through `queueAfterSentinelPop()` if a sentinel is
  armed, so closing a sheet and navigating in the same event leaves a clean
  stack (and a consumed `?new=1` deep link is never a Back target).

Android deliberately uses native events instead of sentinels (the WebView
history must stay untouched for `canGoBack`), and Tauri has no system back UI at
all, so sentinels are skipped there too.

## 4. Logical layers covered

| Layer | Where | Back action |
| --- | --- | --- |
| Bottom sheets (`Sheet`) | tracker create/edit, record lapse/urge, journal entry, history detail, onboarding restore | close |
| Modals / confirm dialogs (`Modal`, `ConfirmDialog`) | tracker pause/archive/delete, category add/rename/delete, import replace, erase-data | close |
| Custom PIN overlays (`pn-sheet`) | lock-screen "Forgot PIN?", PIN options | close |
| Onboarding steps | welcome → privacy → tracker → reminders → PIN → ready | previous step (PIN confirm → create → reminders); ready consumes |
| App lock | lock screen after backgrounding / launch | Android: exit; web: consumed (never reveals the shell) |
| Change-PIN overlay | Settings → change PIN | close (cancel) |

The shared `useOverlayBehaviour()` (used by both `Sheet` and `Modal`) registers
the layer automatically, so every current and future dialog primitive inherits
Back handling.

## 5. Implementation map

| Concern | File |
| --- | --- |
| Dispatcher, handler stack, sentinels, keyboard, native bridge | `apps/web/src/platform/back.ts` |
| Global initialisation (`initBackNavigation`), default `#/trackers` | `apps/web/src/main.tsx` |
| `navigate(path, { replace })`, hash routing | `apps/web/src/router.tsx` |
| Lock guard + change-PIN layer | `apps/web/src/App.tsx` |
| Sheet/Modal integration | `apps/web/src/ui/components.tsx` |
| Onboarding steps | `apps/web/src/features/onboarding/OnboardingScreen.tsx` |
| Custom PIN overlays | `apps/web/src/features/lock/AppLock.tsx` |
| Deep-link consumption (`?new=1`) | `apps/web/src/features/trackers/TrackersScreen.tsx`, `apps/web/src/features/journal/JournalScreen.tsx` |
| Android `onBackPressed` plugin | `apps/mobile/android/app/src/main/java/app/tyag/Tyag/BackHandlerPlugin.java` |
| iOS edge-swipe gesture | `apps/mobile/ios/App/App/SceneDelegate.swift` |

Public API of `platform/back.ts`:

```ts
type BackHandler = () => boolean | void;

useBackHandler(handler, enabled = true); // register a logical layer/guard
useBackLayer(open, onClose);             // overlay sugar (Sheet/Modal/custom)
runBack(): boolean;                      // invoke the topmost handler
initBackNavigation(): void;              // once, from main.tsx
requestExit(): void;                     // Android-only app exit
```

## 6. URL and deep-link semantics

- `#/trackers?new=1` and `#/journal?new=1` are one-shot deep links: the query is
  consumed with `history.replaceState` when the sheet opens/closes, so pressing
  Back after dismissing the sheet cannot reopen it.
- `navigate(path, { replace: true })` is available anywhere a route must be
  rewritten without leaving a Back target.
- The initial `#/trackers` route is written before React mounts, so no screen
  observes an empty hash during boot or unlock.

## 7. Known limitations

- The ~200–400 ms sheet exit animation unregisters the layer immediately; a
  second press inside that window can fall through to the route back. This
  matches native sheet dismissal timing and is not user-reachable in practice.
- Rapid double browser Back within one frame can invoke the same closing
  callback twice before React commits; every current close callback is
  idempotent.
- Keyboard back is intentionally ignored while focus is in an
  input/textarea/select/contenteditable (Alt+Left is word navigation there).
- The iOS edge-swipe path cannot be exercised in a Linux-hosted test run; it is
  verified by API review against Capacitor iOS 8.6.0 and by the matching
  web/PWA `popstate` behaviour.

## 8. Verifying Back behaviour

- Web/PWA: complete onboarding + PIN, open a sheet, press the browser Back
  button and **Alt+Left** — the sheet closes and the URL/route does not change;
  a second press performs a normal route back. Close a sheet with Cancel and
  press Back — the previous route must be reached and the sheet must not
  reopen. `?new=1` deep links must not survive a close.
- Android: `adb install` the debug APK, then `adb shell input keyevent
  KEYCODE_BACK` in the middle of onboarding (returns a step, app stays alive),
  with a sheet open (closes it), on a tracker detail screen (returns to
  Trackers), and at the root (app closes cleanly).
- Desktop (Tauri): Alt+Left closes overlays / navigates the same way; no history
  sentinel entries are added on layer open.
