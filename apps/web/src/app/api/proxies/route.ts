import {
  PROXY_CHECK_JOB,
  describeProxy,
  parseProxyConfig,
  parseProxySecrets,
  proxyKindSchema,
  proxyPlacement,
} from '@pupitre/core';
import { createRemoteProxy, deleteProxy, getProxy, listRemoteProxies, logAudit } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { HttpError, msg } from '@/lib/errors';
import { apiRoute, readJsonBody } from '@/lib/http';
import { remoteProxyViewForUi, waitForProxyCheck } from '@/lib/proxy';
import { getOpsQueue } from '@/lib/queue';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Les proxies distants — hors des cibles, joints par leur API. */
export const GET = apiRoute(async (request) => {
  await requirePermission(request, 'target:read');
  const proxies = await listRemoteProxies();
  return NextResponse.json({ proxies: proxies.map(remoteProxyViewForUi) });
});

const postSchema = z.object({
  kind: proxyKindSchema,
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.unknown()),
});

/**
 * Connecter un proxy distant — Nginx Proxy Manager. Les identifiants sont
 * chiffrés dès l'enregistrement ; le test part aussitôt et la route attend son
 * issue : une connexion qui n'entre pas n'est pas gardée, la raison est dite.
 */
export const POST = apiRoute(async (request) => {
  const auth = await requirePermission(request, 'target:update');
  const input = await readJsonBody(request, postSchema);
  if (proxyPlacement(input.kind) !== 'remote') {
    throw new HttpError(422, 'proxy_not_remote', msg(messages, 'error.notRemote'));
  }
  const config = parseProxyConfig(input.kind, input.config) as Record<string, unknown>;
  const secrets = parseProxySecrets(input.kind, input.secrets);

  const created = await createRemoteProxy({
    kind: input.kind,
    name: input.name ?? describeProxy(input.kind, config).split(' · ').slice(0, 2).join(' · '),
    config,
    secrets,
    createdBy: auth.userId,
  });
  const job = await getOpsQueue().add(PROXY_CHECK_JOB, { proxyId: created.id }, { attempts: 1 });
  const check = await waitForProxyCheck(job);
  if (check && !check.ok) {
    // Rien à garder d'une connexion qui ne marche pas : on la retire, et on dit pourquoi.
    await deleteProxy(created.id);
    throw new HttpError(
      422,
      'proxy_check_failed',
      msg(messages, 'error.remoteCheckFailed', {
        problems: check.checks
          .filter((item) => !item.ok)
          .map((item) => `${item.label} : ${item.detail ?? ''}`)
          .join(' · '),
      }),
    );
  }
  await logAudit({
    actorId: auth.userId,
    action: 'proxy.connected',
    resourceType: 'proxy',
    resourceId: created.id,
    // La configuration se montre ; les secrets n'entrent jamais au journal.
    after: { kind: input.kind, name: created.name, config },
    ip: auth.ip,
  });
  const saved = await getProxy(created.id);
  return NextResponse.json(
    { proxy: remoteProxyViewForUi(saved ?? created), checked: check !== null },
    { status: 201 },
  );
});
