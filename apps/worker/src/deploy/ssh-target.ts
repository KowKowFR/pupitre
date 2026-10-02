import { decrypt } from '@pupitre/core';
import type { SshTarget } from '@pupitre/core/ssh';
import {
  logAudit,
  recordTargetHostKey,
  setTargetHostKeyPending,
  type PublicTarget,
} from '@pupitre/db';

/**
 * La connexion SSH d'une cible, telle que la base la décrit : identifiants
 * déchiffrés, et clé d'hôte attendue.
 *
 * Le seul endroit du worker qui en fabrique une — ouverture de session,
 * déploiement, preflight, relevé de métriques passent tous par ici —, pour
 * qu'aucune connexion à une cible ne parte sans vérifier sa clé.
 *
 *   - jamais jointe : la clé présentée est retenue, et c'est écrit au journal ;
 *   - une autre clé que la retenue : la connexion est refusée (`SshHostKeyError`)
 *     et la clé présentée est notée, en attente d'une décision sur la page de
 *     la cible. Le journal — donc une notification — ne le dit qu'une fois par
 *     clé inattendue, pas à chaque relevé de métriques qui suit.
 *
 * Le credential déchiffré ne quitte pas l'objet rendu, qui n'entre dans aucun log.
 */
export function sshTargetOf(record: {
  target: PublicTarget;
  encryptedCredential: string;
}): SshTarget {
  const { target } = record;
  const secret = decrypt(record.encryptedCredential);
  return {
    host: target.host,
    port: target.port,
    username: target.sshUser,
    sudoMethod: target.sudoMethod,
    credentials:
      target.authMethod === 'key'
        ? { authMethod: 'key', privateKey: secret }
        : { authMethod: 'password', password: secret },
    hostKey: {
      expected: target.hostKeyFingerprint,
      onFirstSeen: async (fingerprint) => {
        if (!(await recordTargetHostKey(target.id, fingerprint))) return;
        await logAudit({
          action: 'target.host_key.recorded',
          resourceType: 'target',
          resourceId: target.id,
          after: { name: target.name, host: target.host, fingerprint },
        });
      },
      onMismatch: async (presented) => {
        if (!(await setTargetHostKeyPending(target.id, presented))) return;
        await logAudit({
          action: 'target.host_key.mismatch',
          resourceType: 'target',
          resourceId: target.id,
          before: { fingerprint: target.hostKeyFingerprint },
          after: { name: target.name, host: target.host, presented },
        });
      },
    },
  };
}
