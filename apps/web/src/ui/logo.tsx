/**
 * Tyag brand components from the official November 2026 brand kit
 * (`assets/brand/`): the black/white peak symbol tiles and glyph, with the
 * wordmark set in Inter, per the product decision to use Inter for type
 * instead of the kit's proposed Poppins wordmark.
 */

const GLYPH_PATH =
  'M212.03 636.091L582.394 265.728C653.99 194.131 770.071 194.131 841.667 265.728L1212.03 636.091C889.779 514.533 534.281 514.533 212.03 636.091Z';
const TILE_GLYPH_PATH =
  'M225.28 630.01L437.661 417.629C478.717 376.573 545.283 376.573 586.339 417.629L798.72 630.01C613.928 560.304 410.072 560.304 225.28 630.01Z';

const WORDMARK_STYLE = {
  fontFamily: "'Inter', system-ui, sans-serif",
  fontWeight: 700,
  letterSpacing: '-0.01em',
  lineHeight: 1,
  whiteSpace: 'nowrap' as const,
  color: 'inherit',
};

export function TyagMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1424.061 848.122"
      width={size}
      height={(size * 848.122) / 1424.061}
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={GLYPH_PATH} />
    </svg>
  );
}

/** The wordmark as live text in the bundled Inter font. */
export function TyagWordmark({ height = 24, className }: { height?: number; className?: string }) {
  return (
    <span className={className} style={{ ...WORDMARK_STYLE, fontSize: `${height}px` }} role="img" aria-label="Tyag">
      Tyag
    </span>
  );
}

/** Rounded-square app icon: black tile on light surfaces, white tile on dark. */
export function TyagAppIcon({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Tyag"
    >
      <rect x="0" y="0" width="1024" height="1024" rx="225.28" fill="var(--logo-tile-bg, #000000)" />
      <path d={TILE_GLYPH_PATH} fill="var(--logo-tile-fg, #FFFFFF)" />
    </svg>
  );
}

/** Horizontal lockup: symbol tile + Inter wordmark. */
export function TyagLockup({ height = 24, className }: { height?: number; className?: string }) {
  const tile = height * (200 / 288);
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: `${height * (87 / 288)}px`, color: 'inherit' }}
    >
      <TyagAppIcon size={tile} />
      <TyagWordmark height={height * 0.8} />
    </span>
  );
}
