import { deployLogLineSchema, type DeployLogLine } from '@pupitre/core';
import {
  asc,
  deploymentSteps,
  eq,
  getDb,
  getDeploymentSummary,
  logAudit,
  sql,
  type DeploymentSummary,
} from '@pupitre/db';
import { z } from 'zod';
import { deployments as messages } from '@/i18n/messages/deployments';
import { NotFoundError, msg } from '@/lib/errors';
import { exportResponse } from '@/lib/export';
import { apiRoute, readSearchParams } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  /** `text` : lisible par un humain. `jsonl` : une ligne = un objet JSON. */
  format: z.enum(['text', 'jsonl']).default('text'),
});

type Context = { params: Promise<{ id: string }> };

/**
 * Taille d'une tranche de `deployment_steps.log` relue en base.
 *
 * Le journal d'une étape est une seule colonne `text` qui peut peser plusieurs
 * mégaoctets. La lire d'un bloc — ce que fait `readDeploymentLog()` pour la
 * relecture SSE — chargerait tout en mémoire avant d'écrire le premier octet.
 * On la découpe donc en tranches de caractères, et la réponse part dès la
 * première.
 */
const CHUNK_CHARS = 64 * 1024;

/** Au-delà, on pousse la tranche courante dans le flux plutôt que d'empiler. */
const FLUSH_CHARS = 16 * 1024;

/**
 * Export du journal **persisté** d'un déploiement.
 *
 * Contrairement aux logs applicatifs, ce journal est fini : il a un début, une
 * fin, et il est intégralement en base. L'export est donc une lecture exacte,
 * pas un instantané — le fichier contient tout ce que `deployment_steps.log`
 * contient, dans l'ordre des étapes puis des lignes.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  const auth = await requirePermission(request, 'deployment:read');
  const { id } = paramsSchema.parse(await context.params);
  const { format } = readSearchParams(request, querySchema);

  const deployment = await getDeploymentSummary(id);
  if (!deployment) throw new NotFoundError(msg(messages, 'error.notFound', { id }));

  const exportedAt = new Date();
  const render = format === 'jsonl' ? renderJsonl : renderText;

  // Le JSONL ne porte aucun en-tête : une ligne du fichier doit rester une
  // ligne de log, sans quoi un `wc -l` mentirait et `jq` trébucherait.
  const header = format === 'text' ? textHeader(deployment, exportedAt, auth.email) : null;

  let lines = 0;
  async function* chunks(): AsyncGenerator<string, void, undefined> {
    if (header) yield header;
    yield* streamLogChunks(id, render, () => {
      lines += 1;
    });
  }

  const extension = format === 'jsonl' ? 'jsonl' : 'log';
  const stamp = (deployment.finishedAt ?? deployment.createdAt).toISOString().slice(0, 10);

  return exportResponse({
    chunks: chunks(),
    contentType:
      format === 'jsonl' ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
    filename: `${deployment.applicationSlug}-v${deployment.version}-${stamp}.${extension}`,
    fallbackName: 'deployment-log.log',
    context: { deploymentId: id },
    onSettled: async (complete) => {
      await logAudit({
        actorId: auth.userId,
        action: 'deployment.logs.exported',
        resourceType: 'deployment',
        resourceId: id,
        after: {
          format,
          lines,
          complete,
          applicationSlug: deployment.applicationSlug,
          number: deployment.number,
          version: deployment.version,
        },
        ip: auth.ip,
      });
    },
  });
});

// ─── lecture en base, par tranches ────────────────────────────────────────────

/**
 * Produit le fichier morceau par morceau, sans jamais tenir plus d'une tranche
 * de journal en mémoire.
 *
 * Une tranche coupe forcément une ligne en deux : le reste est reporté sur la
 * tranche suivante (`remainder`). C'est le seul état à porter d'un tour à
 * l'autre, et c'est ce qui rend le découpage invisible dans le fichier produit.
 */
async function* streamLogChunks(
  deploymentId: string,
  render: (line: DeployLogLine) => string,
  countLine: () => void,
): AsyncGenerator<string, void, undefined> {
  const db = getDb();

  // On ne lit ici que la taille des journaux, pas leur contenu : la liste des
  // étapes doit tenir en mémoire, leurs journaux non.
  const steps = await db
    .select({
      id: deploymentSteps.id,
      size: sql<number>`length(${deploymentSteps.log})`.mapWith(Number),
    })
    .from(deploymentSteps)
    .where(eq(deploymentSteps.deploymentId, deploymentId))
    .orderBy(asc(deploymentSteps.order));

  let pending = '';

  for (const step of steps) {
    if (step.size === 0) continue;

    let offset = 1; // `substr()` de PostgreSQL est indexé à partir de 1.
    let remainder = '';

    while (offset <= step.size) {
      const [row] = await db
        .select({
          chunk: sql<string>`substr(${deploymentSteps.log}, ${offset}, ${CHUNK_CHARS})`,
        })
        .from(deploymentSteps)
        .where(eq(deploymentSteps.id, step.id));
      offset += CHUNK_CHARS;
      if (!row) break;

      const parts = (remainder + row.chunk).split('\n');
      remainder = parts.pop() ?? '';

      for (const raw of parts) {
        const rendered = renderRaw(raw, render);
        if (rendered === null) continue;
        countLine();
        pending += rendered;
        if (pending.length >= FLUSH_CHARS) {
          yield pending;
          pending = '';
        }
      }
    }

    // Dernière ligne d'une étape que le worker n'a pas terminée par un saut de
    // ligne : elle est complète, elle doit sortir.
    const rendered = renderRaw(remainder, render);
    if (rendered !== null) {
      countLine();
      pending += rendered;
    }
  }

  if (pending.length > 0) yield pending;
}

/** `null` pour une ligne vide ou tronquée par un arrêt brutal du worker. */
function renderRaw(raw: string, render: (line: DeployLogLine) => string): string | null {
  if (raw.trim().length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = deployLogLineSchema.safeParse(json);
  return parsed.success ? render(parsed.data) : null;
}

// ─── rendus ───────────────────────────────────────────────────────────────────

/** Colonnes fixes : horodatage, étape, canal, message. Rien n'est perdu. */
function renderText(line: DeployLogLine): string {
  const stream = line.stream === 'stderr' ? 'err' : 'out';
  return `${line.ts}  ${line.step.padEnd(14)}  ${stream}  ${line.line}\n`;
}

function renderJsonl(line: DeployLogLine): string {
  return `${JSON.stringify(line)}\n`;
}

/**
 * En-tête du fichier texte, en lignes de commentaire `#`.
 *
 * Il dit d'où vient le fichier — sans lui, un journal exporté n'est qu'un mur
 * de lignes sans propriétaire. Le préfixe `#` le rend filtrable (`grep -v '^#'`)
 * et le distingue des lignes de log, qui commencent toutes par un horodatage.
 */
function textHeader(
  deployment: DeploymentSummary,
  exportedAt: Date,
  actorEmail: string,
): string {
  const started = deployment.startedAt?.toISOString() ?? '—';

  // An exported file is not interface: it is a dated artifact, downloaded,
  // archived, read again months later. Its header is in the project's
  // language, English, whatever the instance's language: two exports of the
  // same deployment must read side by side even if the language changed in
  // between. The log lines below it stay in the language they were written in.
  const finished = deployment.finishedAt?.toISOString() ?? 'not finished';
  const failure = deployment.failedStep ? ` (failed at "${deployment.failedStep}")` : '';

  return `# Deployment log — ${deployment.applicationSlug} v${deployment.version}
# Deployment: #${deployment.number} · ${deployment.id}
# Target: ${deployment.targetName} (${deployment.targetHost}) · ${deployment.runtime}
# Status: ${deployment.status}${failure}
# Started: ${started} · finished: ${finished}
# Full log as kept in the database, in step order.
# Exported on ${exportedAt.toISOString()} by ${actorEmail}
#
`;
}
