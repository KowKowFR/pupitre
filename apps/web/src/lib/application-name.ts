import 'server-only';
import { ApplicationNameError, assertApplicationNameFree, type NameHolder } from '@pupitre/db';
import { applications as messages } from '@/i18n/messages/applications';
import { ConflictError, msg } from './errors';

/**
 * An application's name is its project on the machines — `app-{name}` —: two
 * applications the machines would know under the same name share their
 * containers. The database refuses the gesture (`ApplicationNameError`); this
 * file says why, as a 409 the screen shows as is.
 */

function where(holders: NameHolder[]): string {
  return holders.map((holder) => `${holder.targetName} (v${holder.version})`).join(', ');
}

/** The refusal behind `error`, said; `null` when `error` is something else. */
export function nameConflict(error: unknown): ConflictError | null {
  if (!(error instanceof ApplicationNameError)) return null;
  const first = error.holders[0];
  return new ConflictError(
    error.reason === 'deployed'
      ? msg(messages, 'error.renameDeployed', {
          name: first?.applicationSlug ?? error.wanted,
          targets: where(error.holders),
        })
      : msg(messages, 'error.nameHeld', {
          name: error.wanted,
          application: first?.applicationSlug ?? '?',
          target: first?.targetName ?? '?',
        }),
  );
}

/** A new application may not take a name another one's deployment still holds. */
export async function assertNameFree(name: string): Promise<void> {
  try {
    await assertApplicationNameFree(name, null);
  } catch (error) {
    throw nameConflict(error) ?? error;
  }
}
