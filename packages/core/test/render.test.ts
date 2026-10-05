import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { parseAppSpec, storedSecretNames, type AppSpec } from '../src/spec/index.js';
import {
  networkName,
  projectName,
  renderComposeFile,
  renderFiles,
  serializeComposeFile,
} from '../src/drivers/docker/render.js';
import { UnresolvedSecretError } from '../src/drivers/secrets.js';

/**
 * Placeholder values for every secret declared by a fixture. Since the render
 * fails on an unresolved secret, a test that provides none would test the
 * failure and not the render.
 */
function stubSecrets(spec: AppSpec): Record<string, string> {
  const values: Record<string, string> = {};
  // The roots only: an alias has no value to provide, it reuses another's — it is
  // `completeSecretValues()` that gives it.
  for (const name of storedSecretNames(spec)) values[name] = `valeur-${name.toLowerCase()}`;
  return values;
}

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'spec',
  '__fixtures__',
);

function fixture(name: string): AppSpec {
  return parseAppSpec(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
}

const workdir = mkdtempSync(path.join(tmpdir(), 'tp-render-'));
after(() => rmSync(workdir, { recursive: true, force: true }));

let dockerAvailable = true;
try {
  execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
  dockerAvailable = false;
}

/**
 * Has the render validated by Docker itself. It is the only proof that counts:
 * a syntactically correct YAML can still be an invalid Compose file.
 */
function validateWithDockerCompose(name: string, spec: AppSpec, publishedPort: number | null) {
  const dir = path.join(workdir, name);
  mkdirSync(dir, { recursive: true });

  for (const file of renderFiles({
    spec,
    appSlug: spec.name,
    publishedPort,
    secretValues: stubSecrets(spec),
  })) {
    writeFileSync(path.join(dir, file.path), file.content);
  }

  // The build contexts must exist for `config` to resolve them.
  for (const service of spec.services) {
    if (service.source.type !== 'dockerfile') continue;
    const context = path.join(dir, service.source.context);
    mkdirSync(path.dirname(path.join(context, service.source.dockerfile)), { recursive: true });
    writeFileSync(path.join(context, service.source.dockerfile), 'FROM scratch\n');
  }

  return execFileSync('docker', ['compose', '-f', path.join(dir, 'compose.yml'), 'config'], {
    encoding: 'utf8',
    cwd: dir,
  });
}

describe('render() — AppSpec to Compose', () => {
  describe('simple.json', () => {
    const spec = fixture('simple');
    const file = renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30001 });

    it('names the app-{slug} project and its network', () => {
      assert.equal(file.name, 'app-demo-api');
      assert.equal(projectName('demo-api'), 'app-demo-api');
      assert.equal(file.networks?.appnet?.name, networkName('demo-api'));
      assert.equal(file.networks?.appnet?.driver, 'bridge');
    });

    it('publishes the exposed service’s port', () => {
      assert.deepEqual(file.services.api?.ports, ['30001:80']);
      assert.deepEqual(file.services.api?.expose, ['80']);
    });

    it('decides the restart policy, absent from the spec', () => {
      assert.equal(file.services.api?.restart, 'unless-stopped');
    });

    it('translates resources into Compose limits', () => {
      assert.equal(file.services.api?.deploy?.resources?.limits?.cpus, '0.500');
      assert.equal(file.services.api?.deploy?.resources?.limits?.memory, '256M');
    });

    it('produces a compose.yml validated by Docker', { skip: !dockerAvailable }, () => {
      const output = validateWithDockerCompose('simple', spec, 30001);
      const parsed = parseYaml(output) as { name?: string; services?: Record<string, unknown> };
      assert.equal(parsed.name, 'app-demo-api');
      assert.ok(parsed.services?.api);
    });
  });

  describe('fullstack.json', () => {
    const spec = fixture('fullstack');
    const file = renderComposeFile({ spec, appSlug: spec.name, publishedPort: null });

    it('puts the services in dependency order', () => {
      assert.deepEqual(Object.keys(file.services), ['postgres', 'api', 'front']);
    });

    it('translates dependsOn into a conditional depends_on', () => {
      assert.deepEqual(file.services.api?.depends_on, {
        postgres: { condition: 'service_healthy' },
      });
      assert.deepEqual(file.services.front?.depends_on, {
        api: { condition: 'service_healthy' },
      });
    });

    it('builds the Dockerfile services and tags their image', () => {
      assert.deepEqual(file.services.api?.build, {
        context: './api',
        dockerfile: 'docker/Dockerfile',
      });
      assert.equal(file.services.api?.image, 'app-boutique/api:2.3.1');
      assert.equal(file.services.postgres?.image, 'postgres:16-alpine', 'image pulled as is');
      assert.equal(file.services.postgres?.build, undefined);
    });

    it('prefixes named volumes to avoid collisions', () => {
      assert.deepEqual(file.services.postgres?.volumes, [
        'app-boutique-postgres-data:/var/lib/postgresql/data',
      ]);
      assert.ok(file.volumes?.['app-boutique-postgres-data']);
      assert.ok(file.volumes?.['app-boutique-api-uploads']);
    });

    it('never writes a secret’s value into compose.yml', () => {
      const yaml = serializeComposeFile(file);
      for (const secret of ['DATABASE_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD']) {
        assert.ok(!yaml.includes(`${secret}:`), `${secret} must not be a key of the compose file`);
      }
      assert.deepEqual(file.services.api?.env_file, ['./.env']);
      assert.equal(file.services.front?.env_file, undefined, 'front declares no secret');
    });

    it('generates a 0600 .env with the declared names', () => {
      const files = renderFiles({
        spec,
        appSlug: spec.name,
        publishedPort: null,
        secretValues: stubSecrets(spec),
      });
      const env = files.find((f) => f.path === '.env');
      assert.ok(env);
      assert.equal(env.mode, 0o600);
      for (const secret of ['DATABASE_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD']) {
        assert.match(env.content, new RegExp(`^${secret}=`, 'm'));
      }
    });

    it('publishes no port when the exposed service has several replicas', () => {
      assert.equal(file.services.front?.ports, undefined);
      assert.equal(file.services.front?.deploy?.replicas, 2);
    });

    it('probes the exposed service over HTTP, the others over TCP', () => {
      const front = file.services.front?.healthcheck?.test.join(' ') ?? '';
      assert.match(front, /wget --spider .*\/healthz/);
      const postgres = file.services.postgres?.healthcheck?.test.join(' ') ?? '';
      assert.match(postgres, /nc -z -w \d+ 127\.0\.0\.1 5432/);
      // Neither `wget` nor `curl`: an HTTP fallback on a service that does not speak
      // HTTP never succeeds, and hid the real failure.
      assert.doesNotMatch(postgres, /wget|curl/);
    });

    it('probes over HTTP with wget or curl, and over TCP only if the image has neither', () => {
      // `freshrss/freshrss` ships neither wget nor curl: without a fallback, the
      // container stayed "unhealthy" and the deployment failed.
      const front = file.services.front?.healthcheck?.test.join(' ') ?? '';
      assert.match(front, /^CMD-SHELL if command -v wget .* then wget --spider /);
      assert.match(front, /elif command -v curl .* then curl -fsS /);
      assert.match(
        front,
        /else nc -z -w \d+ 127\.0\.0\.1 \d+ .*\/dev\/tcp\/127\.0\.0\.1\/\d+'.*; fi$/,
      );
    });

    it('probes over TCP without depending on `nc`, absent from Debian images', () => {
      // `postgres:16` and `mariadb:11` ship neither `nc`, nor `wget`, nor `curl` —
      // only `bash`. Without this fallback, their probe failed forever and the
      // application service's `depends_on: service_healthy` blocked with it.
      const postgres = file.services.postgres?.healthcheck?.test.join(' ') ?? '';
      assert.match(postgres, /bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/5432'/);
    });

    it('refuses to render a declared secret without a resolved value, naming it', () => {
      assert.throws(
        () => renderFiles({ spec, appSlug: spec.name, publishedPort: null }),
        (error: unknown) => {
          assert.ok(error instanceof UnresolvedSecretError);
          assert.deepEqual(
            [...error.names].sort(),
            ['DATABASE_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD'],
          );
          assert.match(error.message, /POSTGRES_PASSWORD/);
          return true;
        },
      );
    });

    it('accepts a deliberately empty secret — absent is not empty', () => {
      const values = { ...stubSecrets(spec), JWT_SECRET: '' };
      const files = renderFiles({
        spec,
        appSlug: spec.name,
        publishedPort: null,
        secretValues: values,
      });
      const env = files.find((f) => f.path === '.env');
      assert.ok(env);
      assert.match(env.content, /^JWT_SECRET=$/m);
    });

    it('produces a compose.yml validated by Docker', { skip: !dockerAvailable }, () => {
      const output = validateWithDockerCompose('fullstack', spec, null);
      const parsed = parseYaml(output) as { services?: Record<string, unknown> };
      assert.deepEqual(Object.keys(parsed.services ?? {}).sort(), ['api', 'front', 'postgres']);
    });
  });

  describe('serialization', () => {
    it('escapes what string concatenation would break', () => {
      const spec = parseAppSpec({
        name: 'echappement',
        version: '1.0.0',
        services: [
          {
            name: 'web',
            source: { type: 'image', ref: 'nginx:alpine' },
            port: 80,
            exposed: true,
            env: {
              QUOTED: 'valeur avec "guillemets" et \'apostrophes\'',
              MULTILINE: 'première ligne\nseconde ligne',
              YAML_TRAP: '*ancre: &pas-une-ancre',
              COLON: 'clé: valeur',
            },
          },
        ],
      });

      const yaml = serializeComposeFile(renderComposeFile({ spec, appSlug: 'echappement', publishedPort: 30002 }));
      const parsed = parseYaml(yaml) as {
        services: { web: { environment: Record<string, string> } };
      };

      assert.equal(parsed.services.web.environment.QUOTED, 'valeur avec "guillemets" et \'apostrophes\'');
      assert.equal(parsed.services.web.environment.MULTILINE, 'première ligne\nseconde ligne');
      assert.equal(parsed.services.web.environment.YAML_TRAP, '*ancre: &pas-une-ancre');
      assert.equal(parsed.services.web.environment.COLON, 'clé: valeur');
    });

    it('stays deterministic', () => {
      const spec = fixture('fullstack');
      const once = serializeComposeFile(renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30003 }));
      const twice = serializeComposeFile(renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30003 }));
      assert.equal(once, twice);
    });
  });
});

/**
 * Security context.
 *
 * Each case freezes a decision measured on the test target, not an intention:
 * what is hardened is because we saw the image start with it, and what is not is
 * because we saw the image die without it.
 */
describe('security context', () => {
  const fullstack = fixture('fullstack');
  const file = renderComposeFile({
    spec: fullstack,
    appSlug: fullstack.name,
    publishedPort: null,
  });

  // `front`   : our image, no volume    → identity imposed
  // `api`     : our image, one volume   → identity left to the image
  // `postgres`: third-party image       → nothing imposed at all
  const own = file.services.front;
  const ownWithVolume = file.services.api;
  const thirdParty = file.services.postgres;

  it('forbids privilege escalation everywhere — Docker does not do it alone', () => {
    // Without the option, `NoNewPrivs` is 0 in a Docker container: it is the only
    // one of these fields not already covered by a runtime default.
    for (const service of [own, ownWithVolume, thirdParty]) {
      assert.deepEqual(service?.security_opt, ['no-new-privileges:true']);
    }
  });

  it('starts from zero on capabilities, on every service', () => {
    for (const service of [own, ownWithVolume, thirdParty]) {
      assert.deepEqual(service?.cap_drop, ['ALL']);
    }
  });

  it('gives no capability back to an image whose uid we pin', () => {
    // It never starts as root: it has nothing to prepare before dropping
    // privileges, so nothing to ask for.
    assert.equal(own?.cap_add, undefined);
  });

  it('gives five capabilities back to any image that keeps its identity', () => {
    // Measured: `cap_drop: ALL` alone kills `nginx` on chown(/var/cache/nginx) and
    // `postgres` on chmod(/var/run/postgresql). Five, and not one more —
    // `NET_BIND_SERVICE` notably, useless since Docker sets
    // `net.ipv4.ip_unprivileged_port_start=0` in the container.
    for (const service of [ownWithVolume, thirdParty]) {
      assert.deepEqual(service?.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);
    }
  });

  it('imposes the unprivileged uid on our images without a volume', () => {
    assert.equal(own?.user, '1000:1000');
  });

  it('does not impose it on our images that declare a volume — Compose has no fsGroup', () => {
    // A new named volume is `root:root 0755` and stays so: a container as uid 1000
    // would start then fail at the first write. The image's entry point does what
    // `fsGroup` would do on the K3s side — with the five capabilities just given
    // back to it.
    assert.equal(ownWithVolume?.user, undefined);
  });

  it('never imposes a uid on a third-party image', () => {
    assert.equal(thirdParty?.user, undefined);
  });

  it('makes the root read-only on our images only', () => {
    // Including the one carrying a volume: the volume stays writable.
    assert.equal(own?.read_only, true);
    assert.equal(ownWithVolume?.read_only, true);
    // Measured: a read-only `nginx` dies on
    // `mkdir() "/var/cache/nginx/client_temp" failed (30: Read-only file system)`.
    assert.equal(thirdParty?.read_only, undefined);
  });

  it('opens a writable and executable /tmp where the root is locked', () => {
    // `exec` is explicit: Docker's tmpfs is `noexec` by default, the `emptyDir` the
    // K3s render mounts at the same place is not. Without it, the same AppSpec
    // would behave differently on the two runtimes.
    assert.deepEqual(own?.tmpfs, ['/tmp:exec,mode=1777']);
    assert.deepEqual(ownWithVolume?.tmpfs, ['/tmp:exec,mode=1777']);
    assert.equal(thirdParty?.tmpfs, undefined, 'no locked root, no scratch');
  });

  it('declares no seccomp profile: Docker’s is already applied', () => {
    // `docker info` → `name=seccomp,profile=builtin`, and `/proc/1/status` returns
    // `Seccomp: 2` without asking anything. It is the K3s render's `RuntimeDefault`
    // under another name; the only thing Compose could declare here
    // (`seccomp:unconfined`) would weaken it.
    for (const service of [own, ownWithVolume, thirdParty]) {
      for (const option of service?.security_opt ?? []) {
        assert.doesNotMatch(option, /seccomp/);
      }
    }
  });

  it('does not mount a scratch when the spec already occupies /tmp', () => {
    const spec = parseAppSpec({
      name: 'scratch-occupe',
      version: '1.0.0',
      services: [
        {
          name: 'app',
          source: { type: 'dockerfile', context: './app', dockerfile: 'Dockerfile' },
          port: 8080,
          exposed: true,
          volumes: [{ name: 'travail', mountPath: '/tmp' }],
        },
      ],
    });
    const rendered = renderComposeFile({ spec, appSlug: spec.name, publishedPort: null });
    assert.equal(rendered.services.app?.read_only, true);
    assert.equal(rendered.services.app?.tmpfs, undefined);
    // A volume is declared: the uid stays the image's.
    assert.equal(rendered.services.app?.user, undefined);
  });

  it('produces a compose.yml Docker accepts', { skip: !dockerAvailable }, () => {
    const output = validateWithDockerCompose('securite', fullstack, null);
    const parsed = parseYaml(output) as {
      services: Record<string, Record<string, unknown>>;
    };
    // It is `docker compose config` speaking here: the fields survive the schema's
    // normalization, `tmpfs` with its options included.
    assert.equal(parsed.services.front?.user, '1000:1000');
    assert.equal(parsed.services.front?.read_only, true);
    assert.deepEqual(parsed.services.front?.tmpfs, ['/tmp:exec,mode=1777']);
    assert.deepEqual(parsed.services.postgres?.cap_add, [
      'CHOWN',
      'DAC_OVERRIDE',
      'FOWNER',
      'SETGID',
      'SETUID',
    ]);
    assert.deepEqual(parsed.services.postgres?.security_opt, ['no-new-privileges:true']);
  });
});
