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
 * Object search for the ⌘K palette: targets, applications, running applications,
 * deployments, probes, domains, roles, catalog templates.
 *
 * **Filtered by permission, at the source.** A family of objects is not even read
 * if the session does not have the right to consult it: what a permission forbids
 * disappears from the palette as from the rail, and a JSON response must not say
 * more than the screen.
 *
 * The queries are the list screens', filtered in memory by a **tolerant** match
 * (`matchScore`: accents, word starts, letters in order, typos) and sorted by
 * relevance: an instance counts dozens of objects, not millions. The runs are the
 * exception: they count in thousands, and the search goes through the
 * deployments list's, in the database — it is what finds `#127` even if it is six
 * months old. The displayed text ("Target · 10.0.0.11") is composed by the
 * client, in its language: the route only returns fields.
 */
const querySchema = z.object({
  q: z.string().trim().max(100).default(''),
  /** Restricted to one family; with an empty input, it then lists its first objects. */
  kind: z.enum(KINDS).optional(),
  /** Several families at once (`running,monitor`), the same rule as with `kind`. */
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

/** Per family in the free search; more when only one is searched. */
const FAMILY_LIMIT = 5;
const SCOPED_LIMIT = 20;

export type SearchHit =
  | { kind: 'target'; id: string; title: string; host: string; status: string }
  | { kind: 'application'; id: string; title: string; slug: string; version: string | null }
  | {
      /** An application in service on a target: its last live deployment. */
      kind: 'running';
      id: string;
      title: string;
      target: string;
      health: string;
    }
  | {
      kind: 'deployment';
      id: string;
      /** Run number, global to the instance. */
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

  // The catalog is read by nobody other than whoever can create an application.
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
