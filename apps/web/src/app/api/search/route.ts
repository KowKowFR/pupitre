import { listApplications, listDeployments, listMonitors, listTargets } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requireSession } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Recherche d'objets pour la palette ⌘K : cibles, applications,
 * déploiements, sondes.
 *
 * **Filtrée par permission, à la source.** Une famille d'objets n'est même
 * pas lue si la session n'a pas le droit de la consulter : ce qu'une
 * permission interdit disparaît de la palette comme du rail, et une réponse
 * JSON ne doit pas en dire plus que l'écran.
 *
 * Les requêtes sont celles des écrans de liste, filtrées en mémoire : une
 * instance compte des dizaines d'objets, pas des millions, et réutiliser les
 * mêmes lectures garantit que la palette ne montre rien que la liste ne
 * montrerait pas. Les runs font exception : eux se comptent par milliers, et
 * la recherche passe par celle de la liste des déploiements, en base — c'est
 * elle qui retrouve `#127` même s'il a six mois. Le texte affiché
 * (« Cible · 10.0.0.11 ») est composé par le client, dans sa langue : la
 * route ne renvoie que des champs.
 */
const querySchema = z.object({
  q: z.string().trim().max(100).default(''),
  /** Restreint à une famille ; avec une saisie vide, liste alors ses premiers objets. */
  kind: z.enum(['target', 'application', 'deployment', 'monitor']).optional(),
});

/** Par famille dans la recherche libre ; davantage quand on n'en cherche qu'une. */
const FAMILY_LIMIT = 5;
const SCOPED_LIMIT = 20;

export type SearchHit =
  | { kind: 'target'; id: string; title: string; host: string; status: string }
  | { kind: 'application'; id: string; title: string; slug: string; version: string | null }
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
  | { kind: 'monitor'; id: string; title: string; type: string; status: string };

function matches(needle: string, ...fields: Array<string | null | undefined>): boolean {
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

export const GET = apiRoute(async (request) => {
  const auth = await requireSession(request);
  const { q, kind } = readSearchParams(request, querySchema);
  const needle = q.toLowerCase().replace(/^#/, '');
  if (needle === '' && kind === undefined)
    return NextResponse.json({ items: [] satisfies SearchHit[] });

  const wants = (family: SearchHit['kind']) => kind === undefined || kind === family;
  const limit = kind === undefined ? FAMILY_LIMIT : SCOPED_LIMIT;

  const [targets, applications, deployments, monitors] = await Promise.all([
    wants('target') && auth.can('target:read') ? listTargets() : null,
    wants('application') && auth.can('application:read') ? listApplications() : null,
    wants('deployment') && auth.can('deployment:read')
      ? listDeployments({ q: needle === '' ? undefined : needle, page: 1, pageSize: limit })
      : null,
    wants('monitor') && auth.can('monitor:read') ? listMonitors() : null,
  ]);

  const items: SearchHit[] = [];

  for (const target of (targets ?? [])
    .filter((t) =>
      matches(
        needle,
        t.name,
        t.host,
        t.description,
        ...Object.entries(t.labels).map(([k, v]) => `${k}=${v}`),
      ),
    )
    .slice(0, limit)) {
    items.push({
      kind: 'target',
      id: target.id,
      title: target.name,
      host: target.host,
      status: target.status,
    });
  }

  for (const app of (applications ?? [])
    .filter((a) => matches(needle, a.slug, a.name, a.description))
    .slice(0, limit)) {
    const spec = app.appSpec as { version?: unknown } | null;
    items.push({
      kind: 'application',
      id: app.id,
      title: app.name,
      slug: app.slug,
      version: typeof spec?.version === 'string' ? spec.version : null,
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

  for (const monitor of (monitors ?? [])
    .filter((m) => matches(needle, m.name, m.type))
    .slice(0, limit)) {
    items.push({
      kind: 'monitor',
      id: monitor.id,
      title: monitor.name,
      type: monitor.type,
      status: monitor.status,
    });
  }

  return NextResponse.json({ items });
});
