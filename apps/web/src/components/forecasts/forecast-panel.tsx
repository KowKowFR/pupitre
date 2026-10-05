import Link from 'next/link';
import { Telescope } from 'lucide-react';
import { Led } from '@/components/instrument';
import { Badge } from '@/components/ui/badge';
import { getT } from '@/i18n/server';
import { dashboard } from '@/i18n/messages/dashboard';
import type { ForecastView } from '@/lib/forecasts';
import { cn } from '@/lib/utils';

/**
 * "Coming up": what will break if nothing changes. The counterpart of the
 * attention block, which says what is broken now.
 *
 * One row per forecast: the indicator (orange when it is soon), the subject, the
 * sentence that says why — a slope, a median, a count —, and the link to the
 * subject's record. Nothing when there is nothing: a screen without a cloud does
 * not need a card to say so.
 *
 * `compact`: in a subject's record, the subject goes without saying.
 */
export async function ForecastPanel({
  items,
  compact = false,
}: {
  items: ForecastView[];
  compact?: boolean;
}) {
  if (items.length === 0) return null;
  const t = await getT(dashboard);
  const soon = items.some((item) => item.severity === 'soon');

  return (
    <section
      aria-labelledby={compact ? undefined : 'forecast-title'}
      aria-label={compact ? t('forecast.title', { count: items.length }) : undefined}
      className="card overflow-hidden"
      style={{ boxShadow: `inset 3px 0 0 var(--${soon ? 'warn' : 'accent'}), var(--sh-xs)` }}
    >
      <div className="card-h flex-wrap">
        <span
          aria-hidden
          className={cn('dlg-icon !size-7 !rounded-lg', soon ? 'is-warn' : 'is-accent')}
        >
          <Telescope className="!size-3.5" />
        </span>
        <h2 id={compact ? undefined : 'forecast-title'}>
          {t('forecast.title', { count: items.length })}
        </h2>
        <span className="t-cap ml-auto text-text-3">{t('forecast.aside')}</span>
      </div>
      <ul className={cn('list', !compact && 'is-link')}>
        {items.map((item) => (
          <li key={item.id} className="relative flex-wrap gap-y-1 sm:flex-nowrap">
            <span className="flex w-3.5 justify-center">
              <Led tone={item.severity === 'soon' ? 'warn' : 'accent'} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="t-sm font-semibold text-text">{item.title}</span>
                {compact ? null : (
                  <span className="mono t-cap text-text-2">{item.subjectName}</span>
                )}
                <Badge variant={item.severity === 'soon' ? 'warn' : 'outline'}>
                  {item.severityLabel}
                </Badge>
              </span>
              <span className="t-sm text-text-2">{item.sentence}</span>
            </span>
            {compact ? null : (
              <Link
                href={item.href as never}
                className="btn btn-ghost btn-sm shrink-0 after:absolute after:inset-0 max-sm:ml-[26px]"
              >
                {t('forecast.open')}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
