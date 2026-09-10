import { deployLogLineSchema, type DeployLogLine } from '@tp/core';
import {
  asc,
  deploymentSteps,
  eq,
  getDb,
  getDeploymentSummary,
  logAudit,
  sql,
  type DeploymentSummary,
} from '@tp/db';
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { apiRoute, readSearchParams } from '@/lib/http';
import { logger } from '@/lib/logger';
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
  if (!deployment) throw new NotFoundError(`Déploiement « ${id} » introuvable`);

  const exportedAt = new Date();
  const render = format === 'jsonl' ? renderJsonl : renderText;

  let lines = 0;
  const iterator = streamLogChunks(id, render, () => {
    lines += 1;
  });

  let settled = false;
  /** Journalise l'export une seule fois, terminé ou interrompu. */
  const settle = async (complete: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
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
        version: deployment.version,
      },
      ip: auth.ip,
    });
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Le JSONL ne porte aucun en-tête : une ligne du fichier doit rester une
      // ligne de log, sans quoi un `wc -l` mentirait et `jq` trébucherait.
      if (format === 'text') {
        controller.enqueue(encoder.encode(textHeader(deployment, exportedAt, auth.email)));
      }
    },

    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          await settle(true);
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (error) {
        // Le corps a déjà commencé à partir : impossible de repasser en 500.
        // On coupe le flux — un fichier tronqué vaut mieux qu'un fichier faux.
        logger.error({ err: error, deploymentId: id }, "export du journal interrompu");
        controller.error(error);
        await settle(false);
      }
    },

    async cancel() {
      await iterator.return(undefined);
      await settle(false);
    },
  });

  const extension = format === 'jsonl' ? 'jsonl' : 'log';
  const stamp = (deployment.finishedAt ?? deployment.createdAt).toISOString().slice(0, 10);
  const filename = `${deployment.applicationSlug}-v${deployment.version}-${stamp}.${extension}`;

  return new Response(stream, {
    headers: {
      'content-type':
        format === 'jsonl'
          ? 'application/x-ndjson; charset=utf-8'
          : 'text/plain; charset=utf-8',
      'content-disposition': contentDisposition(filename),
      'cache-control': 'no-store',
      // nginx retiendrait le flux jusqu'à la fin sans cet en-tête.
      'x-accel-buffering': 'no',
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
  const finished = deployment.finishedAt?.toISOString() ?? 'non terminé';

  return [
    `# Journal de déploiement — ${deployment.applicationSlug} v${deployment.version}`,
    `# Déploiement : ${deployment.id}`,
    `# Cible : ${deployment.targetName} (${deployment.targetHost}) · ${deployment.runtime} · ${deployment.proxy}`,
    `# Statut : ${deployment.status}${deployment.failedStep ? ` (échec sur « ${deployment.failedStep} »)` : ''}`,
    `# Démarré : ${started} · terminé : ${finished}`,
    `# Journal complet tel qu'il est conservé en base, dans l'ordre des étapes.`,
    `# Exporté le ${exportedAt.toISOString()} par ${actorEmail}`,
    '#',
    '',
  ].join('\n');
}

// ─── en-tête HTTP ─────────────────────────────────────────────────────────────

/**
 * `content-disposition` conforme à la RFC 6266.
 *
 * Un slug est censé être en kebab-case ASCII, mais il vient de la base : rien
 * ne garantit qu'un enregistrement ancien le respecte, et un guillemet ou un
 * saut de ligne dans un en-tête casse la réponse entière. On produit donc les
 * deux formes : `filename` assaini en ASCII pour les clients anciens, et
 * `filename*` percent-encodé en UTF-8, que les navigateurs préfèrent.
 */
function contentDisposition(filename: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\/:*?<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.\s]+|[\s.]+$/g, '');

  const fallback = ascii.length > 0 ? ascii : 'journal-deploiement.log';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(filename)}`;
}

/** `encodeURIComponent` laisse passer `!'()*`, que la RFC 5987 veut encodés. */
function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
