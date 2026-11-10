# Tyag · Motion implementation

The motion contract is defined in the supplied specification. The web/Android/
desktop UI implements it through one token set so no component invents its own
timing.

## Tokens (single source of truth)

- TypeScript: `apps/web/src/ui/motion.ts`
  - `springs.smooth` 500 ms / bounce 0
  - `springs.snappy` 500 ms / bounce 0.15
  - `springs.quick` 300 ms / bounce 0
  - `curves.easeInOut | easeOut | easeIn | sheet`
  - `durations.instant | fast | standard | slow | sheet | unlock`
  - `project()` and `rubberBand()` from Apple's fluid-interface formulas
  - interruptible `spring()` integrator with `retarget()`
  - `haptic()` (selection / impact / error; no-op where unavailable)
- CSS: `:root` custom properties `--motion-duration-*` and
  `--motion-curve-*` in `apps/web/src/ui/styles.css`. Components reference them
  by name.

`scripts/motion-check.mjs` enforces the token contract and the spring settle
(< 600 ms) / projection / rubber-band formulas; it runs as part of `pnpm test`.

## Applied behaviours

- **Press feedback:** plain/primary buttons, list rows (instant fill, 250 ms
  fade out), tappable cards (0.97 scale), chips, PIN keypad keys (instant fill,
  300 ms release), desktop hover/focus (120–150 ms).
- **Sheets:** bottom sheets rise with the `sheet` curve, dim backdrop, drag from
  the grip/header tracks the finger with rubber-banding and velocity projection,
  and settle back interruptibly with the spring curve. Desktop sheets slide from
  the top (300 ms in, 200 ms out). Escape/backdrop dismissal uses the same exit.
- **Modal alerts:** 250 ms fade + scale 1.1 → 1.
- **PIN:** 4-dot filling (100 ms), red dots + 500 ms shake + delayed error
  message + error haptic on a wrong PIN, keypad 40 % lockout fade, 150 ms hold
  before the unlock layer fades out (250 ms) and content scales 0.98 → 1.
  Digits produce no haptic.
- **Privacy shield:** backgrounding immediately shows the branded shield and
  arms the lock; on return the lock screen is already visible. Biometric prompt
  starts 250 ms after activation.
- **Navigation:** tab changes are instant; tracker push slides in from the
  trailing edge with the sheet curve; pop enters from the leading edge.
- **Numerals:** `RollingText` uses tabular digits and rolls only changed digits
  (350 ms, up/down by value direction; Reduce Motion is a 150 ms cross-fade).
- **Charts/history:** bars grow from the baseline and history segments grow from
  the left with a 30 ms stagger, once per appearance.
- **Onboarding:** welcome mark/wordmark/tagline/actions stagger 80 ms apart with
  an 8 px rise; page dots cross-fade in 150 ms.
- **Reduce Motion:** CSS cross-fades (200 ms), no shakes/staggers/slides; the
  spring integrator snaps to its target when `prefers-reduced-motion` is set.

## Deliberate limits

The current interaction model uses hash-based screens and inset sheets rather
than UIKit's interactive navigation controller. The push/pop motion, sheet drag
and PIN gestures above are implemented; the iOS interactive edge-swipe back
gesture and per-row swipe-action physics are not part of this UI yet. All motion
still animates only position, opacity, scale and colour.
