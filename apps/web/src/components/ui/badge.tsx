import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleCheck, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Pastille d'état — 20 px, fond doux et liseré de la même teinte. Elle porte
 * toujours un texte : la couleur double le mot, elle ne le remplace jamais.
 *
 * Les noms shadcn (`default`, `secondary`, `destructive`) restent acceptés et
 * pointent sur les tons du système : accent, neutre, danger.
 */
const badgeVariants = cva('badge', {
  variants: {
    variant: {
      idle: '',
      secondary: '',
      ok: 'b-ok',
      warn: 'b-warn',
      danger: 'b-danger',
      destructive: 'b-danger',
      accent: 'b-accent',
      default: 'b-accent',
      outline: 'b-outline',
      solid: 'b-solid',
      count: 'b-count',
    },
  },
  defaultVariants: {
    variant: 'idle',
  },
});

export type BadgeProps = React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    /** Point de 6 px à la couleur du texte, devant le libellé. */
    dot?: boolean;
  };

function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span className="dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

/** Pastille d'identifiant technique : port, image, slug, hachage. En Geist Mono. */
function CodeBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="code-badge" className={cn('code', className)} {...props} />;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'negligible' | 'unknown';

const SEVERITY_CLASS: Record<Severity, string> = {
  critical: 'sev-c',
  high: 'sev-h',
  medium: 'sev-m',
  low: 'sev-l',
  negligible: 'sev-l',
  unknown: 'sev-u',
};

/**
 * Gravité d'une vulnérabilité : une échelle ordinale en aplat, du lie-de-vin
 * au gris ardoise. Le libellé (CRITICAL, HIGH…) reste celui du scanner.
 */
function SeverityBadge({
  severity,
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & { severity: Severity }) {
  return (
    <span
      data-slot="severity"
      className={cn('sev', SEVERITY_CLASS[severity], className)}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * Pilule de runtime : présent (coche verte et version en mono) ou absent
 * (trait en pointillés). Le nom du runtime est un nom propre, jamais traduit.
 */
function RuntimePill({
  name,
  version,
  available,
  className,
}: {
  name: string;
  version?: string | null;
  available: boolean;
  className?: string;
}) {
  return (
    <span className={cn('rt', available ? 'on' : 'off', className)}>
      {available ? <CircleCheck aria-hidden /> : <Minus aria-hidden />}
      {name}
      {available && version ? <span className="mono text-text-3">{version}</span> : null}
    </span>
  );
}

export { Badge, CodeBadge, SeverityBadge, RuntimePill, badgeVariants };
