'use client';

import type { OverallState, PublicState, Translate } from '@pupitre/core';
import { Led, type Tone } from '@/components/instrument';
import { useT } from '@/i18n/client';
import { statusPages as messages } from '@/i18n/messages/status-pages';
import { formatDateTimeWith, formatNumber, type FormatSettings } from '@/lib/format';
import type { StatusBlockModel, StatusPageModel } from '@/lib/status-page';
import { cn } from '@/lib/utils';

const STATE_TONE: Record<PublicState, Tone> = {
  operational: 'ok',
  degraded: 'warn',
  down: 'danger',
  maintenance: 'accent',
  unknown: 'idle',
};

const OVERALL_TONE: Record<OverallState, Tone> = {
  operational: 'ok',
  degraded: 'warn',
  partial_outage: 'warn',
  major_outage: 'danger',
  maintenance: 'accent',
  unknown: 'idle',
};

const BAR_COLOR = {
  operational: 'var(--ok)',
  degraded: 'var(--warn)',
  down: 'var(--danger)',
  empty: 'var(--border)',
} as const;

/**
 * Une page de statut, à partir de son modèle — sur la page publique comme dans
 * l'aperçu de l'éditeur. Ce composant ne connaît que des libellés, des états
 * et des dates : c'est `buildStatusPageModel()` qui a décidé de ce qui sort.
 */
export function StatusPageView({
  model,
  format,
  compact = false,
}: {
  model: StatusPageModel;
  format: FormatSettings;
  /** Dans l'aperçu de l'éditeur : moins de marges. */
  compact?: boolean;
}) {
  const t = useT(messages);
  const when = (value: string) =>
    formatDateTimeWith(value, format, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: format.timezone,
    });

  return (
    <div className={cn('mx-auto flex w-full max-w-3xl flex-col', compact ? 'gap-4' : 'gap-6')}>
      <header className="flex flex-col gap-1.5">
        <h1
          className={cn('font-semibold tracking-tight text-text', compact ? 'text-xl' : 'text-3xl')}
        >
          {model.title}
        </h1>
        {model.description ? <p className="t-sm text-text-2">{model.description}</p> : null}
      </header>

      {model.blocks.length === 0 ? <p className="t-sm text-text-3">{t('public.empty')}</p> : null}

      {model.blocks.map((block) => (
        <Block key={block.id} block={block} model={model} format={format} when={when} />
      ))}

      <footer className="t-cap flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-text-3">
        <span>
          {t('public.updated', {
            time: formatDateTimeWith(model.generatedAt, format, {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: format.timezone,
            }),
          })}
        </span>
        {compact ? null : <span>{t('public.refresh')}</span>}
      </footer>
    </div>
  );
}

function Block({
  block,
  model,
  format,
  when,
}: {
  block: StatusBlockModel;
  model: StatusPageModel;
  format: FormatSettings;
  when: (value: string) => string;
}) {
  const t = useT(messages);
  switch (block.type) {
    case 'summary': {
      const tone = OVERALL_TONE[block.state];
      return (
        <section
          className="card flex items-center gap-3 px-5 py-4"
          style={{
            boxShadow: `inset 4px 0 0 var(--${tone === 'idle' ? 'border' : tone}), var(--sh-xs)`,
          }}
        >
          <Led tone={tone} pulse={block.state !== 'operational' && block.state !== 'unknown'} />
          <h2 className="text-lg font-semibold text-text">{t(`overall.${block.state}`)}</h2>
        </section>
      );
    }
    case 'heading':
      return <h2 className="mt-2 text-lg font-semibold text-text">{block.text}</h2>;
    case 'text':
      return <p className="t-sm whitespace-pre-line text-text-2">{block.text}</p>;
    case 'services':
      return (
        <section className="card overflow-hidden">
          {block.title ? (
            <div className="card-h">
              <h2>{block.title}</h2>
            </div>
          ) : null}
          <ul className="flex flex-col divide-y divide-border">
            {block.services.map((service, index) => (
              <li key={`${service.label}-${index}`} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium text-text">
                    {service.label}
                  </span>
                  {block.uptimeShown ? (
                    <span className="t-cap text-text-3">
                      {service.uptime === null
                        ? t('services.uptime.none')
                        : t('services.uptime', {
                            value: formatNumber(Math.floor(service.uptime * 100) / 100, format, {
                              maximumFractionDigits: 2,
                            }),
                            days: model.historyDays,
                          })}
                    </span>
                  ) : null}
                  <span className="flex shrink-0 items-center gap-1.5 t-sm text-text-2">
                    <Led tone={STATE_TONE[service.state]} />
                    {t(`state.${service.state}`)}
                  </span>
                </div>
                {service.bars ? (
                  <>
                    <div
                      className="flex h-7 items-stretch gap-[2px]"
                      role="img"
                      aria-label={service.label}
                    >
                      {service.bars.map((bar) => {
                        const day = formatDateTimeWith(`${bar.day}T12:00:00Z`, format, {
                          day: 'numeric',
                          month: 'short',
                          timeZone: 'UTC',
                        });
                        const label =
                          bar.ratio === null
                            ? t('bar.empty', { day })
                            : t('bar.day', {
                                day,
                                ratio: formatNumber(Math.floor(bar.ratio * 10_000) / 100, format, {
                                  maximumFractionDigits: 2,
                                }),
                              });
                        return (
                          <span
                            key={bar.day}
                            title={label}
                            className="min-w-0 flex-1 rounded-[3px]"
                            style={{ background: BAR_COLOR[bar.state] }}
                          />
                        );
                      })}
                    </div>
                    <div className="t-cap flex justify-between text-text-3">
                      <span>{t('bars.legend.past', { days: model.historyDays })}</span>
                      <span>{t('bars.legend.today')}</span>
                    </div>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      );
    case 'maintenance':
      return (
        <section className="card overflow-hidden">
          <div className="card-h">
            <h2>{t('maintenance.title')}</h2>
          </div>
          {block.windows.length === 0 ? (
            <p className="t-sm px-4 py-3 text-text-2">{t('maintenance.none')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {block.windows.map((window, index) => (
                <li
                  key={`${window.startsAt}-${index}`}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <span className="pt-1.5">
                    <Led tone="accent" pulse={window.active} />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="t-sm font-medium text-text">
                      {window.active
                        ? t('maintenance.active', { end: when(window.endsAt) })
                        : t('maintenance.upcoming', {
                            start: when(window.startsAt),
                            end: when(window.endsAt),
                          })}
                    </span>
                    <span className="t-cap text-text-2">
                      {t('maintenance.affects', { services: window.services.join(', ') })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    case 'incidents':
      return (
        <section className="card overflow-hidden">
          <div className="card-h">
            <h2>{t('incidents.title', { count: block.days })}</h2>
          </div>
          {block.incidents.length === 0 ? (
            <p className="t-sm px-4 py-3 text-text-2">
              {t('incidents.none', { count: block.days })}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {block.incidents.map((incident, index) => (
                <li
                  key={`${incident.startedAt}-${index}`}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <span className="pt-1.5">
                    <Led
                      tone={incident.resolvedAt ? 'idle' : 'danger'}
                      pulse={!incident.resolvedAt}
                    />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="t-sm font-medium text-text">{incident.service}</span>
                    <span className="t-cap text-text-2">
                      {incident.resolvedAt
                        ? t('incidents.resolved', {
                            start: when(incident.startedAt),
                            end: when(incident.resolvedAt),
                            duration: duration(incident.startedAt, incident.resolvedAt, t),
                          })
                        : t('incidents.ongoing', { start: when(incident.startedAt) })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
  }
}

function duration(start: string, end: string, t: Translate<typeof messages.fr>): string {
  const minutes = Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
  if (minutes < 1) return t('duration.lessThanMinute');
  if (minutes < 60) return t('duration.minutes', { minutes });
  return t('duration.hours', {
    hours: Math.floor(minutes / 60),
    minutes: String(minutes % 60).padStart(2, '0'),
  });
}
