import Link from 'next/link';
import type { ReactNode } from 'react';
import { Led, type Tone } from '@/components/instrument';
import { getT } from '@/i18n/server';
import { dashboard } from '@/i18n/messages/dashboard';
import { cn } from '@/lib/utils';

/**
 * Ce qui demande une intervention, en tête de tableau de bord.
 *
 * Le bandeau ne ressemble volontairement à aucune des cartes de l'écran : pas
 * de fond de carte, un filet vertical coloré par la gravité, et des lignes
 * denses. Un opérateur doit pouvoir distinguer « il y a quelque chose à faire »
 * de « voici l'inventaire » avant même d'avoir lu un mot.
 *
 * Il n'y a ici que des anomalies. Un tableau de bord qui ouvre sur « PostgreSQL
 * actif » annonce ce que le lecteur sait déjà, puisque la page s'affiche — et
 * il repousse plus bas la seule information qui justifiait de l'ouvrir.
 */

export type AttentionSeverity = 'danger' | 'warn';

export type AttentionItem = {
  /** Le sujet : l'objet en cause, pas la catégorie du problème. */
  subject: string;
  /** Ce qui se passe, en une phrase qui se lit seule. */
  detail: string;
  severity: AttentionSeverity;
  href: string;
  /** Ce qu'on ira faire en cliquant — un verbe, pas « voir ». */
  action: string;
};

const RAIL: Record<AttentionSeverity, string> = {
  danger: 'bg-danger',
  warn: 'bg-warn',
};

const TONE: Record<AttentionSeverity, Tone> = {
  danger: 'danger',
  warn: 'warn',
};

export async function AttentionPanel({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return <AllClear />;

  const t = await getT(dashboard);

  // Le plus grave d'abord : on ne fait pas défiler pour trouver ce qui brûle.
  const sorted = [...items].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1,
  );
  const worst = sorted[0]?.severity ?? 'warn';

  return (
    <section
      aria-labelledby="attention-title"
      className="border-line bg-card shadow-panel relative overflow-hidden rounded-lg border"
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', RAIL[worst])} />

      <div className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b py-3.5 pr-5 pl-6">
        <h2 id="attention-title" className="text-ink font-condensed text-[0.9375rem] font-semibold">
          {t('attention.title', { count: sorted.length })}
        </h2>
        <span className="text-ink-faint text-xs">{t('attention.aside')}</span>
      </div>

      <ul className="divide-line divide-y">
        {sorted.map((item) => (
          <li key={`${item.href}-${item.subject}-${item.detail}`}>
            <Link
              href={item.href}
              className="hover:bg-surface-2/60 focus-visible:ring-signal group flex items-start gap-3 py-3 pr-5 pl-6 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:-outline-offset-2"
            >
              <Led tone={TONE[item.severity]} className="mt-1" />
              <span className="min-w-0 flex-1">
                <span className="text-ink block truncate font-mono text-[0.8125rem]">
                  {item.subject}
                </span>
                <span className="text-ink-muted block text-[0.8125rem] leading-snug">
                  {item.detail}
                </span>
              </span>
              <span className="text-ink-faint group-hover:text-signal shrink-0 self-center text-xs whitespace-nowrap transition-colors">
                {item.action}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * L'état normal, et il mérite une phrase franche.
 *
 * « 0 alerte » se lit comme un compteur en panne. Dire que rien ne demande
 * d'intervention est une réponse, pas une absence de réponse.
 */
async function AllClear() {
  const t = await getT(dashboard);
  return (
    <section className="border-line bg-card shadow-panel flex items-center gap-3 rounded-lg border px-5 py-4">
      <Led tone="ok" />
      <p className="text-ink text-sm">
        {t('attention.clear')}{' '}
        <span className="text-ink-faint">{t('attention.clear.detail')}</span>
      </p>
    </section>
  );
}

/** Bloc de contenu du tableau de bord — en-tête sobre, corps sans rembourrage. */
export function Panel({
  title,
  hint,
  href,
  linkLabel,
  children,
}: {
  title: string;
  hint?: string;
  href?: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-line bg-card shadow-panel flex min-w-0 flex-col rounded-lg border">
      <div className="border-line flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-3.5">
        <h2 className="text-ink font-condensed text-[0.9375rem] font-semibold">{title}</h2>
        {href && linkLabel ? (
          <Link
            href={href}
            className="text-ink-faint hover:text-signal text-xs underline-offset-4 transition-colors hover:underline"
          >
            {linkLabel}
          </Link>
        ) : hint ? (
          <span className="text-ink-faint text-xs">{hint}</span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

/** Ligne vide d'un bloc — une invitation, jamais un tiret. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="text-ink-faint px-5 py-6 text-sm">{children}</p>;
}
