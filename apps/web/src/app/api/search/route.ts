import { CATALOG_TEMPLATES, rankByMatch } from '@pupitre/core';
import {
  listApplications,
  listDeployments,
  listMonitors,
  listRoles,
  listRoutes,
  listSupervisedApps,
  listTargets,
} from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { currentLanguage } from '@/i18n/server';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = [
  'target',
  'application',
  'running',
  'deployment',
  'monitor',
  'domain',
  'role',
  'template',
] as const;
type Kind = (typeof KINDS)[number];

/**
 * Recherche d'objets pour la palette ⌘K : cibles, applications, applications
 * en marche, déploiements, sondes, domaines, rôles, modèles du catalogue.
 *
 * **Filtrée par permission, à la source.** Une famille d'objets n'est même
 * pas lue si la session n'a pas le droit de la consulter : ce qu'une
 * permission interdit disparaît de la palette comme du rail, et une réponse
 * JSON ne doit pas en dire plus que l'écran.
 *
 * Les requêtes sont celles des écrans de liste, filtrées en mémoire par une
 * correspondance **tolérante** (`matchScore` : accents, débuts de mots,
 * lettres dans l'ordre, fautes de frappe) et rangées par pertinence : une
 * instance compte des dizaines d'objets, pas des millions. Les runs font
 * exception : eux se comptent par milliers, et la recherche passe par celle
 * de la liste des déploiements, en base — c'est elle qui retrouve `#127` même
 * s'il a six mois. Le texte affiché (« Cible · 10.0.0.11 ») est composé par le
 * client, dans sa langue : la route ne renvoie que des champs.
 */
const querySchema = z.object({
  q: z.string().trim().max(100).default(''),
  /** Restreint à une famille ; avec une saisie vide, liste alors ses premiers objets. */
  kind: z.enum(KINDS).optional(),
  /** Plusieurs familles à la fois (`running,monitor`), même règle qu'avec `kind`. */
  kinds: z
    .string()
    .max(200)
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .filter((entry): entry is Kind => (KINDS as readonly string[]).includes(entry))
        : undefined,
    ),
});

/** Par famille dans la recherche libre ; davantage quand on n'en cherche qu'une. */
const FAMILY_LIMIT = 5;
const SCOPED_LIMIT = 20;

export type SearchHit =
  | { kind: 'target'; id: string; title: string; host: string; status: string }
  | { kind: 'application'; id: string; title: string; slug: string; version: string | null }
  | {
      /** Une application en service sur une cible : son dernier déploiement vivant. */
      kind: 'running';
      id: string;
      title: string;
      target: string;
      health: string;
    }
  | {
      kind: 'deployment';
      id: string;
      /** Numéro de run, global à l'instance. */
      number: number;
      title: string;
      version: number;
      status: string;
      target: string;
    }
  | { kind: 'monitor'; id: string; title: string; type: string; status: string; enabled: boolean }
  | { kind: 'domain'; id: string; title: string; application: string; status: string }
  | { kind: 'role'; id: string; title: string; key: string }
  | { kind: 'template'; id: string; title: string; summary: string };

export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const { q, kind, kinds } = readSearchParams(request, querySchema);
  const scoped = kinds ?? (kind ? [kind] : undefined);
  const needle = q.replace(/^#/, '');
  if (needle === '' && scoped === undefined)
    return NextResponse.json({ items: [] satisfies SearchHit[] });

  const wants = (family: Kind) => scoped === undefined || scoped.includes(family);
  const limit = scoped === undefined ? FAMILY_LIMIT : SCOPED_LIMIT;
  const language = await currentLanguage();

  const [targets, applications, running, deployments, monitors, routes, roles] = await Promise.all([
    wants('target') && auth.can('target:read') ? listTargets() : null,
    wants('application') && auth.can('application:read') ? listApplications() : null,
    wants('running') && auth.can('deployment:read') ? listSupervisedApps() : null,
    wants('deployment') && auth.can('deployment:read')
      ? listDeployments({ q: needle === '' ? undefined : needle, page: 1, pageSize: limit })
      : null,
    wants('monitor') && auth.can('monitor:read') ? listMonitors() : null,
    wants('domain') && auth.can('application:read') ? listRoutes({}) : null,
    wants('role') && auth.can('role:read') ? listRoles() : null,
  ]);

  const items: SearchHit[] = [];

  for (const target of rankByMatch(
    needle,
    targets ?? [],
    (t) => [t.name, t.host, ...Object.entries(t.labels).map(([k, v]) => `${k}=${v}`)],
    (t) => [t.description],
  ).slice(0, limit)) {
    items.push({
      kind: 'target',
      id: target.id,
      title: target.name,
      host: target.host,
      status: target.status,
    });
  }

  for (const app of rankByMatch(
    needle,
    applications ?? [],
    (a) => [a.slug, a.name],
    (a) => [a.description],
  ).slice(0, limit)) {
    const spec = app.appSpec as { version?: unknown } | null;
    items.push({
      kind: 'application',
      id: app.id,
      title: app.name,
      slug: app.slug,
      version: typeof spec?.version === 'string' ? spec.version : null,
    });
  }

  for (const app of rankByMatch(needle, running ?? [], (a) => [
    a.applicationSlug,
    a.targetName,
    `${a.applicationSlug}@${a.targetName}`,
    a.url,
  ]).slice(0, limit)) {
    items.push({
      kind: 'running',
      id: app.id,
      title: app.applicationSlug,
      target: app.targetName,
      health: app.healthStatus,
    });
  }

  for (const deployment of deployments?.items ?? []) {
    items.push({
      kind: 'deployment',
      id: deployment.id,
      number: deployment.number,
      title: deployment.applicationSlug,
      version: deployment.version,
      status: deployment.status,
      target: deployment.targetName,
    });
  }

  for (const monitor of rankByMatch(needle, monitors ?? [], (m) => [m.name, m.type]).slice(
    0,
    limit,
  )) {
    items.push({
      kind: 'monitor',
      id: monitor.id,
      title: monitor.name,
      type: monitor.type,
      status: monitor.status,
      enabled: monitor.enabled,
    });
  }

  for (const route of rankByMatch(needle, routes ?? [], (r) => [
    r.hostname,
    r.applicationSlug,
  ]).slice(0, limit)) {
    items.push({
      kind: 'domain',
      id: route.id,
      title: route.hostname,
      application: route.applicationSlug,
      status: route.status,
    });
  }

  for (const role of rankByMatch(needle, roles ?? [], (r) => [r.label, r.key]).slice(0, limit)) {
    items.push({ kind: 'role', id: role.key, title: role.label, key: role.key });
  }

  // Le catalogue n'est lu par personne d'autre que qui peut créer une application.
  if (wants('template') && auth.can('application:create')) {
    for (const template of rankByMatch(
      needle,
      CATALOG_TEMPLATES,
      (t) => [t.name, t.id],
      (t) => [t.summary[language]],
    ).slice(0, limit)) {
      items.push({
        kind: 'template',
        id: template.id,
        title: template.name,
        summary: template.summary[language],
      });
    }
  }

  return NextResponse.json({ items });
});
