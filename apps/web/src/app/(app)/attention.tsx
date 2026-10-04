import Link from 'next/link';
import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Led, type Tone } from '@/components/instrument';
import { getT } from '@/i18n/server';
import { dashboard } from '@/i18n/messages/dashboard';
import type { AttentionItem, AttentionSeverity } from '@/lib/overview';
import { cn } from '@/lib/utils';

export type { AttentionItem, AttentionSeverity };

const TONE: Record<AttentionSeverity, Tone> = {
  danger: 'danger',
  warn: 'warn',
};

/**
 * The "Attention" block: what requires an intervention, and nothing else.
 *
 * It opens the screen because it is the only information one opens a dashboard
 * for. A left border in the color of the worst point; one row per point —
 * indicator, subject in mono, detail, then the verb that leads to it. Dangers
 * come before warnings.
 */
export async function AttentionPanel({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return <AllClear />;
  const t = await getT(dashboard);

  const sorted = [...items].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1,
  );
  const worst = sorted[0]?.severity ?? 'warn';

  return (
    <section
      aria-labelledby="attention-title"
      className="card overflow-hidden"
      style={{ boxShadow: `inset 3px 0 0 var(--${worst}), var(--sh-xs)` }}
    >
      <div className="card-h flex-wrap">
        <span
          aria-hidden
          className={cn('dlg-icon !size-7 !rounded-lg', worst === 'warn' && 'is-warn')}
        >
          <TriangleAlert className="!size-3.5" />
        </span>
        <h2 id="attention-title">{t('attention.title', { count: sorted.length })}</h2>
        <span className="t-cap ml-auto text-text-3">{t('attention.aside')}</span>
      </div>
      <ul className="list is-link">
        {sorted.map((item) => (
          <li
            key={`${item.href}-${item.subject}-${item.detail}`}
            className="relative flex-wrap gap-y-1 sm:flex-nowrap"
          >
            <span className="flex w-3.5 justify-center">
              <Led tone={TONE[item.severity]} pulse={item.severity === 'danger'} />
            </span>
            <span className="mono w-[170px] shrink-0 truncate text-[12.5px] font-semibold">
              {item.subject}
            </span>
            <span className="t-sm min-w-0 flex-1 text-text-2 max-sm:basis-full max-sm:pl-[26px]">
              {item.detail}
            </span>
            {/* The verb carries the link; the whole row leads to it on click. */}
            <Link
              href={item.href as never}
              className="btn btn-ghost btn-sm shrink-0 after:absolute after:inset-0 max-sm:ml-[26px]"
            >
              {item.action}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function AllClear() {
  const t = await getT(dashboard);
  return (
    <section className="card flex items-center gap-3 px-4 py-3.5">
      <Led tone="ok" />
      <p className="t-sm">
        <span className="font-semibold">{t('attention.clear')}</span>{' '}
        <span className="text-text-3">{t('attention.clear.detail')}</span>
      </p>
    </section>
  );
}

/**
 * An overview card: title, gray subtitle, and a link on the right
 * ("Monitoring", "History"). Lists and tables sit inside without a body, so that
 * their rows touch the edges.
 */
export function Panel({
  title,
  aside,
  hint,
  href,
  linkLabel,
  footer,
  className,
  children,
}: {
  title: string;
  aside?: ReactNode;
  hint?: string;
  href?: string;
  linkLabel?: string;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('card flex min-w-0 flex-col overflow-hidden', className)}>
      <div className="card-h flex-wrap">
        <h2>{title}</h2>
        {aside ? <span className="t-cap text-text-3">{aside}</span> : null}
        {href && linkLabel ? (
          <Link href={href as never} className="link t-cap ml-auto">
            {linkLabel}
          </Link>
        ) : hint ? (
          <span className="t-cap ml-auto text-text-3">{hint}</span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {footer ? <div className="pager">{footer}</div> : null}
    </section>
  );
}

/** A block's empty row — an invitation, never a dash. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="t-sm px-4 py-6 text-text-3">{children}</p>;
}
