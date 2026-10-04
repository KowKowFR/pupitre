import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DockerComposeDriver,
  DriverError,
  K3sDriver,
  UnhealthyReleaseError,
  type DriverContext,
} from '../src/drivers/index.js';
import { parseAppSpec } from '../src/spec/index.js';
import type { SshSession } from '../src/ssh/client.js';

/**
 * A version that takes the previous one's place without becoming healthy must
 * be reported as such: it is what triggers the automatic rollback. Compose
 * replaces the containers before waiting for their health, Kubernetes applies
 * the Deployment before waiting for the rollout — in both cases, the failure
 * happens during `deploy()`, while the old version is already no longer the one
 * the runtime runs.
 */

type Answer = { code: number; stdout?: string; stderr?: string };

/** A session that answers depending on the command; everything else succeeds, silently. */
function fakeSession(rules: Array<[RegExp, Answer]>) {
  const commands: string[] = [];
  const session = {
    id: 'session-test',
    host: 'cible.test',
    language: 'en',
    target: { sudoMethod: 'nopasswd' },
    client: {
      execCommand: async (
        command: string,
        options: { onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void } = {},
      ) => {
        commands.push(command);
        const rule = rules.find(([pattern]) => pattern.test(command));
        const { code, stdout = '', stderr = '' } = rule?.[1] ?? { code: 0 };
        if (stdout) options.onStdout?.(Buffer.from(`${stdout}\n`));
        if (stderr) options.onStderr?.(Buffer.from(`${stderr}\n`));
        return { code, stdout, stderr, signal: null };
      },
    },
  } as unknown as SshSession;
  return { session, commands };
}

const spec = parseAppSpec({
  name: 'site',
  version: '1.0.1',
  services: [
    {
      name: 'web',
      source: { type: 'image', ref: 'nginx:1.27' },
      port: 80,
      exposed: true,
      healthcheck: { path: '/absent', intervalSec: 1, timeoutSec: 1, retries: 2 },
    },
  ],
});

function contextFor(session: SshSession): DriverContext {
  return {
    spec,
    target: { id: 'cible', name: 'cible-1', host: 'cible.test', rootPath: '/opt/pupitre' },
    deployment: { id: 'deploiement-2', version: '1.0.1', sequence: 2 },
    previousDeployment: { id: 'deploiement-1', version: '1.0.0', sequence: 1 },
    sshSession: session,
    language: 'en',
    appSlug: 'site',
    applicationId: 'application',
  };
}

const RELEASE = '/opt/pupitre/apps/site/1.0.1-r2';

describe('Docker — an unhealthy version after `up --wait`', () => {
  it('replaced the old one: UnhealthyReleaseError, diagnosis captured', async () => {
    const { session, commands } = fakeSession([
      [/up -d --remove-orphans --wait/, { code: 1, stderr: 'Container app-site-web-1 Recreate' }],
      [/^docker ps -aq /, { code: 0, stdout: 'c0ffee' }],
      [
        /ps -a --format json/,
        { code: 0, stdout: '[{"Service":"web","State":"running","Health":"unhealthy"}]' },
      ],
      [/ps -a$/, { code: 0, stdout: 'app-site-web-1  Up 9 seconds (unhealthy)' }],
      [/logs --no-color/, { code: 0, stdout: '"GET /absent HTTP/1.1" 404' }],
    ]);

    await assert.rejects(
      new DockerComposeDriver().deploy(contextFor(session), () => {}),
      (error) => {
        assert.ok(error instanceof UnhealthyReleaseError);
        assert.equal(error.step, 'up');
        assert.match(
          error.message,
          /replaced the old one without becoming healthy — web \(unhealthy\)/,
        );
        assert.match(error.diagnostics ?? '', /GET \/absent HTTP\/1\.1" 404/);
        return true;
      },
    );

    // The proof of replacement: a container of the project carrying THIS release.
    const probe = commands.find((command) => command.startsWith('docker ps -aq '));
    assert.ok(probe?.includes(`label=com.docker.compose.project=app-site`));
    assert.ok(probe?.includes(`label=com.docker.compose.project.working_dir=${RELEASE}`));
    // Nothing marks the release as current: `current` still designates the old one.
    assert.ok(!commands.some((command) => command.startsWith('ln -sfn')));
  });

  it('replaced nothing: `up`’s error stays its own', async () => {
    const { session } = fakeSession([
      [/up -d --remove-orphans --wait/, { code: 1, stderr: 'no such image: nginx:1.27' }],
      [/^docker ps -aq /, { code: 0, stdout: '' }],
    ]);

    await assert.rejects(
      new DockerComposeDriver().deploy(contextFor(session), () => {}),
      (error) => {
        assert.ok(error instanceof DriverError);
        assert.ok(!(error instanceof UnhealthyReleaseError));
        assert.match(error.message, /no such image/);
        return true;
      },
    );
  });
});

describe('K3s — a rollout that does not complete', () => {
  it('the Deployment already carries the new version: UnhealthyReleaseError', async () => {
    const { session, commands } = fakeSession([
      [
        /rollout status deployment\/web/,
        { code: 1, stderr: 'error: deployment "web" exceeded its progress deadline' },
      ],
      [
        /containerStatuses\[\*\]\.ready/,
        { code: 0, stdout: 'web-new-1 Running false\nweb-old-1 Running true' },
      ],
      [/get pods -o wide/, { code: 0, stdout: 'web-new-1  0/1  Running' }],
      [
        /describe pod/,
        { code: 0, stdout: 'Readiness probe failed: HTTP probe failed with statuscode: 404' },
      ],
    ]);

    await assert.rejects(
      new K3sDriver().deploy(contextFor(session), () => {}),
      (error) => {
        assert.ok(error instanceof UnhealthyReleaseError);
        assert.equal(error.step, 'rollout');
        assert.match(error.message, /“web” did not become ready — .*progress deadline/);
        assert.match(error.diagnostics ?? '', /Readiness probe failed/);
        return true;
      },
    );

    // The ready pod — the old one — is not examined: it is the new one at fault.
    const described = commands.filter((command) => command.includes('describe pod'));
    assert.equal(described.length, 1);
    assert.ok(described[0]?.includes('web-new-1'));
  });
});
