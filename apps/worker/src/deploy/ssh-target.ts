import { decrypt } from '@pupitre/core';
import type { SshTarget } from '@pupitre/core/ssh';
import {
  logAudit,
  recordTargetHostKey,
  setTargetHostKeyPending,
  type PublicTarget,
} from '@pupitre/db';

/**
 * A target's SSH connection, as the database describes it: credentials
 * decrypted, and expected host key.
 *
 * The only place in the worker that builds one — opening a session, deployment,
 * preflight, metrics reading all go through here —, so that no connection to a
 * target goes out without checking its key.
 *
 *   - never reached: the presented key is recorded, and it is written to the log;
 *   - another key than the recorded one: the connection is refused
 *     (`SshHostKeyError`) and the presented key is noted, waiting for a decision
 *     on the target's page. The log — hence a notification — only says it once
 *     per unexpected key, not at each metrics reading that follows.
 *
 * The decrypted credential does not leave the returned object, which goes into
 * no log.
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
