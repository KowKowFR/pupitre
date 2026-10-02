import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostnameSchema, proxyEntrypointHost } from '@pupitre/core';
import { getTarget, resolveServingProxy } from '@pupitre/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { proxy as messages } from '@/i18n/messages/proxy';
import { NotFoundError, msg } from '@/lib/errors';
import { apiRoute } from '@/lib/http';
import { requirePermission } from '@/lib/rbac';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({ hostname: hostnameSchema });
type Context = { params: Promise<{ id: string }> };

async function addressesOf(name: string): Promise<string[]> {
  if (isIP(name)) return [name];
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  const [v4, v6] = await Promise.all([
    resolver.resolve4(name).catch(() => [] as string[]),
    resolver.resolve6(name).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

/**
 * Ce domaine pointe-t-il vers la machine qui recevra ses visiteurs — celle-ci,
 * ou celle du proxy qui la sert quand c'est celui d'une autre ? Un avertissement, jamais un
 * refus : derrière un NAT, un CDN ou un tunnel, l'adresse publique n'est pas
 * celle par laquelle le panel joint la cible — et le DNS peut ne pas être
 * encore propagé. Le certificat, lui, attendra qu'il le soit.
 */
export const GET = apiRoute<Context>(async (request, context) => {
  await requirePermission(request, 'target:read');
  const { id } = paramsSchema.parse(await context.params);
  const target = await getTarget(id);
  if (!target) throw new NotFoundError(msg(messages, 'error.targetNotFound'));
  const { hostname } = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
  const serving = await resolveServingProxy(id);
  const proxyHost =
    serving?.link && serving.proxy.hostTargetId
      ? await getTarget(serving.proxy.hostTargetId)
      : null;
  // Un proxy distant reçoit sur sa propre entrée, hors des cibles.
  const remoteHost =
    serving?.link && !serving.proxy.hostTargetId
      ? proxyEntrypointHost(serving.proxy.kind, serving.proxy.config)
      : null;
  const receiving = proxyHost?.host ?? remoteHost ?? target.host;
  const [addresses, targetAddresses] = await Promise.all([
    addressesOf(hostname),
    addressesOf(receiving),
  ]);
  return NextResponse.json({
    hostname,
    addresses,
    targetAddresses,
    resolves: addresses.length > 0,
    matches: addresses.some((address) => targetAddresses.includes(address)),
    /** Le proxy, quand il n'est pas sur celle-ci. */
    via: proxyHost?.name ?? (remoteHost ? serving!.proxy.name : null),
  });
});
