import { cn } from '@/lib/utils';

/**
 * The Pupitre tile: a P whose bowl is a lectern's tilted board, with two staff
 * lines.
 *
 * The colors are the brand's, not the tokens': the tile stays ultramarine and the
 * glyph white in both themes, as on the boards. It is a logo, not an interface
 * element that would follow the accent.
 */
const GLYPH =
  'M5 7.1 L17.3 4.7 Q20 4.2 20 6.9 L20 12.1 Q20 14.7 17.5 14.7 L9.5 14.7 L9.5 19.3 ' +
  'Q9.5 20.5 8.3 20.5 L6.2 20.5 Q5 20.5 5 19.3 Z';

const BRAND = '#2E44D6';

export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <rect width="24" height="24" rx="6.2" fill={BRAND} />
      <g transform="translate(12 12) scale(.78) translate(-12.5 -12.6)">
        <path d={GLYPH} fill="#FFFFFF" />
        <path
          d="M11.4 8.7 L17.4 7.55"
          stroke={BRAND}
          strokeWidth="1.55"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M11.4 11.5 L15.4 11.5"
          stroke={BRAND}
          strokeWidth="1.55"
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  );
}

/**
 * The "pupitre" wordmark: lowercase, condensed to 90%, tight letter spacing. It
 * is a product name, not a sentence — it is not translated.
 */
export function Wordmark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('leading-none text-text', className)}
      style={{ fontSize: size, fontWeight: 620, letterSpacing: '-0.035em', fontStretch: '90%' }}
    >
      {/* i18n-ignore — nom propre du produit */}
      pupitre
    </span>
  );
}
