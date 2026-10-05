import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { parseAppSpec, safeParseAppSpec, type AppSpec } from '../src/spec/index.js';
import {
  DEFAULT_STORAGE_CLASS,
  MANAGED_BY,
  builtImageTag,
  labelSafe,
  namespaceFilePath,
  namespaceName,
  renderFiles,
  renderManifests,
  serializeManifest,
} from '../src/drivers/k3s/render.js';
import type {
  DeploymentManifest,
  KubeManifest,
  PersistentVolumeClaimManifest,
  SecretManifest,
  ServiceManifest,
} from '../src/drivers/k3s/manifest-model.js';
import {
  BUILDER_IDLE_TTL_MS,
  BUILDER_LAST_BUILD_ANNOTATION,
  BUILDKIT_IMAGE,
  buildCommand,
  builderAdmissionProbeManifest,
  builderDeploymentManifest,
  builderNamespaceManifest,
  builderStateCommand,
  deleteIdleBuilderCommand,
  importCommand,
  parseBuilderState,
  pushContextCommand,
} from '../src/drivers/k3s/builder.js';
import { K3sDriver } from '../src/drivers/k3s/driver.js';
import { getDriver } from '../src/drivers/index.js';
import type { TargetContext } from '../src/drivers/types.js';
import type { SshSession } from '../src/ssh/client.js';
import { renderFiles as renderComposeFiles } from '../src/drivers/docker/render.js';
import { completeSecretValues } from '../src/drivers/secrets.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'spec',
  '__fixtures__',
);

/** The SAME fixtures as the Compose render, without one more field. */
function fixture(name: string): AppSpec {
  return parseAppSpec(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
}

/**
 * `kubectl apply --dry-run=client` needs to reach a server to discover the API
 * groups: without a cluster, it does not know what a `Deployment` is. We
 * therefore test the tool *and* its access before using it, as `render.test.ts`
 * tests that Docker is present.
 */
function probeKubectl(): boolean {
  try {
    execFileSync('kubectl', ['apply', '--dry-run=client', '-f', '-'], {
      input: 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: tp-probe\n',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

const kubectlAvailable = probeKubectl();

/**
 * Has the render validated by Kubernetes itself. It is the only proof that
 * counts: a syntactically correct YAML can still be an invalid manifest.
 */
function validateWithKubectl(spec: AppSpec): string {
  const document = renderFiles({ language: 'fr', spec, appSlug: spec.name })
    .map((file) => file.content)
    .join('\n---\n');

  return execFileSync(
    'kubectl',
    ['apply', '--dry-run=client', '-f', '-', '-n', namespaceName(spec.name)],
    { input: document, encoding: 'utf8' },
  );
}

function byKind<T extends KubeManifest>(manifests: KubeManifest[], kind: T['kind']): T[] {
  return manifests.filter((manifest): manifest is T => manifest.kind === kind);
}

function deploymentOf(manifests: KubeManifest[], name: string): DeploymentManifest {
  const found = byKind<DeploymentManifest>(manifests, 'Deployment').find(
    (manifest) => manifest.metadata.name === name,
  );
  assert.ok(found, `Deployment ${name} attendu`);
  return found;
}

describe('render() — AppSpec to Kubernetes manifests', () => {
  describe('simple.json', () => {
    const spec = fixture('simple');
    const manifests = renderManifests({ language: 'fr', spec, appSlug: spec.name });

    it('creates the app-{slug} namespace first', () => {
      assert.equal(namespaceName('demo-api'), 'app-demo-api');
      assert.equal(manifests[0]?.kind, 'Namespace');
      assert.equal(manifests[0]?.metadata.name, 'app-demo-api');
    });

    it('renders only what the spec declares', () => {
      assert.deepEqual(
        manifests.map((manifest) => manifest.kind),
        ['Namespace', 'ConfigMap', 'Deployment', 'Service'],
        'no Secret, PVC or Ingress: the spec declares none',
      );
    });

    it('puts each resource in the application’s namespace', () => {
      for (const manifest of manifests.slice(1)) {
        assert.equal(manifest.metadata.namespace, 'app-demo-api', manifest.kind);
      }
    });

    it('sets the standard labels on every resource', () => {
      for (const manifest of manifests) {
        const labels = manifest.metadata.labels ?? {};
        assert.equal(labels['app.kubernetes.io/managed-by'], MANAGED_BY, manifest.kind);
        assert.equal(labels['app.kubernetes.io/version'], '1.0.0', manifest.kind);
        assert.ok(labels['app.kubernetes.io/name'], manifest.kind);
      }
    });

    it('keeps the version out of the selector, which is immutable', () => {
      const deployment = deploymentOf(manifests, 'api');
      assert.deepEqual(deployment.spec.selector.matchLabels, {
        'app.kubernetes.io/name': 'api',
        'app.kubernetes.io/instance': 'demo-api',
      });
      assert.equal(
        deployment.spec.template.metadata.labels['app.kubernetes.io/version'],
        '1.0.0',
        'the version stays on the pod, where it can change',
      );
    });

    it('translates healthcheck into readinessProbe and livenessProbe', () => {
      const container = deploymentOf(manifests, 'api').spec.template.spec.containers[0];
      assert.ok(container);
      assert.deepEqual(container.readinessProbe.httpGet, { path: '/', port: 80, scheme: 'HTTP' });
      assert.equal(container.readinessProbe.periodSeconds, 5);
      assert.equal(container.readinessProbe.timeoutSeconds, 3);
      assert.equal(container.readinessProbe.failureThreshold, 10);
      assert.deepEqual(container.livenessProbe.httpGet, { path: '/', port: 80, scheme: 'HTTP' });
      assert.equal(
        container.livenessProbe.initialDelaySeconds,
        10,
        'the liveness probe gives the service time to start',
      );
    });

    it('translates resources into requests and limits', () => {
      const container = deploymentOf(manifests, 'api').spec.template.spec.containers[0];
      assert.deepEqual(container?.resources, {
        requests: { cpu: '500m', memory: '256Mi' },
        limits: { cpu: '500m', memory: '256Mi' },
      });
    });

    /**
     * `simple.json` pulls `nginx` from a registry: it is precisely the image the
     * old, uniform context prevented from starting.
     */
    it('hardens without imposing an identity — the image is third-party', () => {
      const pod = deploymentOf(manifests, 'api').spec.template.spec;
      assert.deepEqual(pod.securityContext, {
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      });
      const container = pod.containers[0];
      assert.equal(container?.securityContext.allowPrivilegeEscalation, false);
      assert.equal(container?.securityContext.privileged, false);
      assert.deepEqual(container?.securityContext.capabilities.drop, ['ALL']);
      assert.deepEqual(container?.securityContext.capabilities.add, [
        'CHOWN',
        'DAC_OVERRIDE',
        'FOWNER',
        'SETGID',
        'SETUID',
      ]);
    });

    it('exposes as ClusterIP: no host port, the cluster’s proxy reaches it', () => {
      const service = byKind<ServiceManifest>(manifests, 'Service')[0];
      assert.equal(service?.spec.type, 'ClusterIP');
      assert.deepEqual(service?.spec.ports, [
        { name: 'http', port: 80, targetPort: 80, protocol: 'TCP' },
      ]);
      assert.deepEqual(service?.spec.selector, {
        'app.kubernetes.io/name': 'api',
        'app.kubernetes.io/instance': 'demo-api',
      });
    });

    it('produces manifests validated by kubectl', { skip: !kubectlAvailable }, () => {
      const output = validateWithKubectl(spec);
      assert.match(output, /namespace\/app-demo-api/);
      assert.match(output, /deployment\.apps\/api/);
      assert.match(output, /service\/api/);
    });
  });

  describe('fullstack.json', () => {
    const spec = fixture('fullstack');
    const secretValues = {
      DATABASE_PASSWORD: 'p4ss:w"rd',
      JWT_SECRET: 'ligne1\nligne2',
      POSTGRES_PASSWORD: '*pas-une-ancre',
    };
    const manifests = renderManifests({ language: 'fr', spec, appSlug: spec.name, secretValues });

    it('renders one resource per object, in apply order', () => {
      assert.deepEqual(
        manifests.map((manifest) => `${manifest.kind}/${manifest.metadata.name}`),
        [
          'Namespace/app-boutique',
          'ConfigMap/postgres-env',
          'ConfigMap/api-env',
          'ConfigMap/front-env',
          'Secret/postgres-secrets',
          'Secret/api-secrets',
          'PersistentVolumeClaim/postgres-data',
          'PersistentVolumeClaim/api-uploads',
          'Deployment/postgres',
          'Deployment/api',
          'Deployment/front',
          'Service/postgres',
          'Service/api',
          'Service/front',
        ],
        'services in dependency order, resources in apply order',
      );
    });

    it('names the files so that kubectl apply -f . respects the order of kinds', () => {
      const files = renderFiles({ language: 'fr', spec, appSlug: spec.name, secretValues });
      // `kubectl apply -f <dir>` reads files in lexicographic order: it is the
      // numeric prefix that carries the apply order.
      const sorted = [...files].map((file) => file.path).sort();
      const ranks = sorted.map((file) =>
        Number.parseInt(file.slice(file.indexOf('/') + 1), 10),
      );

      assert.ok(
        ranks.every((rank, index) => index === 0 || rank >= (ranks[index - 1] ?? 0)),
        `kinds must stay ordered: ${sorted.join(', ')}`,
      );
      assert.equal(sorted[0], namespaceFilePath('boutique'), 'the namespace comes first');
      assert.equal(files[0]?.path, namespaceFilePath('boutique'));
    });

    it('builds the Dockerfile services and tags their image', () => {
      assert.equal(
        deploymentOf(manifests, 'api').spec.template.spec.containers[0]?.image,
        'app-boutique/api:2.3.1',
      );
      assert.equal(builtImageTag('boutique', 'api', '2.3.1'), 'app-boutique/api:2.3.1');
      assert.equal(
        deploymentOf(manifests, 'postgres').spec.template.spec.containers[0]?.image,
        'postgres:16-alpine',
        'image pulled as is',
      );
    });

    it('never looks on a registry for an image built on the node', () => {
      for (const deployment of byKind<DeploymentManifest>(manifests, 'Deployment')) {
        assert.equal(
          deployment.spec.template.spec.containers[0]?.imagePullPolicy,
          'IfNotPresent',
          deployment.metadata.name,
        );
      }
    });

    it('creates a local-path PVC per declared volume', () => {
      const claims = byKind<PersistentVolumeClaimManifest>(manifests, 'PersistentVolumeClaim');
      assert.deepEqual(
        claims.map((claim) => [claim.metadata.name, claim.spec.resources.requests.storage]),
        [
          ['postgres-data', '20Gi'],
          ['api-uploads', '5Gi'],
        ],
      );
      for (const claim of claims) {
        assert.equal(claim.spec.storageClassName, DEFAULT_STORAGE_CLASS);
        assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
      }
    });

    it('mounts the PVC where the spec asks', () => {
      const postgres = deploymentOf(manifests, 'postgres');
      assert.deepEqual(postgres.spec.template.spec.containers[0]?.volumeMounts, [
        { name: 'data', mountPath: '/var/lib/postgresql/data' },
      ]);
      assert.deepEqual(postgres.spec.template.spec.volumes, [
        { name: 'data', persistentVolumeClaim: { claimName: 'postgres-data' } },
      ]);
    });

    it('switches to Recreate when a ReadWriteOnce volume is involved', () => {
      assert.equal(deploymentOf(manifests, 'postgres').spec.strategy.type, 'Recreate');
      assert.equal(deploymentOf(manifests, 'front').spec.strategy.type, 'RollingUpdate');
    });

    it('carries over the spec’s replicas', () => {
      assert.equal(deploymentOf(manifests, 'front').spec.replicas, 2);
      assert.equal(deploymentOf(manifests, 'api').spec.replicas, 1);
    });

    it('separates env (ConfigMap) and secrets (Secret)', () => {
      const container = deploymentOf(manifests, 'api').spec.template.spec.containers[0];
      assert.deepEqual(container?.envFrom, [
        { configMapRef: { name: 'api-env' } },
        { secretRef: { name: 'api-secrets' } },
      ]);
      const front = deploymentOf(manifests, 'front').spec.template.spec.containers[0];
      assert.deepEqual(
        front?.envFrom,
        [{ configMapRef: { name: 'front-env' } }],
        'front declares no secret',
      );
    });

    it('never writes a secret’s value outside the Secret manifest', () => {
      for (const manifest of manifests) {
        if (manifest.kind === 'Secret') continue;
        const yaml = serializeManifest(manifest);
        for (const value of Object.values(secretValues)) {
          assert.ok(
            !yaml.includes(value.split('\n')[0] ?? value),
            `${manifest.kind}/${manifest.metadata.name} must not carry a secret value`,
          );
        }
      }
    });

    it('renders the Secrets as 0600, like the .env on the Docker side', () => {
      const files = renderFiles({ language: 'fr', spec, appSlug: spec.name, secretValues });
      for (const file of files) {
        assert.equal(
          file.mode,
          file.path.includes('-secret-') ? 0o600 : 0o644,
          file.path,
        );
      }
    });

    it('declares each secret declared by the service', () => {
      const [secret] = byKind<SecretManifest>(manifests, 'Secret').filter(
        (manifest) => manifest.metadata.name === 'api-secrets',
      );
      assert.deepEqual(Object.keys(secret?.stringData ?? {}).sort(), [
        'DATABASE_PASSWORD',
        'JWT_SECRET',
      ]);
      assert.equal(secret?.type, 'Opaque');
    });

    it('refuses to render a declared secret with no resolved value, like the Docker render', () => {
      assert.throws(
        () => renderManifests({ language: 'fr', spec, appSlug: spec.name }),
        /DATABASE_PASSWORD/,
      );
    });

    it('probes the entry point over HTTP, the others over TCP', () => {
      const front = deploymentOf(manifests, 'front').spec.template.spec.containers[0];
      assert.deepEqual(front?.readinessProbe.httpGet, {
        path: '/healthz',
        port: 3000,
        scheme: 'HTTP',
      });
      const postgres = deploymentOf(manifests, 'postgres').spec.template.spec.containers[0];
      assert.deepEqual(postgres?.readinessProbe.tcpSocket, { port: 5432 });
      assert.equal(postgres?.readinessProbe.httpGet, undefined);
    });

    it('locks the root of the images we build, not of third-party images', () => {
      const api = deploymentOf(manifests, 'api').spec.template.spec;
      assert.equal(api.containers[0]?.securityContext.readOnlyRootFilesystem, true);
      assert.ok(
        api.volumes?.some((volume) => volume.name === 'tmp-scratch'),
        'a read-only root requires a writable /tmp',
      );

      const postgres = deploymentOf(manifests, 'postgres').spec.template.spec;
      assert.equal(
        postgres.containers[0]?.securityContext.readOnlyRootFilesystem,
        false,
        'we do not know what a third-party image writes at the root',
      );
      assert.ok(!postgres.volumes?.some((volume) => volume.name === 'tmp-scratch'));
    });

    it('renders no Ingress: a domain is a route of the reverse proxy', () => {
      // The spec does declare an `ingress.host`: it becomes a route, set by the
      // target's proxy toward the Service — see test/proxy.test.ts.
      assert.equal(byKind(manifests, 'Ingress').length, 0);
    });

    it('produces manifests validated by kubectl', { skip: !kubectlAvailable }, () => {
      const output = validateWithKubectl(spec);
      for (const expected of [
        'namespace/app-boutique',
        'deployment.apps/front',
        'deployment.apps/api',
        'deployment.apps/postgres',
        'persistentvolumeclaim/api-uploads',
      ]) {
        assert.ok(output.includes(expected), `${expected} expected in kubectl’s output`);
      }
    });
  });

  describe('invalid.json', () => {
    it('never reaches the render: the spec is rejected before', () => {
      const raw: unknown = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid.json'), 'utf8'));
      const parsed = safeParseAppSpec(raw);
      assert.equal(parsed.success, false);
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

      const manifests = renderManifests({ language: 'fr', spec, appSlug: 'echappement' });
      const configMap = manifests.find((manifest) => manifest.kind === 'ConfigMap');
      assert.ok(configMap);

      const parsed = parseYaml(serializeManifest(configMap)) as {
        data: Record<string, string>;
      };
      assert.equal(parsed.data.QUOTED, 'valeur avec "guillemets" et \'apostrophes\'');
      assert.equal(parsed.data.MULTILINE, 'première ligne\nseconde ligne');
      assert.equal(parsed.data.YAML_TRAP, '*ancre: &pas-une-ancre');
      assert.equal(parsed.data.COLON, 'clé: valeur');
    });

    it('withstands the traps of Kubernetes’ YAML 1.1 parser', () => {
      // The Kubernetes API reads YAML as 1.1: `y`, `no`, `on`, `off` are booleans
      // there and `12:30` a sexagesimal. An unprotected `stringData` then gets
      // rejected — "cannot unmarshal bool into Go struct field".
      const traps = {
        YES_SHORT: 'y',
        NO_WORD: 'no',
        ON_WORD: 'on',
        OFF_WORD: 'off',
        TRUE_WORD: 'true',
        SEXAGESIMAL: '12:30',
        OCTAL: '0755',
        TILDE: '~',
      };

      const spec = parseAppSpec({
        name: 'pieges',
        version: '1.0.0',
        services: [
          {
            name: 'web',
            source: { type: 'image', ref: 'nginx:alpine' },
            port: 80,
            exposed: true,
            env: traps,
            secrets: ['MOT_DE_PASSE'],
          },
        ],
      });

      const manifests = renderManifests({
        language: 'fr',
        spec,
        appSlug: 'pieges',
        secretValues: { MOT_DE_PASSE: 'y' },
      });

      const configMap = manifests.find((manifest) => manifest.kind === 'ConfigMap');
      const secret = manifests.find((manifest) => manifest.kind === 'Secret');
      assert.ok(configMap && secret);

      // We read back as Kubernetes would, not as YAML 1.2 would.
      const readAsKubernetes = (manifest: KubeManifest) =>
        parseYaml(serializeManifest(manifest), { version: '1.1' }) as {
          data?: Record<string, unknown>;
          stringData?: Record<string, unknown>;
        };

      const parsedConfigMap = readAsKubernetes(configMap);
      for (const [key, value] of Object.entries(traps)) {
        assert.equal(parsedConfigMap.data?.[key], value, key);
      }
      assert.equal(readAsKubernetes(secret).stringData?.MOT_DE_PASSE, 'y');
    });

    it('sanitizes a version Kubernetes would refuse as a label', () => {
      assert.equal(labelSafe('2.3.1'), '2.3.1');
      assert.equal(labelSafe('1.0.0+build.5'), '1.0.0_build.5');
      assert.equal(labelSafe('1.0.0-rc.1+exp.sha.5114f85'), '1.0.0-rc.1_exp.sha.5114f85');
    });

    it('stays deterministic', () => {
      const spec = fixture('fullstack');
      const values = {
        DATABASE_PASSWORD: 'p4ss',
        JWT_SECRET: 'jwt',
        POSTGRES_PASSWORD: 'pg',
      };
      const once = renderFiles({
        language: 'fr',
        spec,
        appSlug: spec.name,
        secretValues: values,
      }).map((file) => file.content);
      const twice = renderFiles({
        language: 'fr',
        spec,
        appSlug: spec.name,
        secretValues: values,
      }).map((file) => file.content);
      assert.deepEqual(once, twice);
    });
  });

  /**
   * The test that guarantees CLAUDE.md's rule 1 on aliases: resolution happens in
   * the neutral code, so both renders receive **the same complete map**. Compose
   * could have interpolated `${MARIADB_PASSWORD}` from the `.env`; Kubernetes
   * interpolates nothing. Writing the alias on the runtime side would have made
   * the same AppSpec work on one side only.
   */
  describe('secret aliases — Docker / K3s parity', () => {
    const spec = parseAppSpec({
      name: 'boutique',
      version: '1.0.0',
      services: [
        {
          name: 'web',
          source: { type: 'image', ref: 'wordpress:6-apache' },
          port: 80,
          exposed: true,
          secrets: [{ name: 'WORDPRESS_DB_PASSWORD', from: 'MARIADB_PASSWORD' }],
          dependsOn: ['mariadb'],
        },
        {
          name: 'mariadb',
          source: { type: 'image', ref: 'mariadb:11' },
          port: 3306,
          secrets: ['MARIADB_PASSWORD', 'MARIADB_ROOT_PASSWORD'],
        },
      ],
    });
    const secretValues = { MARIADB_PASSWORD: 'valeur-partagee', MARIADB_ROOT_PASSWORD: 'root' };

    it('the application service’s K8s Secret carries the aliased name and the root’s value', () => {
      const manifests = renderManifests({ language: 'fr', spec, appSlug: spec.name, secretValues });
      const secret = manifests.find(
        (manifest): manifest is SecretManifest =>
          manifest.kind === 'Secret' && manifest.metadata.name === 'web-secrets',
      );
      assert.ok(secret);
      assert.deepEqual(secret.stringData, { WORDPRESS_DB_PASSWORD: 'valeur-partagee' });
    });

    it('the Docker `.env` carries both names with the same value', () => {
      const files = renderComposeFiles({
        language: 'fr',
        spec,
        appSlug: spec.name,
        publishedPort: null,
        secretValues,
      });
      const env = files.find((file) => file.path === '.env');
      assert.ok(env);
      assert.match(env.content, /^WORDPRESS_DB_PASSWORD=valeur-partagee$/m);
      assert.match(env.content, /^MARIADB_PASSWORD=valeur-partagee$/m);
    });

    it('both renders start from the same map, aliases included', () => {
      const complete = completeSecretValues(spec, secretValues, 'fr');
      assert.deepEqual(complete, {
        WORDPRESS_DB_PASSWORD: 'valeur-partagee',
        MARIADB_PASSWORD: 'valeur-partagee',
        MARIADB_ROOT_PASSWORD: 'root',
      });
    });
  });

  /**
   * Hardening is decided on what we know of the image, not on a uniform rule.
   * These cases freeze the decision field by field: it is pure rendering, hence
   * checkable without a cluster — whereas the failure they prevent only showed
   * when a pod started.
   */
  describe('securityContext according to the source type', () => {
    /** A minimal AppSpec carrying both regimes side by side. */
    const spec = parseAppSpec({
      name: 'mixte',
      version: '1.0.0',
      services: [
        {
          name: 'web',
          source: { type: 'dockerfile', context: './web', dockerfile: 'Dockerfile' },
          port: 3000,
          exposed: true,
          dependsOn: ['db'],
        },
        {
          name: 'db',
          source: { type: 'image', ref: 'postgres:16-alpine' },
          port: 5432,
          volumes: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
        },
      ],
    });
    const manifests = renderManifests({ language: 'fr', spec, appSlug: spec.name });
    const own = deploymentOf(manifests, 'web').spec.template.spec;
    const third = deploymentOf(manifests, 'db').spec.template.spec;

    it('imposes the run identity on an image we build', () => {
      assert.deepEqual(own.securityContext, {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      });
    });

    it('does not impose it on a third-party image: we do not know which account it runs as', () => {
      assert.equal(third.securityContext.runAsNonRoot, undefined);
      assert.equal(third.securityContext.runAsUser, undefined);
      assert.equal(third.securityContext.runAsGroup, undefined);
    });

    it('keeps `fsGroup` in both cases: it owns the volume, not the process', () => {
      assert.equal(own.securityContext.fsGroup, 1000);
      assert.equal(
        third.securityContext.fsGroup,
        1000,
        'removing it would make a new PVC (root:root 0755) unreadable as non-root',
      );
    });

    it('keeps `seccompProfile` in both cases: it depends on no identity', () => {
      assert.deepEqual(own.securityContext.seccompProfile, { type: 'RuntimeDefault' });
      assert.deepEqual(third.securityContext.seccompProfile, { type: 'RuntimeDefault' });
    });

    it('forbids privilege and escalation in both cases', () => {
      for (const pod of [own, third]) {
        assert.equal(pod.containers[0]?.securityContext.privileged, false);
        assert.equal(pod.containers[0]?.securityContext.allowPrivilegeEscalation, false);
      }
    });

    it('drops every capability from our images, and gives the others the bare minimum', () => {
      assert.deepEqual(own.containers[0]?.securityContext.capabilities, { drop: ['ALL'] });
      // Measured: without these five, `nginx` fails on `chown` and `postgres` on
      // `chmod` — their entry point starts as root then drops its privileges.
      assert.deepEqual(third.containers[0]?.securityContext.capabilities, {
        drop: ['ALL'],
        add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
      });
    });

    it('never grants the capabilities Docker does give by default', () => {
      const granted = third.containers[0]?.securityContext.capabilities.add ?? [];
      for (const forbidden of ['NET_RAW', 'MKNOD', 'SYS_CHROOT', 'SETPCAP', 'SETFCAP', 'KILL']) {
        assert.ok(!granted.includes(forbidden), `${forbidden} must not be granted`);
      }
    });

    it('only locks the root on our images', () => {
      assert.equal(own.containers[0]?.securityContext.readOnlyRootFilesystem, true);
      assert.equal(third.containers[0]?.securityContext.readOnlyRootFilesystem, false);
    });

    it('serializes no empty identity field for a third-party image', () => {
      const deployment = manifests.find(
        (manifest) => manifest.kind === 'Deployment' && manifest.metadata.name === 'db',
      );
      assert.ok(deployment);
      const yaml = serializeManifest(deployment);
      // `runAsUser: null` would be refused by the API: the field must be absent.
      assert.ok(!yaml.includes('runAsUser'), yaml);
      assert.ok(!yaml.includes('runAsNonRoot'), yaml);
      assert.ok(!yaml.includes('runAsGroup'), yaml);
      assert.match(yaml, /fsGroup: 1000/);
    });

    it('the manifests stay valid for Kubernetes', { skip: !kubectlAvailable }, () => {
      const output = validateWithKubectl(spec);
      assert.match(output, /deployment\.apps\/db/);
      assert.match(output, /deployment\.apps\/web/);
    });
  });
});

/**
 * The image builder.
 *
 * What is checked here is not "BuildKit works" — that is proven on a real
 * cluster, by `pnpm test:parity` — but that the few decisions its working
 * depends on are indeed the ones we think, and that a refactor will not undo
 * them silently.
 */
/** The build that sets up or finds the builder, in the manifests below. */
const LAST_BUILD = new Date('2026-10-04T08:00:00Z');

describe('K3s image builder', () => {
  const deploymentManifest = parseYaml(builderDeploymentManifest(LAST_BUILD)) as {
    metadata: { name: string; namespace: string; labels: Record<string, string> };
    spec: {
      strategy: { type: string };
      template: {
        spec: {
          containers: Array<{
            image: string;
            args: string[];
            securityContext: { privileged: boolean };
          }>;
        };
      };
    };
  };
  const container = deploymentManifest.spec.template.spec.containers[0];
  assert.ok(container);

  it('runs runc in the pod, not through the node’s containerd', () => {
    // The containerd worker would require `mountPropagation: Bidirectional` and
    // hence a node root as a shared mount — which cannot be assumed.
    assert.ok(container.args.includes('--oci-worker=true'));
    assert.ok(container.args.includes('--containerd-worker=false'));
  });

  it('has no host volume: the node lends it neither socket nor path', () => {
    assert.ok(
      !builderDeploymentManifest(LAST_BUILD).includes('hostPath'),
      'a hostPath would make the builder depend on the node’s topology',
    );
  });

  it('stays deletable from the workloads screen', () => {
    // See `builder.ts`: the `managed-by` label would make its deletion be refused,
    // pointing to a deployment that does not exist.
    assert.equal(deploymentManifest.metadata.labels['app.kubernetes.io/managed-by'], undefined);
  });

  it('is replaced without overlapping: two buildkitd would fight over the lock', () => {
    assert.equal(deploymentManifest.spec.strategy.type, 'Recreate');
  });

  it('pins the builder’s version', () => {
    assert.equal(container.image, BUILDKIT_IMAGE);
    assert.match(container.image, /:v\d+\.\d+\.\d+$/);
  });

  it('accepts the privilege, which the preflight has validated by admission', () => {
    assert.equal(container.securityContext.privileged, true);
  });

  it('imports into the k8s.io namespace, the only one the kubelet sees', () => {
    assert.match(importCommand(), /k3s ctr -n k8s\.io images import -/);
  });

  it('only exposes the built service’s context to the builder', () => {
    const command = pushContextCommand('/opt/bootstrap/apps/boutique/2.3.1/api');
    assert.match(command, /^tar -C '\/opt\/bootstrap\/apps\/boutique\/2\.3\.1\/api' -cf - \./);
    assert.ok(!command.includes('hostPath'));
  });

  it('carries a Dockerfile in a subdirectory all the way to buildctl', () => {
    assert.match(buildCommand('app-boutique/api:2.3.1', 'docker/Dockerfile'), /filename='docker\/Dockerfile'/);
  });

  it('names the image in the OCI tar: it is that name containerd takes over', () => {
    assert.match(
      buildCommand('app-boutique/api:2.3.1', 'Dockerfile'),
      /type=oci,name=app-boutique\/api:2\.3\.1,dest=/,
    );
  });

  it('submits a Pod to admission, not a controller', () => {
    // PodSecurity only refuses a Pod; on a Deployment it settles for a warning and
    // leaves the exit code at 0. The check would then be about nothing.
    const probe = parseYaml(builderAdmissionProbeManifest()) as {
      kind: string;
      spec: { containers: Array<{ securityContext: { privileged: boolean } }> };
    };
    assert.equal(probe.kind, 'Pod');
    assert.equal(probe.spec.containers[0]?.securityContext.privileged, true);
  });

  it('submits exactly the pod it will deploy, otherwise it proves nothing', () => {
    const probe = parseYaml(builderAdmissionProbeManifest()) as { spec: unknown };
    assert.deepEqual(probe.spec, deploymentManifest.spec.template.spec);
  });

  it(
    'produces a manifest Kubernetes accepts',
    { skip: !kubectlAvailable },
    () => {
      const output = execFileSync('kubectl', ['apply', '--dry-run=client', '-f', '-'], {
        input: `${builderNamespaceManifest()}\n---\n${builderDeploymentManifest(LAST_BUILD)}`,
        encoding: 'utf8',
      });
      assert.match(output, /deployment\.apps\/buildkitd/);
    },
  );
});

/** An SSH session that answers command by command, and records what it was asked. */
function fakeTarget(
  answers: Array<(command: string) => { code: number; stdout?: string; stderr?: string }>,
) {
  const commands: string[] = [];
  const session = {
    id: 'session-test',
    host: 'k3s.test',
    client: {
      execCommand: async (command: string) => {
        commands.push(command);
        const answer = answers.shift();
        assert.ok(answer, `unexpected command: ${command}`);
        const { code, stdout = '', stderr = '' } = answer(command);
        return { code, stdout, stderr, signal: null };
      },
    },
  } as unknown as SshSession;
  const ctx: TargetContext = {
    target: { id: 'cible', name: 'k3s-1', host: 'k3s.test', rootPath: '/opt/pupitre' },
    sshSession: session,
    language: 'fr',
  };
  return { ctx, commands };
}

describe('K3s image builder — expiry', () => {
  const NOW = new Date('2026-10-05T09:00:00Z');
  const idle = new Date(NOW.getTime() - BUILDER_IDLE_TTL_MS - 60_000).toISOString();
  const recent = new Date(NOW.getTime() - 60 * 60_000).toISOString();
  const lines: string[] = [];
  const onLog = (line: string) => lines.push(line);

  it('stamps each build on the Deployment, not on the pod: stamping restarts nothing', () => {
    const manifest = parseYaml(builderDeploymentManifest(LAST_BUILD)) as {
      metadata: { annotations: Record<string, string> };
      spec: { template: { metadata: Record<string, unknown> } };
    };
    assert.equal(
      manifest.metadata.annotations[BUILDER_LAST_BUILD_ANNOTATION],
      LAST_BUILD.toISOString(),
    );
    assert.equal(manifest.spec.template.metadata.annotations, undefined);
  });

  it('reads the last build date, else the creation — and nothing when it does not exist', () => {
    assert.match(builderStateCommand(), /--ignore-not-found/);
    assert.match(builderStateCommand(), /annotations\.pupitre\\\.io\/last-build/);
    assert.deepEqual(parseBuilderState(`${recent}|2026-09-01T00:00:00Z|812\n`), {
      lastUsedAt: new Date(recent),
      resourceVersion: '812',
    });
    assert.deepEqual(parseBuilderState('|2026-09-01T00:00:00Z|90'), {
      lastUsedAt: new Date('2026-09-01T00:00:00Z'),
      resourceVersion: '90',
    });
    assert.equal(parseBuilderState(''), null);
    assert.equal(parseBuilderState('  \n'), null);
    assert.equal(parseBuilderState('not-a-date|still-not|7'), null);
  });

  it('deletes conditionally on the version read, its pods with it', () => {
    const command = deleteIdleBuilderCommand('812');
    assert.match(
      command,
      /^kubectl delete --raw \/apis\/apps\/v1\/namespaces\/pupitre-build\/deployments\/buildkitd -f - <</,
    );
    const body = JSON.parse(command.split('\n')[1] ?? '') as {
      preconditions: { resourceVersion: string };
      propagationPolicy: string;
    };
    assert.deepEqual(body.preconditions, { resourceVersion: '812' });
    assert.equal(body.propagationPolicy, 'Background');
  });

  it('absent: nothing to do, a single read', async () => {
    const { ctx, commands } = fakeTarget([() => ({ code: 0, stdout: '' })]);
    assert.deepEqual(await new K3sDriver().pruneIdleBuilder(ctx, onLog, NOW), {
      outcome: 'absent',
      lastUsedAt: null,
    });
    assert.equal(commands.length, 1);
  });

  it('served an hour ago: it stays, with no deletion attempt', async () => {
    const { ctx, commands } = fakeTarget([() => ({ code: 0, stdout: `${recent}|x|812` })]);
    assert.deepEqual(await new K3sDriver().pruneIdleBuilder(ctx, onLog, NOW), {
      outcome: 'kept',
      lastUsedAt: recent,
    });
    assert.equal(commands.length, 1);
  });

  it('no build for more than 24 h: removed, at the version read', async () => {
    const { ctx, commands } = fakeTarget([
      () => ({ code: 0, stdout: `${idle}|x|812` }),
      () => ({ code: 0, stdout: '{"kind":"Status","status":"Success"}' }),
    ]);
    assert.deepEqual(await new K3sDriver().pruneIdleBuilder(ctx, onLog, NOW), {
      outcome: 'removed',
      lastUsedAt: idle,
    });
    assert.match(commands[1] ?? '', /"resourceVersion":"812"/);
  });

  it('claimed by a build between read and deletion: the API refuses, it stays', async () => {
    const { ctx } = fakeTarget([
      () => ({ code: 0, stdout: `${idle}|x|812` }),
      () => ({
        code: 1,
        stderr:
          'Error from server (Conflict): Operation cannot be fulfilled on Deployment.apps "buildkitd": the ResourceVersion in the precondition (812) does not match',
      }),
    ]);
    assert.equal((await new K3sDriver().pruneIdleBuilder(ctx, onLog, NOW)).outcome, 'kept');
  });

  it('Docker builds without setting anything up: nothing to expire, and it does not pretend to', () => {
    assert.equal(getDriver('docker').pruneIdleBuilder, undefined);
    assert.equal(typeof getDriver('k3s').pruneIdleBuilder, 'function');
  });

  it('gone in the meantime: absent; another refusal bubbles up', async () => {
    const gone = fakeTarget([
      () => ({ code: 0, stdout: `${idle}|x|812` }),
      () => ({
        code: 1,
        stderr: 'Error from server (NotFound): deployments.apps "buildkitd" not found',
      }),
    ]);
    assert.equal((await new K3sDriver().pruneIdleBuilder(gone.ctx, onLog, NOW)).outcome, 'absent');
    const refused = fakeTarget([
      () => ({ code: 0, stdout: `${idle}|x|812` }),
      () => ({ code: 1, stderr: 'Error from server (Forbidden): deployments.apps is forbidden' }),
    ]);
    await assert.rejects(new K3sDriver().pruneIdleBuilder(refused.ctx, onLog, NOW), /non retiré/);
    const unreadable = fakeTarget([
      () => ({ code: 1, stderr: 'The connection to the server was refused' }),
    ]);
    await assert.rejects(new K3sDriver().pruneIdleBuilder(unreadable.ctx, onLog, NOW), /illisible/);
  });
});
