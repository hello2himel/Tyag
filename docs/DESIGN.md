# deUrge — UI/UX implementation notes

The interface is implemented from the supplied **deUrge UI/UX skeleton**
(light and dark, 390×844 mobile boards and a 1440×900 desktop board). The
rendered reference boards live in `docs/design/`:

| Board | File |
| --- | --- |
| Light · Mobile · Trackers | `docs/design/00-light-mobile-trackers.png` |
| Light · Mobile · Tracker detail | `docs/design/01-light-mobile-tracker-detail.png` |
| Light · Mobile · Record sheet | `docs/design/02-light-mobile-record-sheet.png` |
| Light · Mobile · Insights | `docs/design/03-light-mobile-insights.png` |
| Light · Desktop | `docs/design/04-light-desktop.png` |
| Dark · Mobile · Trackers | `docs/design/05-dark-mobile-trackers.png` |
| Dark · Mobile · Tracker detail | `docs/design/06-dark-mobile-tracker-detail.png` |
| Dark · Mobile · Record sheet | `docs/design/07-dark-mobile-record-sheet.png` |
| Dark · Mobile · Insights | `docs/design/08-dark-mobile-insights.png` |
| Dark · Desktop | `docs/design/09-dark-desktop.png` |

## Design tokens (extracted from the skeleton)

```
Light: --bg #F2F2F7  --card #FFFFFF  --fill rgba(120,120,128,.12)  --ink #000
       --mut #6C6C70 --sep rgba(60,60,67,.29) --b #0059B3 --bf #0071E3
       --g #248A3D  --a #C93400  --u #5856D6
       --glass rgba(249,249,249,.86) --side rgba(236,236,240,.92)

Dark:  --bg #000  --card #1C1C1E  --fill rgba(120,120,128,.32)  --ink #fff
       --mut #98989F --sep rgba(84,84,88,.65) --b #5AB0FF --bf #0071E3
       --g #30D158 --a #FF9F0A --u #7D7AFF
```

- Type: system font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text",
  "Segoe UI", Inter, system-ui, "Noto Sans", sans-serif`), tabular numerals.
  No webfont is downloaded; the app is fully offline.
- Radii: cards 20px, grouped lists 12px, sheets 28–32px, buttons 14px.
- Spacing: 20px screen gutters, 16px card padding, 12px stack gaps.
- Layout: mobile tab bar with Trackers / Journal / Insights / Settings;
  desktop sidebar (trackers + library + “Local only · no account”) and a wide
  content area. Tracker detail adds an Activity column on wide screens.
- Motion: short sheet/fade transitions only; `prefers-reduced-motion` respected.
- Colour semantics: green = abstinence/active, amber = lapses, purple = urges,
  grey = paused/archived/neutral notes.

All screens are responsive: a single component tree renders both mobile and
desktop layouts via CSS breakpoints (980px desktop shell, 700px for wider
sheets/grids).

## Typography and platform fidelity

The kit's font stack is SF Pro on Apple platforms with Inter as the fallback.
deUrge bundles the Inter WOFF2 files locally (SIL OFL, no remote fonts) and uses
the same stack, so non-Apple platforms match the iOS boards. Tracker-name search
suggestions follow the iOS inset grouped search-results pattern on mobile, while
the desktop card keeps the same inline list. The optional tracker Category row
from the kit was removed by request. iOS PWA metadata,
`viewport-fit=cover`, safe-area insets and the `-webkit-tap-highlight-color`
reset are applied for an app-like iOS feel.

## Brand

The supplied skeleton used a placeholder clock mark. The final product uses the
official **deUrge brand kit (November 2026)** committed in `assets/brand/`:
black/white peak symbol tiles, glyph, lockup and prebuilt app icons for web,
Android and iOS. `apps/web/src/ui/logo.tsx` wraps the kit for the UI (tile,
glyph, and a live Inter-set wordmark), while `scripts/gen-icons.mjs` derives
every platform icon (PWA, Android adaptive + monochrome, iOS, Tauri) and the
social/meta card from the same committed exports. The wordmark uses the bundled
Inter font rather than the kit's outlined Poppins suggestion, per product
direction.
