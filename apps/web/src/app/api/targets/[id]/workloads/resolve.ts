import 'server-only';
import { decodeWorkloadRef, type Workload, type WorkloadRef } from '@pupitre/core';
import { getTarget } from '@pupitre/db';
import { targets as messages } from '@/i18n/messages/targets';
import { HttpError, NotFoundError, msg } from '@/lib/errors';
import { fetchWorkloads, findWorkload } from './inventory';

/**
 * Ce que toutes les routes d'une charge vérifient avant d'enfiler quoi que ce
 * soit : la cible existe, la référence se lit, la charge tourne bien sur
 * cette cible — relue à l'inventaire, pas crue sur parole.
 */
export async function resolveWorkload(
  targetId: string,
  encodedRef: string,
  auth: { userId: string; ip: string | null },
): Promise<{ target: { id: string; name: string }; ref: WorkloadRef; workload: Workload }> {
  const target = await getTarget(targetId);
  if (!target) throw new NotFoundError(msg(messages, 'error.notFound', { id: targetId }));

  const ref = decodeWorkloadRef(encodedRef);
  if (!ref) {
    throw new HttpError(
      422,
      'invalid_workload_ref',
      msg(messages, 'error.badWorkloadRef', { ref: encodedRef }),
    );
  }

  const list = await fetchWorkloads(targetId, auth.userId, auth.ip);
  const workload = findWorkload(list, encodedRef);
  if (!workload) {
    throw new NotFoundError(
      msg(messages, 'error.workloadNotFound', { ref: encodedRef, name: target.name }),
    );
  }
  return { target: { id: target.id, name: target.name }, ref, workload };
}
