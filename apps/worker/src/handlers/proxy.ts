import {
  describeProxy,
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
  implementedProxyKinds,
  reachSource,
  type ProxyCheck,
  type ProxyDetection,
  type ProxyInstallOption,
} from '@pupitre/core/proxy';
import { disconnect } from '@pupitre/core/ssh';
import {
  countRoutesServedBy,
  deleteProxy,
  getProxy,
  listLiveDeployments,
  listRoutedCouples,
  logAudit,
  resolveServingProxy,
  setProxyStatus,
  type ServingProxy,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { openDeploymentContext } from '../deploy/context.js';
import { openTargetContext } from '../deploy/target-context.js';
import { logger } from '../logger.js';
import { verifyTargetLink } from '../proxy/link.js';
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
    // Chaque proxy que Pupitre sait piloter regarde à son tour : ce qui est
    // déjà là, et ce qu'il pourrait installer.
    const detections: ProxyDetection[] = [];
    const installOptions: ProxyInstallOption[] = [];
    for (const kind of implementedProxyKinds()) {
      const provider = getProxyProvider(kind);
      detections.push(...(await provider.detect(opened.ctx, (line) => lines.push(line))));
      installOptions.push(...(await provider.installOptions(opened.ctx)));
    }
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
      // Le nom tel que la configuration installée le dit : « Traefik du cluster »…
      name: describeProxy(proxy.kind, config).split(' · ')[0] ?? proxy.name,
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
 * « Tester la liaison » : la machine du proxy ouvre-t-elle vraiment une
 * connexion vers celle-ci, sur un port de la plage des applications ? Voir
 * `checkReach()` — le résultat est retenu sur la liaison.
 */
export async function handleProxyLinkCheck(job: Job): Promise<{
  ok: boolean | null;
  port: number | null;
  sourceAddress: string | null;
  bindable: boolean;
  detail: string;
}> {
  const data = proxyLinkCheckJobDataSchema.parse(job.data);
  const checked = await verifyTargetLink({ targetId: data.targetId });
  if (!checked) throw new Error('aucune liaison pour cette cible');
  const { result } = checked;
  return {
    ok: result.ok,
    port: result.port,
    sourceAddress: reachSource(result),
    bindable: result.bindable,
    detail: result.detail,
  };
}
