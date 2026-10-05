import { intersectPortRanges, type PortRange } from '@pupitre/core';
import type { LogSink, TargetContext } from '@pupitre/core/drivers';
import { checkReach, reachSource, type ReachResult } from '@pupitre/core/proxy';
import { disconnect } from '@pupitre/core/ssh';
import {
  getProxy,
  getTargetLink,
  getTargetPortReport,
  listRoutes,
  resolveServingProxy,
  setTargetLinkCheck,
} from '@pupitre/db';
import { openTargetContext } from '../deploy/target-context.js';
import { env } from '../env.js';
import { instanceLanguage } from '../language.js';
import { workerSay } from '../messages.js';
import { openProxy } from './connect.js';

/**
 * The central proxy, tested: does the proxy's machine really open a connection
 * to the one it serves? The link's test ("Test the link", and at its creation)
 * and a deployment's preflight go through here, and keep the result on the link
 * — the screen shows it, `exposureFor()` draws from it the address to open the
 * port to.
 */

export type LinkCheck = {
  result: ReachResult;
  /** The proxy's name, to say it: its machine, or the remote connection. */
  proxyHostName: string;
};

export async function verifyTargetLink(input: {
  targetId: string;
  /** A session already open to the served machine — the deployment's. */
  served?: TargetContext;
  /** The range where the application will be published; otherwise, the target's. */
  portRange?: PortRange;
  onLog?: LogSink;
}): Promise<LinkCheck | null> {
  const link = await getTargetLink(input.targetId);
  if (!link) return null;
  const proxy = await getProxy(link.proxyId);
  if (!proxy) throw new Error(workerSay(await instanceLanguage())('link.gone'));

  // A free port of the range, outside the panel's reservations: where the driver
  // will publish, hence where a firewall would block the application.
  const report = await getTargetPortReport(input.targetId);
  if (!report) {
    throw new Error(workerSay(await instanceLanguage())('notFound.target', { id: input.targetId }));
  }
  const portRange =
    input.portRange ?? intersectPortRanges(report.range, env.DRIVER_PORT_RANGE) ?? report.range;
  const reserved = new Set(report.allocations.map((allocation) => allocation.port));

  const opened = await openProxy(proxy);
  const served = input.served ? null : await openTargetContext(input.targetId);
  try {
    const result = await checkReach({
      origin: opened.reachOrigin(input.onLog),
      served: input.served ?? served!.ctx,
      address: link.address,
      portRange,
      reserved,
      ...(input.onLog ? { onLog: input.onLog } : {}),
    });
    // Could not test the connection, or did not know where the proxy arrives from:
    // the link stays usable, the warning is kept in its place.
    await setTargetLinkCheck(input.targetId, {
      status: result.ok === false ? 'failed' : 'ok',
      sourceAddress: reachSource(result),
      bindable: result.bindable,
      error: result.ok === true && reachSource(result) !== null ? null : result.detail,
    });
    return { result, proxyHostName: opened.name };
  } finally {
    await opened.close();
    if (served) await disconnect(served.session);
  }
}

/**
 * At the preflight of a deployment served by another machine's proxy — and only
 * if it has domains —, test the connection **before** building anything. A
 * machine the proxy does not reach makes the deployment fail right away, saying
 * what to open, rather than after a build through a silent domain.
 *
 * `true`: tested (the link is up to date, the exposure must be read again);
 * `false`: not applicable.
 */
export async function verifyLinkBeforeDeploy(input: {
  applicationId: string;
  targetId: string;
  served: TargetContext;
  portRange: PortRange;
  onLog: LogSink;
}): Promise<boolean> {
  const serving = await resolveServingProxy(input.targetId);
  if (!serving?.link) return false;
  const routes = await listRoutes({ applicationId: input.applicationId, targetId: input.targetId });
  if (routes.length === 0) return false;

  const checked = await verifyTargetLink({
    targetId: input.targetId,
    served: input.served,
    portRange: input.portRange,
    onLog: input.onLog,
  });
  if (!checked) return false;
  const { result, proxyHostName } = checked;
  const say = workerSay(input.served.language);
  if (result.ok === false) {
    throw new Error(
      say('link.unreachable', {
        proxy: proxyHostName,
        detail: result.detail,
        address: result.address,
        min: input.portRange.min,
        max: input.portRange.max,
      }),
    );
  }
  const source = reachSource(result);
  input.onLog(
    result.ok
      ? say('link.ok', { proxy: proxyHostName, detail: result.detail }) +
          (source ? say('link.from', { source }) : '')
      : `⚠ ${result.detail}`,
  );
  return true;
}
