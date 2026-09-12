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
 * Valeurs de complaisance pour tous les secrets déclarés par une fixture.
 * Depuis que le rendu échoue sur un secret non résolu, un test qui n'en fournit
 * aucun testerait l'échec et non le rendu.
 */
function stubSecrets(spec: AppSpec): Record<string, string> {
  const values: Record<string, string> = {};
  // Les racines seulement : un alias n'a pas de valeur à fournir, il reprend
  // celle d'un autre — c'est `completeSecretValues()` qui la lui donne.
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
 * Fait valider le rendu par Docker lui-même. C'est la seule preuve qui compte :
 * un YAML syntaxiquement correct peut rester un Compose invalide.
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

  // Les contextes de build doivent exister pour que `config` les résolve.
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

describe('render() — AppSpec vers Compose', () => {
  describe('simple.json', () => {
    const spec = fixture('simple');
    const file = renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30001 });

    it('nomme le projet app-{slug} et son réseau', () => {
      assert.equal(file.name, 'app-demo-api');
      assert.equal(projectName('demo-api'), 'app-demo-api');
      assert.equal(file.networks?.appnet?.name, networkName('demo-api'));
      assert.equal(file.networks?.appnet?.driver, 'bridge');
    });

    it('publie le port du service exposé', () => {
      assert.deepEqual(file.services.api?.ports, ['30001:80']);
      assert.deepEqual(file.services.api?.expose, ['80']);
    });

    it('décide de la politique de redémarrage, absente de la spec', () => {
      assert.equal(file.services.api?.restart, 'unless-stopped');
    });

    it('traduit les ressources en limites Compose', () => {
      assert.equal(file.services.api?.deploy?.resources?.limits?.cpus, '0.500');
      assert.equal(file.services.api?.deploy?.resources?.limits?.memory, '256M');
    });

    it('produit un compose.yml validé par Docker', { skip: !dockerAvailable }, () => {
      const output = validateWithDockerCompose('simple', spec, 30001);
      const parsed = parseYaml(output) as { name?: string; services?: Record<string, unknown> };
      assert.equal(parsed.name, 'app-demo-api');
      assert.ok(parsed.services?.api);
    });
  });

  describe('fullstack.json', () => {
    const spec = fixture('fullstack');
    const file = renderComposeFile({ spec, appSlug: spec.name, publishedPort: null });

    it('range les services dans l’ordre des dépendances', () => {
      assert.deepEqual(Object.keys(file.services), ['postgres', 'api', 'front']);
    });

    it('traduit dependsOn en depends_on conditionnel', () => {
      assert.deepEqual(file.services.api?.depends_on, {
        postgres: { condition: 'service_healthy' },
      });
      assert.deepEqual(file.services.front?.depends_on, {
        api: { condition: 'service_healthy' },
      });
    });

    it('construit les services à Dockerfile et taggue leur image', () => {
      assert.deepEqual(file.services.api?.build, {
        context: './api',
        dockerfile: 'docker/Dockerfile',
      });
      assert.equal(file.services.api?.image, 'app-boutique/api:2.3.1');
      assert.equal(file.services.postgres?.image, 'postgres:16-alpine', 'image tirée telle quelle');
      assert.equal(file.services.postgres?.build, undefined);
    });

    it('préfixe les volumes nommés pour éviter les collisions', () => {
      assert.deepEqual(file.services.postgres?.volumes, [
        'app-boutique-postgres-data:/var/lib/postgresql/data',
      ]);
      assert.ok(file.volumes?.['app-boutique-postgres-data']);
      assert.ok(file.volumes?.['app-boutique-api-uploads']);
    });

    it('n’inscrit jamais la valeur d’un secret dans le compose.yml', () => {
      const yaml = serializeComposeFile(file);
      for (const secret of ['DATABASE_PASSWORD', 'JWT_SECRET', 'POSTGRES_PASSWORD']) {
        assert.ok(!yaml.includes(`${secret}:`), `${secret} ne doit pas être une clé du compose`);
      }
      assert.deepEqual(file.services.api?.env_file, ['./.env']);
      assert.equal(file.services.front?.env_file, undefined, 'front ne déclare aucun secret');
    });

    it('génère un .env en 0600 avec les noms déclarés', () => {
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

    it('ne publie aucun port quand le service exposé a plusieurs répliques', () => {
      assert.equal(file.services.front?.ports, undefined);
      assert.equal(file.services.front?.deploy?.replicas, 2);
    });

    it('sonde le service exposé en HTTP, les autres en TCP', () => {
      const front = file.services.front?.healthcheck?.test.join(' ') ?? '';
      assert.match(front, /wget --spider .*\/healthz/);
      const postgres = file.services.postgres?.healthcheck?.test.join(' ') ?? '';
      assert.match(postgres, /nc -z -w \d+ 127\.0\.0\.1 5432/);
      // Ni `wget`, ni `curl` : un repli HTTP sur un service qui ne parle pas
      // HTTP n'aboutit jamais, et masquait l'échec réel.
      assert.doesNotMatch(postgres, /wget|curl/);
    });

    it('sonde en TCP sans dépendre de `nc`, absent des images Debian', () => {
      // `postgres:16` et `mariadb:11` n'embarquent ni `nc`, ni `wget`, ni
      // `curl` — seulement `bash`. Sans ce repli, leur sonde échouait à vie et
      // le `depends_on: service_healthy` du service applicatif bloquait avec.
      const postgres = file.services.postgres?.healthcheck?.test.join(' ') ?? '';
      assert.match(postgres, /bash -c 'exec 3<>\/dev\/tcp\/127\.0\.0\.1\/5432'/);
    });

    it('refuse de rendre un secret déclaré sans valeur résolue, en le nommant', () => {
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

    it('accepte un secret délibérément vide — absent n’est pas vide', () => {
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

    it('produit un compose.yml validé par Docker', { skip: !dockerAvailable }, () => {
      const output = validateWithDockerCompose('fullstack', spec, null);
      const parsed = parseYaml(output) as { services?: Record<string, unknown> };
      assert.deepEqual(Object.keys(parsed.services ?? {}).sort(), ['api', 'front', 'postgres']);
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

      const yaml = serializeComposeFile(renderComposeFile({ spec, appSlug: 'echappement', publishedPort: 30002 }));
      const parsed = parseYaml(yaml) as {
        services: { web: { environment: Record<string, string> } };
      };

      assert.equal(parsed.services.web.environment.QUOTED, 'valeur avec "guillemets" et \'apostrophes\'');
      assert.equal(parsed.services.web.environment.MULTILINE, 'première ligne\nseconde ligne');
      assert.equal(parsed.services.web.environment.YAML_TRAP, '*ancre: &pas-une-ancre');
      assert.equal(parsed.services.web.environment.COLON, 'clé: valeur');
    });

    it('reste déterministe', () => {
      const spec = fixture('fullstack');
      const once = serializeComposeFile(renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30003 }));
      const twice = serializeComposeFile(renderComposeFile({ spec, appSlug: spec.name, publishedPort: 30003 }));
      assert.equal(once, twice);
    });
  });
});

/**
 * Contexte de sécurité.
 *
 * Chaque cas fige une décision mesurée sur la cible de test, pas une intention :
 * ce qui est durci l'est parce qu'on a vu l'image démarrer avec, et ce qui ne
 * l'est pas l'est parce qu'on a vu l'image mourir sans.
 */
describe('contexte de sécurité', () => {
  const fullstack = fixture('fullstack');
  const file = renderComposeFile({
    spec: fullstack,
    appSlug: fullstack.name,
    publishedPort: null,
  });

  // `front`   : image à nous, aucun volume  → identité imposée
  // `api`     : image à nous, un volume     → identité laissée à l'image
  // `postgres`: image tierce                → rien d'imposé du tout
  const own = file.services.front;
  const ownWithVolume = file.services.api;
  const thirdParty = file.services.postgres;

  it('interdit l’élévation de privilèges partout — Docker ne le fait pas seul', () => {
    // Sans l'option, `NoNewPrivs` vaut 0 dans un conteneur Docker : c'est le
    // seul de ces champs qui ne soit pas déjà couvert par un défaut du runtime.
    for (const service of [own, ownWithVolume, thirdParty]) {
      assert.deepEqual(service?.security_opt, ['no-new-privileges:true']);
    }
  });

  it('part de zéro sur les capacités, sur tous les services', () => {
    for (const service of [own, ownWithVolume, thirdParty]) {
      assert.deepEqual(service?.cap_drop, ['ALL']);
    }
  });

  it('ne rend aucune capacité à une image dont on fixe l’uid', () => {
    // Elle ne démarre jamais root : elle n'a rien à préparer avant de se
    // dégrader, donc rien à réclamer.
    assert.equal(own?.cap_add, undefined);
  });

  it('rend cinq capacités à toute image qui garde son identité', () => {
    // Mesuré : `cap_drop: ALL` seul tue `nginx` sur chown(/var/cache/nginx) et
    // `postgres` sur chmod(/var/run/postgresql). Cinq, et pas une de plus —
    // `NET_BIND_SERVICE` notamment, inutile puisque Docker pose
    // `net.ipv4.ip_unprivileged_port_start=0` dans le conteneur.
    for (const service of [ownWithVolume, thirdParty]) {
      assert.deepEqual(service?.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']);
    }
  });

  it('impose l’uid non privilégié à nos images sans volume', () => {
    assert.equal(own?.user, '1000:1000');
  });

  it('ne l’impose pas à nos images qui déclarent un volume — Compose n’a pas de fsGroup', () => {
    // Un volume nommé neuf est `root:root 0755` et le reste : un conteneur en
    // uid 1000 démarrerait puis échouerait à la première écriture. Le point
    // d'entrée de l'image fait ce que `fsGroup` ferait côté K3s — avec les cinq
    // capacités qu'on vient de lui rendre.
    assert.equal(ownWithVolume?.user, undefined);
  });

  it('n’impose jamais d’uid à une image tierce', () => {
    assert.equal(thirdParty?.user, undefined);
  });

  it('met la racine en lecture seule sur nos images seulement', () => {
    // Y compris celle qui porte un volume : le volume reste inscriptible.
    assert.equal(own?.read_only, true);
    assert.equal(ownWithVolume?.read_only, true);
    // Mesuré : `nginx` en lecture seule meurt sur
    // `mkdir() "/var/cache/nginx/client_temp" failed (30: Read-only file system)`.
    assert.equal(thirdParty?.read_only, undefined);
  });

  it('ouvre un /tmp inscriptible et exécutable là où la racine est verrouillée', () => {
    // `exec` est explicite : le tmpfs de Docker est `noexec` par défaut, pas
    // l'`emptyDir` que le rendu K3s monte au même endroit. Sans lui, la même
    // AppSpec se comporterait différemment sur les deux runtimes.
    assert.deepEqual(own?.tmpfs, ['/tmp:exec,mode=1777']);
    assert.deepEqual(ownWithVolume?.tmpfs, ['/tmp:exec,mode=1777']);
    assert.equal(thirdParty?.tmpfs, undefined, 'pas de racine verrouillée, pas de scratch');
  });

  it('ne déclare aucun profil seccomp : celui de Docker est déjà appliqué', () => {
    // `docker info` → `name=seccomp,profile=builtin`, et `/proc/1/status` rend
    // `Seccomp: 2` sans qu'on demande rien. C'est le `RuntimeDefault` du rendu
    // K3s sous un autre nom ; la seule chose que Compose saurait déclarer ici
    // (`seccomp:unconfined`) l'affaiblirait.
    for (const service of [own, ownWithVolume, thirdParty]) {
      for (const option of service?.security_opt ?? []) {
        assert.doesNotMatch(option, /seccomp/);
      }
    }
  });

  it('ne monte pas de scratch quand la spec occupe déjà /tmp', () => {
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
    // Un volume est déclaré : l'uid reste celui de l'image.
    assert.equal(rendered.services.app?.user, undefined);
  });

  it('produit un compose.yml que Docker accepte', { skip: !dockerAvailable }, () => {
    const output = validateWithDockerCompose('securite', fullstack, null);
    const parsed = parseYaml(output) as {
      services: Record<string, Record<string, unknown>>;
    };
    // C'est `docker compose config` qui parle ici : les champs survivent à la
    // normalisation du schéma, `tmpfs` avec ses options comprise.
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
