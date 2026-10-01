import {
  parseAppSpec,
  proxyApplyJobDataSchema,
  proxyCheckJobDataSchema,
  proxyDetectJobDataSchema,
  proxyInstallJobDataSchema,
  proxyLinkCheckJobDataSchema,
  proxyRemoveJobDataSchema,
  routesCheckJobDataSchema,
} from '@pupitre/core';
import { getDriver } from '@pupitre/core/drivers';
import {
  getProxyProvider,
  type ProxyCheck,
  type ProxyDetection,
  type ProxyInstallOption,
} from '@pupitre/core/proxy';
import { disconnect, exec } from '@pupitre/core/ssh';
import {
  countRoutesServedBy,
  deleteProxy,
  getProxy,
  getTargetLink,
  listLiveDeployments,
  listRoutedCouples,
  logAudit,
  resolveServingProxy,
  setProxyStatus,
  setTargetLinkCheck,
  type ServingProxy,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { openDeploymentContext } from '../deploy/context.js';
import { openTargetContext } from '../deploy/target-context.js';
import { logger } from '../logger.js';
import { applyCoupleRoutes, probeCoupleRoutes, proxyContextOf } from '../proxy/routes.js';

/**
 * Les reverse proxies, côté worker : regarder ce qu'une machine a déjà,
 * installer, tester, retirer, et poser les domaines d'une application sans la
 * redéployer. Plus la sonde périodique des domaines.
 *
 * Aucune de ces tâches ne sait quel proxy elle pilote : elle demande au
 * provider du genre enregistré, comme le pipeline demande au driver.
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ce que la machine porte déjà, et ce que Pupitre pourrait y installer. */
export async function handleProxyDetect(job: Job): Promise<{
  detections: ProxyDetection[];
  installOptions: ProxyInstallOption[];
  lines: string[];
}> {
  const data = proxyDetectJobDataSchema.parse(job.data);
  const opened = await openTargetContext(data.targetId);
  const lines: string[] = [];
  try {
    // Un seul genre aujourd'hui ; demain, chaque provider regardera à son tour.
    const provider = getProxyProvider('traefik');
    const detections = await provider.detect(opened.ctx, (line) => lines.push(line));
    const installOptions = await provider.installOptions(opened.ctx);
    return { detections, installOptions, lines };
  } finally {
    await disconnect(opened.session);
  }
}

async function runCheck(proxyId: string): Promise<ProxyCheck | null> {
  const proxy = await getProxy(proxyId);
  if (!proxy?.hostTargetId) return null;
  const opened = await openTargetContext(proxy.hostTargetId);
  try {
    const check = await getProxyProvider(proxy.kind).check(
      proxyContextOf(proxy, opened.ctx),
      (line) => logger.info({ proxyId }, line),
    );
    const failed = check.checks.filter((item) => !item.ok);
    await setProxyStatus(proxyId, {
      status: check.ok ? 'ok' : 'failed',
      error:
        failed.length > 0
          ? failed.map((item) => `${item.label} : ${item.detail ?? 'en échec'}`).join(' · ')
          : null,
      check: check as unknown as Record<string, unknown>,
    });
    return check;
  } catch (error) {
    await setProxyStatus(proxyId, { status: 'failed', error: messageOf(error), check: null });
    throw error;
  } finally {
    await disconnect(opened.session);
  }
}

export async function handleProxyCheck(job: Job): Promise<ProxyCheck | null> {
  const data = proxyCheckJobDataSchema.parse(job.data);
  return runCheck(data.proxyId);
}

/**
 * Installer (ou régler) le proxy. La ligne de la connexion existe déjà, en
 * `installing` : l'écran la voit avancer. Elle finit `ok`, testée, ou
 * `failed`, avec la raison.
 */
export async function handleProxyInstall(job: Job): Promise<{ ok: boolean; error: string | null }> {
  const data = proxyInstallJobDataSchema.parse(job.data);
  const proxy = await getProxy(data.proxyId);
  if (!proxy) throw new Error('connexion de proxy introuvable');
  const opened = await openTargetContext(data.targetId);
  try {
    const config = await getProxyProvider(proxy.kind).install(
      opened.ctx,
      { option: data.option, acme: data.acme },
      (line) => logger.info({ proxyId: proxy.id }, line),
    );
    await setProxyStatus(proxy.id, {
      status: 'unknown',
      error: null,
      config: config as Record<string, unknown>,
      managed: true,
    });
    await logAudit({
      actorId: data.actorId,
      action: 'proxy.installed',
      resourceType: 'target',
      resourceId: data.targetId,
      after: {
        proxyId: proxy.id,
        kind: proxy.kind,
        option: data.option,
        acmeServer: data.acme.server,
      },
      ip: data.ip,
    });
  } catch (error) {
    const message = messageOf(error);
    await setProxyStatus(proxy.id, { status: 'failed', error: message, check: null });
    await logAudit({
      actorId: data.actorId,
      action: 'proxy.install.failed',
      resourceType: 'target',
      resourceId: data.targetId,
      after: { proxyId: proxy.id, kind: proxy.kind, option: data.option, error: message },
      ip: data.ip,
    });
    return { ok: false, error: message };
  } finally {
    await disconnect(opened.session);
  }
  const check = await runCheck(proxy.id).catch(() => null);
  return { ok: check?.ok ?? false, error: null };
}

export async function handleProxyRemove(job: Job): Promise<{ removed: boolean }> {
  const data = proxyRemoveJobDataSchema.parse(job.data);
  const proxy = await getProxy(data.proxyId);
  if (!proxy) return { removed: false };
  if ((await countRoutesServedBy(proxy.id)) > 0) {
    throw new Error('des domaines passent encore par ce proxy : retirez-les d’abord');
  }
  if (data.uninstall && proxy.managed && proxy.hostTargetId) {
    const opened = await openTargetContext(proxy.hostTargetId);
    try {
      await getProxyProvider(proxy.kind).uninstall(proxyContextOf(proxy, opened.ctx), (line) =>
        logger.info({ proxyId: proxy.id }, line),
      );
    } finally {
      await disconnect(opened.session);
    }
  }
  await deleteProxy(proxy.id);
  await logAudit({
    actorId: data.actorId,
    action: 'proxy.removed',
    resourceType: 'target',
    resourceId: proxy.hostTargetId ?? proxy.id,
    after: { proxyId: proxy.id, kind: proxy.kind, uninstalled: data.uninstall && proxy.managed },
    ip: data.ip,
  });
  return { removed: true };
}

/**
 * « Appliquer » : les domaines changés d'une application, posés sur le proxy
 * sans redéploiement. Rien ne tourne sur la cible : ils attendront le prochain
 * déploiement, qui les posera de lui-même.
 */
export async function handleProxyApply(job: Job): Promise<{
  skipped: string | null;
  url: string | null;
  problems: string[];
}> {
  const data = proxyApplyJobDataSchema.parse(job.data);
  const [live] = await listLiveDeployments({
    applicationId: data.applicationId,
    targetId: data.targetId,
  });
  if (!live?.inService) {
    return { skipped: 'l’application ne tourne pas sur cette cible', url: null, problems: [] };
  }
  const opened = await openDeploymentContext(live.inService.id);
  try {
    return await applyCoupleRoutes({
      applicationId: data.applicationId,
      targetId: data.targetId,
      driver: getDriver(opened.deployment.runtime),
      ctx: opened.ctx,
      publishedPort: opened.deployment.publishedPort,
      onLog: (line) => logger.info({ applicationId: data.applicationId }, line),
    });
  } finally {
    await disconnect(opened.session);
  }
}

/**
 * La sonde périodique : chaque domaine, à travers son proxy, depuis sa
 * machine. Une session par machine, pas par domaine.
 */
export async function handleRoutesCheck(job: Job): Promise<{ checked: number; failing: number }> {
  const scope = routesCheckJobDataSchema.parse(job.data ?? {});
  const couples = (await listRoutedCouples()).filter(
    (couple) =>
      (!scope.applicationId || couple.applicationId === scope.applicationId) &&
      (!scope.targetId || couple.targetId === scope.targetId),
  );
  // On sonde depuis la machine du proxy — celle de la cible, ou celle du proxy
  // central qui la sert : une session par machine de proxy.
  const byHost = new Map<
    string,
    Array<{ applicationId: string; targetId: string; serving: ServingProxy }>
  >();
  for (const couple of couples) {
    const serving = await resolveServingProxy(couple.targetId);
    const host = serving?.proxy.hostTargetId;
    if (!serving || !host) continue;
    byHost.set(host, [...(byHost.get(host) ?? []), { ...couple, serving }]);
  }
  let checked = 0;
  let failing = 0;
  for (const [hostTargetId, entries] of byHost) {
    let opened: Awaited<ReturnType<typeof openTargetContext>> | null = null;
    try {
      opened = await openTargetContext(hostTargetId);
      for (const { applicationId, targetId, serving } of entries) {
        const [live] = await listLiveDeployments({ applicationId, targetId });
        if (!live?.inService || live.inService.stoppedAt) continue;
        const result = await probeCoupleRoutes({
          applicationId,
          targetId,
          spec: parseAppSpec(live.inService.appSpec),
          serving,
          proxyHost: opened.ctx,
        });
        checked += result.checked;
        failing += result.failing;
      }
    } catch (error) {
      // Une machine injoignable n'arrête pas la tournée : les autres sont sondées.
      logger.warn(
        { hostTargetId, err: error },
        'sonde des domaines impossible depuis cette machine',
      );
    } finally {
      if (opened) await disconnect(opened.session);
    }
  }
  return { checked, failing };
}

/**
 * Éprouver la liaison d'une machine au proxy d'une autre, sans rien y changer :
 *   - de la machine du proxy, la route vers l'adresse donnée — elle dit par
 *     quelle adresse le proxy arrive (`src`), la seule à qui ouvrir le port ;
 *   - un ping, pour dire si elle répond — un avertissement s'il échoue, un
 *     pare-feu peut le bloquer sans bloquer le reste ;
 *   - de la machine servie, si l'adresse est la sienne : on pourra alors y
 *     publier le port, et nulle part ailleurs.
 */
export async function handleProxyLinkCheck(job: Job): Promise<{
  ok: boolean;
  sourceAddress: string | null;
  reachable: boolean | null;
  bindable: boolean;
  error: string | null;
}> {
  const data = proxyLinkCheckJobDataSchema.parse(job.data);
  const link = await getTargetLink(data.targetId);
  if (!link) throw new Error('aucune liaison pour cette cible');
  const proxy = await getProxy(link.proxyId);
  if (!proxy?.hostTargetId) throw new Error('le proxy de cette liaison a disparu');

  let sourceAddress: string | null = null;
  let reachable: boolean | null = null;
  let bindable = false;
  let error: string | null = null;
  const quoted = `'${link.address.replaceAll("'", '')}'`;
  const host = await openTargetContext(proxy.hostTargetId);
  try {
    const route = await exec(
      host.session,
      `(ip route get ${quoted} || ip -6 route get ${quoted}) 2>/dev/null | head -1; ` +
        `ping -c 1 -W 2 ${quoted} >/dev/null 2>&1 && echo ping=ok || echo ping=ko`,
      { timeout: 30_000 },
    );
    sourceAddress = /\bsrc\s+(\S+)/.exec(route.stdout)?.[1] ?? null;
    reachable = /ping=ok/.test(route.stdout) ? true : /ping=ko/.test(route.stdout) ? false : null;
    if (!sourceAddress) {
      error = `la machine du proxy ne sait pas joindre ${link.address} : aucune route`;
    }
  } finally {
    await disconnect(host.session);
  }
  if (!error) {
    const served = await openTargetContext(data.targetId);
    try {
      const addresses = await exec(
        served.session,
        "ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1",
        { timeout: 30_000 },
      );
      bindable = addresses.stdout
        .split('\n')
        .map((line) => line.trim())
        .includes(link.address);
    } finally {
      await disconnect(served.session);
    }
  }
  await setTargetLinkCheck(data.targetId, {
    status: error ? 'failed' : 'ok',
    sourceAddress,
    bindable,
    error,
  });
  return { ok: !error, sourceAddress, reachable, bindable, error };
}
