import { cn } from '@/lib/utils';

/**
 * La tuile Pupitre : un P dont la panse est le plateau incliné d'un lutrin,
 * avec deux lignes de partition.
 *
 * Les couleurs sont celles de la marque, pas des jetons : la tuile reste
 * outremer et le glyphe blanc dans les deux thèmes, comme sur les planches.
 * C'est un logo, pas un élément d'interface qui suivrait l'accent.
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
 * Le mot-symbole « pupitre » : minuscules, condensé à 90 %, interlettrage
 * serré. C'est un nom de produit, pas une phrase — il ne se traduit pas.
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
