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

/** The remote proxies — outside the targets, reached through their API. */
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
 * Connecting a remote proxy — Nginx Proxy Manager. The credentials are encrypted
 * as soon as they are saved; the test goes out right away and the route waits
 * for its outcome: a connection that does not get in is not kept, the reason is
 * given.
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
    // Nothing to keep from a connection that does not work: we remove it, and say why.
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
    // The configuration shows; the secrets never enter the log.
    after: { kind: input.kind, name: created.name, config },
    ip: auth.ip,
  });
  const saved = await getProxy(created.id);
  return NextResponse.json(
    { proxy: remoteProxyViewForUi(saved ?? created), checked: check !== null },
    { status: 201 },
  );
});
