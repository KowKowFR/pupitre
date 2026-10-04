import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleCheck, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A state chip — 20 px, soft background and a border of the same tint. It always
 * carries a text: the color doubles the word, it never replaces it.
 *
 * The shadcn names (`default`, `secondary`, `destructive`) are still accepted and
 * point to the system's tones: accent, neutral, danger.
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
    /** A 6 px dot in the text's color, before the label. */
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

/** Technical identifier chip: port, image, slug, hash. In Geist Mono. */
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
 * A vulnerability's severity: an ordinal scale as a flat color, from burgundy to
 * slate gray. The label (CRITICAL, HIGH…) stays the scanner's.
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
 * A runtime pill: present (green check and version in mono) or absent (dotted
 * line). The runtime's name is a proper noun, never translated.
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
