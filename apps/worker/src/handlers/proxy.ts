import {
  describeProxy,
  errorMessage,
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
  type ProxyView,
} from '@pupitre/db';
import type { Job } from 'bullmq';
import { openDeploymentContext } from '../deploy/context.js';
import { openTargetContext } from '../deploy/target-context.js';
import { instanceLanguage } from '../language.js';
import { logger } from '../logger.js';
import { workerSay } from '../messages.js';
import { openProxy, proxyContextOf, withProxy } from '../proxy/connect.js';
import { verifyTargetLink } from '../proxy/link.js';
import { applyCoupleRoutes, probeCoupleRoutes } from '../proxy/routes.js';

/**
 * Reverse proxies, worker side: look at what a machine already has, install,
 * test, remove, and set an application's domains without redeploying it. Plus
 * the domains' periodic probe.
 *
 * None of these jobs knows which proxy it drives: it asks the provider of the
 * registered kind, as the pipeline asks the driver.
 */

/** What the machine already carries, and what Pupitre could install there. */
export async function handleProxyDetect(job: Job): Promise<{
  detections: ProxyDetection[];
  installOptions: ProxyInstallOption[];
  lines: string[];
}> {
  const data = proxyDetectJobDataSchema.parse(job.data);
  const opened = await openTargetContext(data.targetId);
  const lines: string[] = [];
  try {
    // Each proxy Pupitre can drive looks in turn: what is already there, and what it
    // could install.
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
  if (!proxy) return null;
  try {
    const check = await withProxy(proxy, undefined, (open) =>
      open.check((line) => logger.info({ proxyId }, line)),
    );
    const failed = check.checks.filter((item) => !item.ok);
    const say = workerSay(await instanceLanguage());
    await setProxyStatus(proxyId, {
      status: check.ok ? 'ok' : 'failed',
      error:
        failed.length > 0
          ? failed
              .map((item) =>
                say('proxy.failedCheck', {
                  label: item.label,
                  detail: item.detail ?? say('proxy.failed'),
                }),
              )
              .join(' · ')
          : null,
      check: check as unknown as Record<string, unknown>,
    });
    return check;
  } catch (error) {
    await setProxyStatus(proxyId, { status: 'failed', error: errorMessage(error), check: null });
    throw error;
  }
}

export async function handleProxyCheck(job: Job): Promise<ProxyCheck | null> {
  const data = proxyCheckJobDataSchema.parse(job.data);
  return runCheck(data.proxyId);
}

/**
 * Install (or configure) the proxy. The connection's row already exists, as
 * `installing`: the screen sees it progress. It ends `ok`, tested, or `failed`,
 * with the reason.
 */
export async function handleProxyInstall(job: Job): Promise<{ ok: boolean; error: string | null }> {
  const data = proxyInstallJobDataSchema.parse(job.data);
  const proxy = await getProxy(data.proxyId);
  if (!proxy) throw new Error(workerSay(await instanceLanguage())('proxy.notFound'));
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
      // The name as the installed configuration says it: "cluster Traefik"…
      name:
        describeProxy(proxy.kind, config, await instanceLanguage()).split(' · ')[0] ?? proxy.name,
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
    const message = errorMessage(error);
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
    throw new Error(workerSay(await instanceLanguage())('proxy.stillServing'));
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
 * "Apply": an application's changed domains, set on the proxy without a
 * redeploy. Nothing runs on the target: they will wait for the next deployment,
 * which will set them by itself.
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
    return {
      skipped: workerSay(await instanceLanguage())('proxy.notRunning'),
      url: null,
      problems: [],
    };
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
 * The periodic probe: each domain, through its proxy. A proxy opened once for
 * all the domains it serves — a session to its machine, or an entry into its
 * API.
 */
export async function handleRoutesCheck(job: Job): Promise<{ checked: number; failing: number }> {
  const scope = routesCheckJobDataSchema.parse(job.data ?? {});
  const couples = (await listRoutedCouples()).filter(
    (couple) =>
      (!scope.applicationId || couple.applicationId === scope.applicationId) &&
      (!scope.targetId || couple.targetId === scope.targetId),
  );
  // The pairs, per proxy serving them — their own, or a link's.
  const byProxy = new Map<
    string,
    { proxy: ProxyView; couples: Array<{ applicationId: string; targetId: string }> }
  >();
  for (const couple of couples) {
    const serving = await resolveServingProxy(couple.targetId);
    if (!serving) continue;
    const entry = byProxy.get(serving.proxy.id) ?? { proxy: serving.proxy, couples: [] };
    entry.couples.push(couple);
    byProxy.set(serving.proxy.id, entry);
  }
  let checked = 0;
  let failing = 0;
  for (const { proxy, couples: served } of byProxy.values()) {
    let open: Awaited<ReturnType<typeof openProxy>> | null = null;
    try {
      open = await openProxy(proxy);
      for (const { applicationId, targetId } of served) {
        const [live] = await listLiveDeployments({ applicationId, targetId });
        if (!live?.inService || live.inService.stoppedAt) continue;
        const result = await probeCoupleRoutes({
          applicationId,
          targetId,
          spec: parseAppSpec(live.inService.appSpec),
          proxy: open,
        });
        checked += result.checked;
        failing += result.failing;
      }
    } catch (error) {
      // An unreachable proxy does not stop the round: the others are probed.
      logger.warn({ proxyId: proxy.id, err: error }, 'domains probe failed through this proxy');
    } finally {
      if (open) await open.close();
    }
  }
  return { checked, failing };
}

/**
 * "Test the link": does the proxy's machine really open a connection to this
 * one, on a port of the applications' range? See `checkReach()` — the result is
 * kept on the link.
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
  if (!checked) throw new Error(workerSay(await instanceLanguage())('link.none'));
  const { result } = checked;
  return {
    ok: result.ok,
    port: result.port,
    sourceAddress: reachSource(result),
    bindable: result.bindable,
    detail: result.detail,
  };
}
