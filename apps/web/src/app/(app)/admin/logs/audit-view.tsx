'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AUDIT_SEVERITIES, auditSeverityOf, type AuditSeverity } from '@pupitre/core';
import { ChevronLeft, ChevronRight, Copy, Filter, ScrollText, Search, X } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { Badge, CodeBadge, SeverityBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyValue } from '@/components/ui/data';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
  useDrawerSelection,
} from '@/components/ui/drawer';
import { FilterChipLink } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { formatDateTime, type FormatSettings } from '@/lib/format';
import { toast } from '@/lib/toast';
import { describeUserAgent } from '@/lib/user-agent';

/** Une entrée du journal, telle que la page la sérialise. */
export type AuditEntry = {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ip: string | null;
  /** Le navigateur de la requête, tel qu'il s'annonce ; `null` pour le worker. */
  userAgent: string | null;
  /** Le jeton d'API par lequel l'acteur a agi ; `null` depuis le panel. */
  apiTokenName: string | null;
  before: unknown;
  after: unknown;
};

type Filters = {
  q: string;
  severity: string;
  actorId: string;
  action: string;
  resourceType: string;
  from: string;
  to: string;
};

const FILTER_KEYS = ['q', 'severity', 'action', 'resourceType', 'actorId', 'from', 'to'] as const;

/** Les actions qui disent un refus : le tiroir le dit au mot, à côté de la criticité. */
const DENIAL_ACTIONS = new Set([
  'permission.denied',
  'auth.login.failed',
  'auth.signup.blocked',
  // Une écriture venue d'une autre origine, une route de Better Auth fermée.
  'request.cross_site.refused',
  'auth.admin_route.refused',
  'auth.two_factor_route.refused',
]);

/** Les criticités de la requête, dans l'ordre de l'échelle. */
function selectedSeverities(value: string): AuditSeverity[] {
  const wanted = new Set(value.split(','));
  return AUDIT_SEVERITIES.filter((severity) => wanted.has(severity));
}

/**
 * Le journal se lit, il ne se traduit pas.
 *
 * Une entrée ne porte que des données : un nom d'action (`deployment.created`),
 * un type de ressource, un identifiant, une IP, une charge utile JSON. Aucune
 * n'est de la prose, et traduire à l'écriture aurait figé la langue de la trace
 * pour toujours. Ce qui se traduit ici, c'est le décor : en-têtes, filtres,
 * pagination, « système / anonyme », la note de fuseau.
 */
export function AuditView({
  items,
  page,
  actors,
  filters,
  severityCounts,
  format,
}: {
  items: AuditEntry[];
  page: { page: number; totalPages: number; pageSize: number };
  /** Combien d'entrées par criticité, sous les autres filtres. */
  severityCounts: Record<AuditSeverity, number>;
  /** Les personnes présentes au journal, pour le filtre « Acteur ». */
  actors: Array<{ id: string; email: string }>;
  filters: Filters;
  format: FormatSettings;
}) {
  const t = useT(admin);
  const c = useT(common);
  const router = useRouter();
  const drawer = useDrawerSelection(
    'entry',
    items.map((item) => item.id),
  );
  const current = items.find((item) => item.id === drawer.selected) ?? null;

  const hrefWith = (next: Partial<Filters> & { page?: number }) => {
    const params = new URLSearchParams();
    const merged = { ...filters, ...next };
    for (const key of FILTER_KEYS) {
      if (merged[key]) params.set(key, merged[key]);
    }
    if (next.page && next.page > 1) params.set('page', String(next.page));
    if (page.pageSize !== 50) params.set('pageSize', String(page.pageSize));
    const query = params.toString();
    return query ? `/admin/logs?${query}` : '/admin/logs';
  };

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next: Partial<Filters> = {};
    for (const key of ['q', 'actorId', 'from', 'to'] as const) {
      next[key] = String(form.get(key) ?? '').trim();
    }
    router.push(hrefWith(next) as never);
  }

  return (
    <section className="card overflow-hidden">
      <form
        onSubmit={onSubmit}
        className="grid grid-cols-1 items-end gap-x-3 gap-y-3 px-4 pt-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.2fr_1fr_1fr_auto]"
      >
        <div className="field">
          <Label htmlFor="q">{t('logs.filter.search')}</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-text-3"
            />
            <Input
              id="q"
              name="q"
              type="search"
              className="input-sm pl-8"
              // La clé remonte le champ quand l'URL change (réinitialiser, retour arrière).
              key={filters.q}
              defaultValue={filters.q}
              placeholder={t('logs.filter.search.placeholder')}
            />
          </div>
        </div>
        <div className="field">
          <Label htmlFor="actorId">{t('logs.filter.actor')}</Label>
          <Select
            id="actorId"
            name="actorId"
            className="input-sm"
            // La clé remonte le champ quand l'URL change de filtre (lien
            // « Filtrer sur cet acteur », retour arrière).
            key={filters.actorId}
            defaultValue={filters.actorId}
          >
            <option value="">{t('logs.filter.actor.all')}</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.email}
              </option>
            ))}
            {filters.actorId && !actors.some((actor) => actor.id === filters.actorId) ? (
              // Un identifiant passé à la main qui n'a rien au journal : on le
              // montre tel quel plutôt que de faire croire à « Tous ».
              <option value={filters.actorId}>{filters.actorId}</option>
            ) : null}
          </Select>
        </div>
        <div className="field">
          <Label htmlFor="from">{t('logs.filter.from')}</Label>
          <Input
            id="from"
            name="from"
            type="date"
            className="input-sm mono"
            defaultValue={filters.from.slice(0, 10)}
          />
        </div>
        <div className="field">
          <Label htmlFor="to">{t('logs.filter.to')}</Label>
          <Input
            id="to"
            name="to"
            type="date"
            className="input-sm mono"
            defaultValue={filters.to.slice(0, 10)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="submit" size="sm" variant="secondary">
            {t('logs.filter.submit')}
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/admin/logs">{c('reset')}</Link>
          </Button>
        </div>
      </form>

      <SeverityFilter
        selected={selectedSeverities(filters.severity)}
        counts={severityCounts}
        hrefFor={(severity) => hrefWith({ severity, page: 1 })}
        extra={[
          ...(filters.action
            ? [
                {
                  key: 'action',
                  label: `${t('logs.filter.action')} : ${filters.action}`,
                  href: hrefWith({ action: '', page: 1 }),
                },
              ]
            : []),
          ...(filters.resourceType
            ? [
                {
                  key: 'resourceType',
                  label: `${t('logs.filter.resourceType')} : ${filters.resourceType}`,
                  href: hrefWith({ resourceType: '', page: 1 }),
                },
              ]
            : []),
        ]}
      />

      {items.length === 0 ? (
        <div className="p-4">
          <EmptyState icon={ScrollText} title={t('logs.empty.title')} hint={t('logs.empty.hint')} />
        </div>
      ) : (
        <Table label={t('logs.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{c('column.date')}</TableHead>
              <TableHead>{t('logs.column.severity')}</TableHead>
              <TableHead>{t('logs.column.actor')}</TableHead>
              <TableHead>{t('logs.column.action')}</TableHead>
              <TableHead>{t('logs.column.resource')}</TableHead>
              <TableHead>{t('logs.column.ip')}</TableHead>
              <TableHead>{c('column.detail')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow
                key={item.id}
                interactive
                selected={drawer.selected === item.id}
                onClick={() => drawer.open(item.id)}
              >
                <TableCell className="mono whitespace-nowrap text-text-2">
                  <button
                    type="button"
                    className="text-left hover:underline"
                    aria-label={t('logs.row.open', { action: item.action })}
                    onClick={(event) => {
                      event.stopPropagation();
                      drawer.open(item.id);
                    }}
                  >
                    {formatDateTime(item.createdAt, format)}
                  </button>
                </TableCell>
                <TableCell>
                  <SeverityTag severity={auditSeverityOf(item.action)} />
                </TableCell>
                <TableCell>
                  {item.actorEmail ?? (
                    <span className="text-text-3 italic">{t('logs.anonymous')}</span>
                  )}
                  {item.apiTokenName ? (
                    <span className="t-cap block text-text-3">
                      {t('logs.viaToken', { name: item.apiTokenName })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <CodeBadge>{item.action}</CodeBadge>
                </TableCell>
                <TableCell className="mono">
                  {item.resourceType}
                  {item.resourceId ? `:${item.resourceId}` : ''}
                </TableCell>
                <TableCell className="mono text-text-2">{item.ip ?? c('none')}</TableCell>
                <TableCell className="mono max-w-[16rem] truncate text-[11.5px] text-text-3">
                  {item.after ? JSON.stringify(item.after) : c('none')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="pager">
        <span>{t('logs.timezone', { timezone: format.timezone })}</span>
        {page.totalPages > 1 ? (
          <span className="ml-auto flex items-center gap-2">
            {page.page > 1 ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={hrefWith({ page: page.page - 1 }) as never}>
                  <ChevronLeft aria-hidden />
                  {c('page.previous')}
                </Link>
              </Button>
            ) : null}
            <span className="num">
              {c('page.position', { page: page.page, total: page.totalPages })}
            </span>
            {page.page < page.totalPages ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={hrefWith({ page: page.page + 1 }) as never}>
                  {c('page.next')}
                  <ChevronRight aria-hidden />
                </Link>
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>

      <Drawer
        open={current !== null}
        onOpenChange={(open) => (open ? undefined : drawer.close())}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
      >
        {current ? (
          <EntryDrawer
            entry={current}
            format={format}
            filterHref={current.actorId ? hrefWith({ actorId: current.actorId, page: 1 }) : null}
            actionHref={hrefWith({ action: current.action, page: 1 })}
          />
        ) : null}
      </Drawer>
    </section>
  );
}

/** Les quatre criticités, en puces : chacune s'ajoute ou se retire du filtre. */
function SeverityFilter({
  selected,
  counts,
  hrefFor,
  extra,
}: {
  selected: AuditSeverity[];
  counts: Record<AuditSeverity, number>;
  /** Le lien qui applique cette liste de criticités (`''` : toutes). */
  hrefFor: (severity: string) => string;
  /** Les filtres venus d'un lien (action, type de ressource), à retirer d'un clic. */
  extra: Array<{ key: string; label: string; href: string }>;
}) {
  const t = useT(admin);
  // De la plus grave à la plus anodine : l'œil cherche d'abord le rouge.
  const scale = [...AUDIT_SEVERITIES].reverse();

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 pt-3 pb-3">
      <span className="t-cap mr-1 text-text-3">{t('logs.filter.severity')}</span>
      {scale.map((severity) => {
        const active = selected.includes(severity);
        const next = active
          ? selected.filter((value) => value !== severity)
          : AUDIT_SEVERITIES.filter((value) => value === severity || selected.includes(value));
        return (
          <Tooltip key={severity} content={t(`logs.severity.${severity}.help`)} wide>
            <FilterChipLink
              href={hrefFor(next.join(',')) as never}
              active={active}
              count={counts[severity]}
            >
              <span aria-hidden className={`sev-dot ${SEVERITY_DOT[severity]}`} />
              {t(`logs.severity.${severity}`)}
            </FilterChipLink>
          </Tooltip>
        );
      })}
      {extra.map((filter) => (
        <FilterChipLink
          key={filter.key}
          href={filter.href as never}
          active
          aria-label={t('logs.filter.remove', { filter: filter.label })}
        >
          <span className="mono">{filter.label}</span>
          <X aria-hidden className="size-3.5" />
        </FilterChipLink>
      ))}
    </div>
  );
}

const SEVERITY_DOT: Record<AuditSeverity, string> = {
  critical: 'sev-c',
  high: 'sev-h',
  medium: 'sev-m',
  low: 'sev-l',
};

/** La criticité d'une entrée, en aplat de couleur, avec son explication au survol. */
function SeverityTag({ severity }: { severity: AuditSeverity }) {
  const t = useT(admin);
  return (
    <Tooltip content={t(`logs.severity.${severity}.help`)} wide>
      <SeverityBadge severity={severity} tabIndex={0}>
        {t(`logs.severity.${severity}`)}
      </SeverityBadge>
    </Tooltip>
  );
}

/** Une charge utile JSON, indentée : lisible sans outil, copiable telle quelle. */
function payloadOf(entry: AuditEntry): string | null {
  const parts: Record<string, unknown> = {};
  if (entry.before !== null && entry.before !== undefined) parts.before = entry.before;
  if (entry.after !== null && entry.after !== undefined) parts.after = entry.after;
  if (Object.keys(parts).length === 0) return null;
  // Une seule moitié présente : on la montre nue, sans l'enveloppe.
  const only = Object.keys(parts).length === 1 ? Object.values(parts)[0] : parts;
  return JSON.stringify(only, null, 2);
}

function EntryDrawer({
  entry,
  format,
  filterHref,
  actionHref,
}: {
  entry: AuditEntry;
  format: FormatSettings;
  filterHref: string | null;
  actionHref: string;
}) {
  const t = useT(admin);
  const c = useT(common);
  const payload = payloadOf(entry);
  const denial = DENIAL_ACTIONS.has(entry.action);

  return (
    <>
      <DrawerHeader
        icon={<ScrollText />}
        kind={t('logs.drawer.kind')}
        route={`#${entry.id.slice(0, 8)}`}
        title={<span className="mono">{entry.action}</span>}
        state={
          <>
            <SeverityTag severity={auditSeverityOf(entry.action)} />
            {denial ? (
              <Badge variant="danger" dot>
                {t('logs.denial')}
              </Badge>
            ) : null}
            <span className="mono text-text-2">{formatDateTime(entry.createdAt, format)}</span>
          </>
        }
      />
      <DrawerBody>
        <DrawerSection title={t('logs.drawer.who')}>
          <KeyValue
            items={[
              {
                term: t('logs.column.actor'),
                value: entry.actorEmail ? (
                  <span className="mono">{entry.actorEmail}</span>
                ) : (
                  <span className="text-text-3 italic">{t('logs.anonymous')}</span>
                ),
              },
              ...(entry.apiTokenName
                ? [{ term: t('logs.column.token'), value: entry.apiTokenName }]
                : []),
              {
                term: t('logs.column.action'),
                value: <span className="mono">{entry.action}</span>,
              },
              {
                term: t('logs.column.resource'),
                value: (
                  <span className="mono">
                    {entry.resourceType}
                    {entry.resourceId ? `:${entry.resourceId}` : ''}
                  </span>
                ),
              },
              {
                term: t('logs.column.ip'),
                value: <span className="mono">{entry.ip ?? c('none')}</span>,
              },
              {
                term: t('logs.column.agent'),
                // L'en-tête complet reste lisible au survol : le résumé suffit
                // à reconnaître un appareil, pas à enquêter.
                value: entry.userAgent ? (
                  <span className="t-sm" title={entry.userAgent}>
                    {describeUserAgent(entry.userAgent)}
                  </span>
                ) : (
                  c('none')
                ),
              },
            ]}
          />
        </DrawerSection>
        <DrawerSection title={t('logs.drawer.payload')}>
          {payload ? (
            <pre className="codeblock max-h-[24rem]">{payload}</pre>
          ) : (
            <p className="t-sm text-text-3">{t('logs.drawer.none')}</p>
          )}
        </DrawerSection>
      </DrawerBody>
      <DrawerFooter end={null}>
        {payload ? (
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(payload)
                .then(() => toast({ title: t('logs.drawer.copied') }));
            }}
          >
            <Copy aria-hidden />
            {t('logs.drawer.copy')}
          </Button>
        ) : null}
        <Button asChild variant="ghost">
          <Link href={actionHref as never}>
            <Filter aria-hidden />
            {t('logs.drawer.filterAction')}
          </Link>
        </Button>
        {filterHref ? (
          <Button asChild variant="ghost">
            <Link href={filterHref as never}>
              <Filter aria-hidden />
              {t('logs.drawer.filterActor')}
            </Link>
          </Button>
        ) : null}
      </DrawerFooter>
    </>
  );
}
