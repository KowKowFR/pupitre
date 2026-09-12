import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { parseAppSpec, safeParseAppSpec, type AppSpec } from '../src/spec/index.js';
import {
  DEFAULT_INGRESS_CLASS,
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
  IngressManifest,
  KubeManifest,
  PersistentVolumeClaimManifest,
  SecretManifest,
  ServiceManifest,
} from '../src/drivers/k3s/manifest-model.js';
import {
  BUILDKIT_IMAGE,
  buildCommand,
  builderAdmissionProbeManifest,
  builderDeploymentManifest,
  builderNamespaceManifest,
  importCommand,
  pushContextCommand,
} from '../src/drivers/k3s/builder.js';
import { renderFiles as renderComposeFiles } from '../src/drivers/docker/render.js';
import { completeSecretValues } from '../src/drivers/secrets.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'spec',
  '__fixtures__',
);

/** Les MÊMES fixtures que le rendu Compose, sans un champ de plus. */
function fixture(name: string): AppSpec {
  return parseAppSpec(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
}

/**
 * `kubectl apply --dry-run=client` a besoin de joindre un serveur pour
 * découvrir les groupes d'API : sans cluster, il ne sait pas ce qu'est un
 * `Deployment`. On teste donc l'outil *et* son accès avant de s'en servir,
 * comme `render.test.ts` teste la présence de Docker.
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
 * Fait valider le rendu par Kubernetes lui-même. C'est la seule preuve qui
 * compte : un YAML syntaxiquement correct peut rester un manifest invalide.
 */
function validateWithKubectl(spec: AppSpec): string {
  const document = renderFiles({ spec, appSlug: spec.name })
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

describe('render() — AppSpec vers manifests Kubernetes', () => {
  describe('simple.json', () => {
    const spec = fixture('simple');
    const manifests = renderManifests({ spec, appSlug: spec.name });

    it('crée le namespace app-{slug} en premier', () => {
      assert.equal(namespaceName('demo-api'), 'app-demo-api');
      assert.equal(manifests[0]?.kind, 'Namespace');
      assert.equal(manifests[0]?.metadata.name, 'app-demo-api');
    });

    it('ne rend que ce que la spec déclare', () => {
      assert.deepEqual(
        manifests.map((manifest) => manifest.kind),
        ['Namespace', 'ConfigMap', 'Deployment', 'Service'],
        'ni Secret ni PVC ni Ingress : la spec n’en déclare aucun',
      );
    });

    it('range chaque ressource dans le namespace de l’application', () => {
      for (const manifest of manifests.slice(1)) {
        assert.equal(manifest.metadata.namespace, 'app-demo-api', manifest.kind);
      }
    });

    it('pose les labels standard sur toutes les ressources', () => {
      for (const manifest of manifests) {
        const labels = manifest.metadata.labels ?? {};
        assert.equal(labels['app.kubernetes.io/managed-by'], MANAGED_BY, manifest.kind);
        assert.equal(labels['app.kubernetes.io/version'], '1.0.0', manifest.kind);
        assert.ok(labels['app.kubernetes.io/name'], manifest.kind);
      }
    });

    it('garde la version hors du sélecteur, qui est immuable', () => {
      const deployment = deploymentOf(manifests, 'api');
      assert.deepEqual(deployment.spec.selector.matchLabels, {
        'app.kubernetes.io/name': 'api',
        'app.kubernetes.io/instance': 'demo-api',
      });
      assert.equal(
        deployment.spec.template.metadata.labels['app.kubernetes.io/version'],
        '1.0.0',
        'la version reste sur le pod, où elle peut changer',
      );
    });

    it('traduit healthcheck en readinessProbe et livenessProbe', () => {
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
        'la sonde de vivacité laisse au service le temps de démarrer',
      );
    });

    it('traduit les ressources en requests et limits', () => {
      const container = deploymentOf(manifests, 'api').spec.template.spec.containers[0];
      assert.deepEqual(container?.resources, {
        requests: { cpu: '500m', memory: '256Mi' },
        limits: { cpu: '500m', memory: '256Mi' },
      });
    });

    /**
     * `simple.json` tire `nginx` d'un registry : c'est précisément l'image que
     * l'ancien contexte, uniforme, empêchait de démarrer.
     */
    it('durcit sans imposer d’identité — l’image est tierce', () => {
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

    it('expose en ClusterIP : aucun port hôte, c’est le rôle de l’Ingress', () => {
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

    it('produit des manifests validés par kubectl', { skip: !kubectlAvailable }, () => {
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
    const manifests = renderManifests({ spec, appSlug: spec.name, secretValues });

    it('rend une ressource par objet, dans l’ordre d’application', () => {
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
          'Ingress/boutique',
        ],
        'services dans l’ordre des dépendances, ressources dans l’ordre d’application',
      );
    });

    it('nomme les fichiers pour que kubectl apply -f . respecte l’ordre des types', () => {
      const files = renderFiles({ spec, appSlug: spec.name, secretValues });
      // `kubectl apply -f <dir>` lit les fichiers dans l'ordre lexicographique :
      // c'est le préfixe numérique qui porte l'ordre d'application.
      const sorted = [...files].map((file) => file.path).sort();
      const ranks = sorted.map((file) =>
        Number.parseInt(file.slice(file.indexOf('/') + 1), 10),
      );

      assert.ok(
        ranks.every((rank, index) => index === 0 || rank >= (ranks[index - 1] ?? 0)),
        `les types doivent rester ordonnés : ${sorted.join(', ')}`,
      );
      assert.equal(sorted[0], namespaceFilePath('boutique'), 'le namespace vient en premier');
      assert.equal(files[0]?.path, namespaceFilePath('boutique'));
    });

    it('construit les services à Dockerfile et taggue leur image', () => {
      assert.equal(
        deploymentOf(manifests, 'api').spec.template.spec.containers[0]?.image,
        'app-boutique/api:2.3.1',
      );
      assert.equal(builtImageTag('boutique', 'api', '2.3.1'), 'app-boutique/api:2.3.1');
      assert.equal(
        deploymentOf(manifests, 'postgres').spec.template.spec.containers[0]?.image,
        'postgres:16-alpine',
        'image tirée telle quelle',
      );
    });

    it('ne va jamais chercher sur un registry une image construite sur le node', () => {
      for (const deployment of byKind<DeploymentManifest>(manifests, 'Deployment')) {
        assert.equal(
          deployment.spec.template.spec.containers[0]?.imagePullPolicy,
          'IfNotPresent',
          deployment.metadata.name,
        );
      }
    });

    it('crée un PVC local-path par volume déclaré', () => {
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

    it('monte le PVC là où la spec le demande', () => {
      const postgres = deploymentOf(manifests, 'postgres');
      assert.deepEqual(postgres.spec.template.spec.containers[0]?.volumeMounts, [
        { name: 'data', mountPath: '/var/lib/postgresql/data' },
      ]);
      assert.deepEqual(postgres.spec.template.spec.volumes, [
        { name: 'data', persistentVolumeClaim: { claimName: 'postgres-data' } },
      ]);
    });

    it('passe à Recreate quand un volume ReadWriteOnce est en jeu', () => {
      assert.equal(deploymentOf(manifests, 'postgres').spec.strategy.type, 'Recreate');
      assert.equal(deploymentOf(manifests, 'front').spec.strategy.type, 'RollingUpdate');
    });

    it('reporte les répliques de la spec', () => {
      assert.equal(deploymentOf(manifests, 'front').spec.replicas, 2);
      assert.equal(deploymentOf(manifests, 'api').spec.replicas, 1);
    });

    it('sépare env (ConfigMap) et secrets (Secret)', () => {
      const container = deploymentOf(manifests, 'api').spec.template.spec.containers[0];
      assert.deepEqual(container?.envFrom, [
        { configMapRef: { name: 'api-env' } },
        { secretRef: { name: 'api-secrets' } },
      ]);
      const front = deploymentOf(manifests, 'front').spec.template.spec.containers[0];
      assert.deepEqual(
        front?.envFrom,
        [{ configMapRef: { name: 'front-env' } }],
        'front ne déclare aucun secret',
      );
    });

    it('n’inscrit jamais la valeur d’un secret hors du manifest Secret', () => {
      for (const manifest of manifests) {
        if (manifest.kind === 'Secret') continue;
        const yaml = serializeManifest(manifest);
        for (const value of Object.values(secretValues)) {
          assert.ok(
            !yaml.includes(value.split('\n')[0] ?? value),
            `${manifest.kind}/${manifest.metadata.name} ne doit pas porter de valeur de secret`,
          );
        }
      }
    });

    it('rend les Secret en 0600, comme le .env côté Docker', () => {
      const files = renderFiles({ spec, appSlug: spec.name, secretValues });
      for (const file of files) {
        assert.equal(
          file.mode,
          file.path.includes('-secret-') ? 0o600 : 0o644,
          file.path,
        );
      }
    });

    it('déclare chaque secret déclaré par le service', () => {
      const [secret] = byKind<SecretManifest>(manifests, 'Secret').filter(
        (manifest) => manifest.metadata.name === 'api-secrets',
      );
      assert.deepEqual(Object.keys(secret?.stringData ?? {}).sort(), [
        'DATABASE_PASSWORD',
        'JWT_SECRET',
      ]);
      assert.equal(secret?.type, 'Opaque');
    });

    it('refuse de rendre un secret déclaré sans valeur résolue, comme le rendu Docker', () => {
      assert.throws(
        () => renderManifests({ spec, appSlug: spec.name }),
        /DATABASE_PASSWORD/,
      );
    });

    it('sonde la porte d’entrée en HTTP, les autres en TCP', () => {
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

    it('verrouille la racine des images que nous construisons, pas des images tierces', () => {
      const api = deploymentOf(manifests, 'api').spec.template.spec;
      assert.equal(api.containers[0]?.securityContext.readOnlyRootFilesystem, true);
      assert.ok(
        api.volumes?.some((volume) => volume.name === 'tmp-scratch'),
        'une racine en lecture seule exige un /tmp inscriptible',
      );

      const postgres = deploymentOf(manifests, 'postgres').spec.template.spec;
      assert.equal(
        postgres.containers[0]?.securityContext.readOnlyRootFilesystem,
        false,
        'on ignore ce qu’une image tierce écrit à la racine',
      );
      assert.ok(!postgres.volumes?.some((volume) => volume.name === 'tmp-scratch'));
    });

    it('route l’Ingress vers targetService, en TLS quand la spec le demande', () => {
      const [ingress] = byKind<IngressManifest>(manifests, 'Ingress');
      assert.ok(ingress);
      assert.equal(ingress.spec.ingressClassName, DEFAULT_INGRESS_CLASS);
      assert.deepEqual(ingress.spec.tls, [
        { hosts: ['boutique.example.com'], secretName: 'boutique-tls' },
      ]);
      assert.equal(ingress.spec.rules[0]?.host, 'boutique.example.com');
      assert.deepEqual(ingress.spec.rules[0]?.http.paths[0]?.backend, {
        service: { name: 'front', port: { number: 3000 } },
      });
    });

    it('produit des manifests validés par kubectl', { skip: !kubectlAvailable }, () => {
      const output = validateWithKubectl(spec);
      for (const expected of [
        'namespace/app-boutique',
        'deployment.apps/front',
        'deployment.apps/api',
        'deployment.apps/postgres',
        'persistentvolumeclaim/api-uploads',
        'ingress.networking.k8s.io/boutique',
      ]) {
        assert.ok(output.includes(expected), `${expected} attendu dans la sortie de kubectl`);
      }
    });
  });

  describe('invalid.json', () => {
    it('n’atteint jamais le rendu : la spec est rejetée avant', () => {
      const raw: unknown = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid.json'), 'utf8'));
      const parsed = safeParseAppSpec(raw);
      assert.equal(parsed.success, false);
    });
  });

  describe('sérialisation', () => {
    it('échappe ce qu’une concaténation de chaînes casserait', () => {
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

      const manifests = renderManifests({ spec, appSlug: 'echappement' });
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

    it('résiste aux pièges de l’analyseur YAML 1.1 de Kubernetes', () => {
      // L'API Kubernetes lit le YAML en 1.1 : `y`, `no`, `on`, `off` y sont des
      // booléens et `12:30` un sexagésimal. Un `stringData` non protégé se fait
      // alors rejeter — « cannot unmarshal bool into Go struct field ».
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
        spec,
        appSlug: 'pieges',
        secretValues: { MOT_DE_PASSE: 'y' },
      });

      const configMap = manifests.find((manifest) => manifest.kind === 'ConfigMap');
      const secret = manifests.find((manifest) => manifest.kind === 'Secret');
      assert.ok(configMap && secret);

      // On relit comme Kubernetes le ferait, pas comme YAML 1.2 le ferait.
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

    it('assainit une version que Kubernetes refuserait comme label', () => {
      assert.equal(labelSafe('2.3.1'), '2.3.1');
      assert.equal(labelSafe('1.0.0+build.5'), '1.0.0_build.5');
      assert.equal(labelSafe('1.0.0-rc.1+exp.sha.5114f85'), '1.0.0-rc.1_exp.sha.5114f85');
    });

    it('reste déterministe', () => {
      const spec = fixture('fullstack');
      const values = {
        DATABASE_PASSWORD: 'p4ss',
        JWT_SECRET: 'jwt',
        POSTGRES_PASSWORD: 'pg',
      };
      const once = renderFiles({ spec, appSlug: spec.name, secretValues: values }).map(
        (file) => file.content,
      );
      const twice = renderFiles({ spec, appSlug: spec.name, secretValues: values }).map(
        (file) => file.content,
      );
      assert.deepEqual(once, twice);
    });
  });

  /**
   * Le test qui garantit la règle 1 de CLAUDE.md sur les alias : la résolution
   * a lieu dans le code neutre, donc les deux rendus reçoivent **la même carte
   * complète**. Compose aurait su interpoler `${MARIADB_PASSWORD}` depuis le
   * `.env` ; Kubernetes n'interpole rien. Écrire l'alias côté runtime aurait
   * fait marcher la même AppSpec d'un côté seulement.
   */
  describe('alias de secret — parité Docker / K3s', () => {
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

    it('le Secret K8s du service applicatif porte le nom aliasé et la valeur de la racine', () => {
      const manifests = renderManifests({ spec, appSlug: spec.name, secretValues });
      const secret = manifests.find(
        (manifest): manifest is SecretManifest =>
          manifest.kind === 'Secret' && manifest.metadata.name === 'web-secrets',
      );
      assert.ok(secret);
      assert.deepEqual(secret.stringData, { WORDPRESS_DB_PASSWORD: 'valeur-partagee' });
    });

    it('le `.env` Docker porte les deux noms avec la même valeur', () => {
      const files = renderComposeFiles({ spec, appSlug: spec.name, publishedPort: null, secretValues });
      const env = files.find((file) => file.path === '.env');
      assert.ok(env);
      assert.match(env.content, /^WORDPRESS_DB_PASSWORD=valeur-partagee$/m);
      assert.match(env.content, /^MARIADB_PASSWORD=valeur-partagee$/m);
    });

    it('les deux rendus partent de la même carte, alias compris', () => {
      const complete = completeSecretValues(spec, secretValues);
      assert.deepEqual(complete, {
        WORDPRESS_DB_PASSWORD: 'valeur-partagee',
        MARIADB_PASSWORD: 'valeur-partagee',
        MARIADB_ROOT_PASSWORD: 'root',
      });
    });
  });

  /**
   * Le durcissement se décide sur ce que l'on connaît de l'image, pas sur une
   * règle uniforme. Ces cas figent la décision champ par champ : c'est du rendu
   * pur, donc vérifiable sans cluster — alors que la panne qu'ils préviennent,
   * elle, ne se voyait qu'au démarrage d'un pod.
   */
  describe('securityContext selon le type de source', () => {
    /** Une AppSpec minimale portant les deux régimes côte à côte. */
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
    const manifests = renderManifests({ spec, appSlug: spec.name });
    const own = deploymentOf(manifests, 'web').spec.template.spec;
    const third = deploymentOf(manifests, 'db').spec.template.spec;

    it('impose l’identité d’exécution à une image que nous construisons', () => {
      assert.deepEqual(own.securityContext, {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      });
    });

    it('ne l’impose pas à une image tierce : on ignore sous quel compte elle tourne', () => {
      assert.equal(third.securityContext.runAsNonRoot, undefined);
      assert.equal(third.securityContext.runAsUser, undefined);
      assert.equal(third.securityContext.runAsGroup, undefined);
    });

    it('garde `fsGroup` dans les deux cas : il possède le volume, pas le processus', () => {
      assert.equal(own.securityContext.fsGroup, 1000);
      assert.equal(
        third.securityContext.fsGroup,
        1000,
        'le retirer rendrait un PVC neuf (root:root 0755) illisible en non-root',
      );
    });

    it('garde `seccompProfile` dans les deux cas : il ne dépend d’aucune identité', () => {
      assert.deepEqual(own.securityContext.seccompProfile, { type: 'RuntimeDefault' });
      assert.deepEqual(third.securityContext.seccompProfile, { type: 'RuntimeDefault' });
    });

    it('interdit privilège et élévation dans les deux cas', () => {
      for (const pod of [own, third]) {
        assert.equal(pod.containers[0]?.securityContext.privileged, false);
        assert.equal(pod.containers[0]?.securityContext.allowPrivilegeEscalation, false);
      }
    });

    it('retire toutes les capacités à nos images, et rend le strict nécessaire aux autres', () => {
      assert.deepEqual(own.containers[0]?.securityContext.capabilities, { drop: ['ALL'] });
      // Mesuré : sans ces cinq-là, `nginx` échoue sur `chown` et `postgres` sur
      // `chmod` — leur point d'entrée démarre root puis abandonne ses privilèges.
      assert.deepEqual(third.containers[0]?.securityContext.capabilities, {
        drop: ['ALL'],
        add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
      });
    });

    it('n’accorde jamais les capacités que Docker donne pourtant par défaut', () => {
      const granted = third.containers[0]?.securityContext.capabilities.add ?? [];
      for (const forbidden of ['NET_RAW', 'MKNOD', 'SYS_CHROOT', 'SETPCAP', 'SETFCAP', 'KILL']) {
        assert.ok(!granted.includes(forbidden), `${forbidden} ne doit pas être accordée`);
      }
    });

    it('ne verrouille la racine que sur nos images', () => {
      assert.equal(own.containers[0]?.securityContext.readOnlyRootFilesystem, true);
      assert.equal(third.containers[0]?.securityContext.readOnlyRootFilesystem, false);
    });

    it('ne sérialise aucun champ d’identité vide pour une image tierce', () => {
      const deployment = manifests.find(
        (manifest) => manifest.kind === 'Deployment' && manifest.metadata.name === 'db',
      );
      assert.ok(deployment);
      const yaml = serializeManifest(deployment);
      // `runAsUser: null` serait refusé par l'API : le champ doit être absent.
      assert.ok(!yaml.includes('runAsUser'), yaml);
      assert.ok(!yaml.includes('runAsNonRoot'), yaml);
      assert.ok(!yaml.includes('runAsGroup'), yaml);
      assert.match(yaml, /fsGroup: 1000/);
    });

    it('les manifests restent valides pour Kubernetes', { skip: !kubectlAvailable }, () => {
      const output = validateWithKubectl(spec);
      assert.match(output, /deployment\.apps\/db/);
      assert.match(output, /deployment\.apps\/web/);
    });
  });
});

/**
 * Le constructeur d'images.
 *
 * Ce qui est vérifié ici n'est pas « BuildKit fonctionne » — cela se prouve sur
 * un vrai cluster, par `pnpm test:parity` — mais que les quelques décisions dont
 * dépend le fonctionnement sont bien celles qu'on croit, et qu'un refactor ne
 * les défera pas en silence.
 */
describe('constructeur d’images K3s', () => {
  const deploymentManifest = parseYaml(builderDeploymentManifest()) as {
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

  it('exécute runc dans le pod, pas via le containerd du nœud', () => {
    // Le worker containerd exigerait `mountPropagation: Bidirectional` et donc
    // une racine de nœud en montage partagé — ce qu'on ne peut pas supposer.
    assert.ok(container.args.includes('--oci-worker=true'));
    assert.ok(container.args.includes('--containerd-worker=false'));
  });

  it('n’a aucun volume hôte : le nœud ne lui prête ni socket ni chemin', () => {
    assert.ok(
      !builderDeploymentManifest().includes('hostPath'),
      'un hostPath rendrait le constructeur dépendant de la topologie du nœud',
    );
  });

  it('reste supprimable depuis l’écran des charges', () => {
    // Voir `builder.ts` : le label `managed-by` ferait refuser sa suppression
    // en renvoyant vers un déploiement qui n'existe pas.
    assert.equal(deploymentManifest.metadata.labels['app.kubernetes.io/managed-by'], undefined);
  });

  it('se remplace sans se chevaucher : deux buildkitd se disputeraient le verrou', () => {
    assert.equal(deploymentManifest.spec.strategy.type, 'Recreate');
  });

  it('épingle la version du constructeur', () => {
    assert.equal(container.image, BUILDKIT_IMAGE);
    assert.match(container.image, /:v\d+\.\d+\.\d+$/);
  });

  it('assume le privilège, que le preflight fait valider par l’admission', () => {
    assert.equal(container.securityContext.privileged, true);
  });

  it('importe dans l’espace de noms k8s.io, seul visible du kubelet', () => {
    assert.match(importCommand(), /k3s ctr -n k8s\.io images import -/);
  });

  it('n’expose au constructeur que le contexte du service construit', () => {
    const command = pushContextCommand('/opt/bootstrap/apps/boutique/2.3.1/api');
    assert.match(command, /^tar -C '\/opt\/bootstrap\/apps\/boutique\/2\.3\.1\/api' -cf - \./);
    assert.ok(!command.includes('hostPath'));
  });

  it('porte un Dockerfile en sous-répertoire jusqu’à buildctl', () => {
    assert.match(buildCommand('app-boutique/api:2.3.1', 'docker/Dockerfile'), /filename='docker\/Dockerfile'/);
  });

  it('nomme l’image dans le tar OCI : c’est ce nom que containerd reprend', () => {
    assert.match(
      buildCommand('app-boutique/api:2.3.1', 'Dockerfile'),
      /type=oci,name=app-boutique\/api:2\.3\.1,dest=/,
    );
  });

  it('soumet à l’admission un Pod, pas un contrôleur', () => {
    // PodSecurity ne refuse qu'un Pod ; sur un Deployment il se contente d'un
    // avertissement et laisse le code de sortie à 0. Le contrôle porterait
    // alors sur rien.
    const probe = parseYaml(builderAdmissionProbeManifest()) as {
      kind: string;
      spec: { containers: Array<{ securityContext: { privileged: boolean } }> };
    };
    assert.equal(probe.kind, 'Pod');
    assert.equal(probe.spec.containers[0]?.securityContext.privileged, true);
  });

  it('soumet exactement le pod qu’il déploiera, sinon il ne prouve rien', () => {
    const probe = parseYaml(builderAdmissionProbeManifest()) as { spec: unknown };
    assert.deepEqual(probe.spec, deploymentManifest.spec.template.spec);
  });

  it(
    'produit un manifest que Kubernetes accepte',
    { skip: !kubectlAvailable },
    () => {
      const output = execFileSync('kubectl', ['apply', '--dry-run=client', '-f', '-'], {
        input: `${builderNamespaceManifest()}\n---\n${builderDeploymentManifest()}`,
        encoding: 'utf8',
      });
      assert.match(output, /deployment\.apps\/buildkitd/);
    },
  );
});
