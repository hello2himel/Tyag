deUrge BRAND KIT  v1.0  (November 2026)
=======================================

START HERE
  deUrge-brand-guidelines.pdf   10-page guide: construction, clear space, versions, colour, type, don'ts
  what-changed.png              before / after of your original upload

WHICH FILE DO I USE?
  Website / app UI ........ logo/svg/  (SVG scales perfectly, text is already outlined)
  Print / signage ......... logo/pdf/  (vector)
  Docs, slides, email ..... logo/png/  (transparent; pick the @width you need)
  On a white background ... symbol-tile-black, lockup-*-on-light, wordmark-black
  On a black background ... symbol-tile-white, lockup-*-on-dark,  wordmark-white
  One colour only ......... glyph-black / glyph-white

  App stores .............. app-icons/ios, app-icons/android
  Website icons ........... app-icons/web  (paste head-snippet.html into your <head>)
  Social .................. social/  (avatar, link preview, profile header)
  Colours ................. colors/palette.json, colors/colors.css

THE RULES IN ONE BREATH
  - Tile corner radius = 22% of tile.  Peak width = 56% of tile (so margin = corner radius).
  - Keep one corner radius of clear space around the logo.
  - Min size: tile 16 px / 6 mm, horizontal lockup 96 px / 28 mm.
  - Never stretch, rotate, recolour, add effects, or retype the wordmark.

TYPE
  Poppins (Google Fonts, free, SIL OFL). Bold = wordmark/headlines, Medium = subheads, Regular = body.

NOTES
  - Wordmark is Poppins Bold, outlined, -1% tracking, with the font's kerning. It is a
    proposal - swap it in source/build_assets.py if you prefer another face.
  - "Impulse" orange (#FF4B2B) is a suggested optional accent, not part of your original idea.
  - CMYK values are straight conversions; proof with your printer.
  - Exports are RGB. Ask your printer whether they want CMYK/PMS conversions.
  - I have not run a trademark search for the name or mark.

REBUILD / EDIT
  source/original/  your original upload
  source/           python3 make_kit.py   (needs reportlab, fontTools, poppler's pdftocairo,
                    and Poppins TTFs; set POPPINS_DIR=/path/to/fonts if needed)
  Geometry lives at the top of source/kitlib.py (HW, R_APEX, R_BASE, TILE_RADIUS, GLYPH_FRAC).
