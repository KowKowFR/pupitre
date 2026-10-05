import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { containerControls, getDriver, quoteForShell } from '../src/drivers/index.js';
import { chronological, labelSelector, parseWorkloads } from '../src/drivers/k3s/driver.js';
import {
  managedWorkloadControlRefusal,
  workloadControlJobDataSchema,
  workloadExecJobDataSchema,
  workloadLogsJobDataSchema,
  workloadMessageSchema,
  workloadSchema,
} from '../src/index.js';

/**
 * Managing a target's workloads: what each runtime accepts depending on the
 * state, what a panel workload refuses, and the fact that a command never runs
 * on the host.
 */

const base = {
  targetId: '6d0f4a52-8c5e-4d11-9f5e-1b2c3d4e5f60',
  ref: { runtime: 'docker' as const, id: 'abc123' },
  name: 'web',
  actorId: 'user-1',
  ip: null,
};
const run = '0b6b8f2c-3a55-4d7e-9a0e-2f4d6c8e1a3b';

function kubeList(items: unknown[]): string {
  return JSON.stringify({ items });
}

function deployment(name: string, replicas: number, ready: number, extra: object = {}) {
  return {
    kind: 'Deployment',
    metadata: { name, namespace: 'default', ...extra },
    spec: { replicas, template: { spec: { containers: [{ name, image: 'nginx:1.27' }] } } },
    status: { replicas, readyReplicas: ready },
  };
}

describe('drivers contract — gestures on a workload', () => {
  for (const runtime of ['docker', 'k3s'] as const) {
    it(`${runtime} can start, stop, read the log and exec`, () => {
      const driver = getDriver(runtime);
      for (const method of ['controlWorkload', 'workloadLogs', 'execInWorkload'] as const) {
        assert.equal(typeof driver[method], 'function', `${runtime}: ${method}`);
      }
    });
  }
});

describe('Docker — what a container accepts', () => {
  it('follows its state', () => {
    assert.deepEqual(containerControls('running', false), ['stop', 'restart']);
    assert.deepEqual(containerControls('restarting', false), ['stop', 'restart']);
    assert.deepEqual(containerControls('paused', false), ['stop']);
    assert.deepEqual(containerControls('exited', false), ['start']);
    assert.deepEqual(containerControls('created', false), ['start']);
  });

  it('a panel workload only restarts', () => {
    assert.deepEqual(containerControls('running', true), ['restart']);
    // Stopped, it waits for its application to restart: nothing to do from here.
    assert.deepEqual(containerControls('exited', true), []);
  });
});

describe('K3s — what a resource accepts', () => {
  const byName = (json: string) =>
    new Map(parseWorkloads(json, 'fr').map((workload) => [workload.name, workload]));

  it('according to its kind and its state', () => {
    const workloads = byName(
      kubeList([
        deployment('api', 2, 2),
        deployment('paused', 0, 0),
        {
          kind: 'DaemonSet',
          metadata: { name: 'agent', namespace: 'monitoring' },
          spec: { template: { spec: { containers: [{ name: 'agent', image: 'agent:1' }] } } },
          status: { desiredNumberScheduled: 1, numberReady: 1 },
        },
        {
          kind: 'Pod',
          metadata: { name: 'debug', namespace: 'default' },
          spec: { containers: [{ name: 'debug', image: 'busybox' }] },
          status: { phase: 'Running', containerStatuses: [{ ready: true, image: 'busybox' }] },
        },
      ]),
    );

    assert.deepEqual(workloads.get('api')?.controls, ['stop', 'restart']);
    assert.equal(workloads.get('api')?.exec, true);
    assert.deepEqual(workloads.get('paused')?.controls, ['start']);
    assert.equal(workloads.get('paused')?.exec, false);
    // A DaemonSet runs on each node: it restarts, it does not stop.
    assert.deepEqual(workloads.get('agent')?.controls, ['restart']);
    // A bare pod: nothing would recreate it. But one can still exec in it.
    assert.deepEqual(workloads.get('debug')?.controls, []);
    assert.equal(workloads.get('debug')?.exec, true);
  });

  it('drives nothing in the system namespaces', () => {
    const [coredns] = parseWorkloads(
      kubeList([
        { ...deployment('coredns', 1, 1), metadata: { name: 'coredns', namespace: 'kube-system' } },
      ]),
      'fr',
    );
    assert.deepEqual(coredns?.controls, []);
    assert.equal(coredns?.exec, false);
  });

  it('a panel workload only restarts', () => {
    const labels = { labels: { 'app.kubernetes.io/managed-by': 'pupitre' } };
    const workloads = byName(
      kubeList([deployment('web', 1, 1, labels), deployment('stopped', 0, 0, labels)]),
    );
    assert.deepEqual(workloads.get('web')?.controls, ['restart']);
    assert.deepEqual(workloads.get('stopped')?.controls, []);
  });
});

describe('a command only runs in the workload', () => {
  // The command goes through the machine's shell before `sh -c` in the workload.
  // Quoted, it must arrive intact — a single string, nothing interpreted.
  for (const command of [
    'echo $HOME',
    "psql -c 'select 1'",
    'ls; rm -rf /tmp/x',
    'echo `id` $(whoami) && exit 3',
    'it\'s "quoted" \\ back\\slash',
    'line1\nline2',
  ]) {
    it(`arrives intact: ${JSON.stringify(command)}`, () => {
      const received = execFileSync('sh', ['-c', `printf %s ${quoteForShell(command)}`], {
        encoding: 'utf8',
      });
      assert.equal(received, command);
    });
  }
});

describe('jobs and messages', () => {
  it('bounds a command: empty, too long', () => {
    const ok = workloadExecJobDataSchema.safeParse({
      ...base,
      action: 'exec',
      command: ' ls ',
      run,
    });
    assert.equal(ok.success, true);
    assert.equal(ok.data?.command, 'ls');
    for (const command of ['   ', 'x'.repeat(2001)]) {
      assert.equal(
        workloadExecJobDataSchema.safeParse({ ...base, action: 'exec', command, run }).success,
        false,
      );
    }
  });

  it('bounds the log and only accepts life-cycle gestures', () => {
    assert.equal(workloadLogsJobDataSchema.parse({ ...base, action: 'logs', run }).tail, 300);
    assert.equal(
      workloadLogsJobDataSchema.safeParse({ ...base, action: 'logs', run, tail: 5000 }).success,
      false,
    );
    assert.equal(workloadControlJobDataSchema.safeParse({ ...base, action: 'stop' }).success, true);
    assert.equal(
      workloadControlJobDataSchema.safeParse({ ...base, action: 'remove' }).success,
      false,
    );
  });

  it('marks a run’s output and its exit code', () => {
    const parsed = workloadMessageSchema.parse({
      kind: 'lifecycle',
      payload: {
        ts: new Date().toISOString(),
        ref: 'docker:abc',
        name: 'web',
        action: 'exec',
        status: 'succeeded',
        detail: null,
        run,
        exitCode: 3,
      },
    });
    assert.equal(parsed.kind === 'lifecycle' && parsed.payload.exitCode, 3);
  });

  it('an inventory from before these fields reads back without gestures', () => {
    const legacy = workloadSchema.parse({
      runtime: 'docker',
      id: 'abc',
      name: 'web',
      kind: 'container',
      state: 'running',
      managed: false,
    });
    assert.deepEqual(legacy.controls, []);
    assert.equal(legacy.exec, false);
  });

  it('refuses to stop a panel workload, in both languages', () => {
    for (const lang of ['fr', 'en'] as const) {
      const text = managedWorkloadControlRefusal({ name: 'web' }, lang);
      assert.match(text, /web/);
      assert.doesNotMatch(text, /\{\w+\}/);
    }
  });
});

describe('K3s — the log of every pod', () => {
  it('reads a controller’s selector', () => {
    assert.equal(labelSelector('{"app":"web","tier":"front"}'), 'app=web,tier=front');
    // Nothing readable: we refuse rather than read the whole namespace.
    assert.equal(labelSelector(''), null);
    assert.equal(labelSelector('{}'), null);
    assert.equal(labelSelector('not json'), null);
  });

  it('puts the lines of several pods back in time order', () => {
    const lines = [
      '[pod/web-a/web] 2026-10-01T09:00:00.5Z a1',
      '[pod/web-a/web] 2026-10-01T09:00:02Z a2',
      '  suite de a2',
      '[pod/web-b/web] 2026-10-01T09:00:00.123456789Z b1',
      '[pod/web-b/web] 2026-10-01T09:00:01Z b2',
    ];
    assert.deepEqual(chronological(lines), [
      '[pod/web-b/web] 2026-10-01T09:00:00.123456789Z b1',
      '[pod/web-a/web] 2026-10-01T09:00:00.5Z a1',
      '[pod/web-b/web] 2026-10-01T09:00:01Z b2',
      '[pod/web-a/web] 2026-10-01T09:00:02Z a2',
      '  suite de a2',
    ]);
  });
});
