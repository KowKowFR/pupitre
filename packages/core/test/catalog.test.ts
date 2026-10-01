import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CATALOG_CATEGORIES,
  CATALOG_TEMPLATES,
  catalogParamsSchema,
  findCatalogTemplate,
  instantiateCatalogTemplate,
  type CatalogParams,
} from '../src/catalog/index.js';
import { exposedService, secretNamesOf, SERVICE_NAME_PATTERN } from '../src/spec/index.js';

/**
 * Le catalogue : chaque modèle doit rendre une AppSpec valable, avec et sans
 * domaine — sinon l'installation échoue devant l'opérateur, ou pire, le
 * déploiement échoue sur une cible.
 */

const WITH_HOST: CatalogParams = {
  name: 'outil',
  host: 'outil.exemple.net',
  tls: true,
  email: 'camille@atelier-nord.fr',
};
const WITHOUT_HOST: CatalogParams = { ...WITH_HOST, host: null };

describe('catalogue', () => {
  it('donne à chaque modèle un identifiant unique, en kebab-case', () => {
    const ids = CATALOG_TEMPLATES.map((template) => template.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, SERVICE_NAME_PATTERN);
  });

  it('range chaque modèle dans une catégorie connue, avec ses textes dans les deux langues', () => {
    for (const template of CATALOG_TEMPLATES) {
      assert.ok(CATALOG_CATEGORIES.includes(template.category), template.id);
      for (const text of [template.summary, template.firstRun]) {
        assert.ok(text.fr.trim().length > 0, `${template.id} : fr manquant`);
        assert.ok(text.en.trim().length > 0, `${template.id} : en manquant`);
      }
      assert.match(template.website, /^https:\/\//, template.id);
    }
  });

  for (const template of CATALOG_TEMPLATES) {
    describe(template.id, () => {
      it('rend une AppSpec valable avec un domaine, et l’ingress qui va avec', () => {
        const spec = instantiateCatalogTemplate(template, WITH_HOST);
        assert.equal(spec.name, 'outil');
        assert.deepEqual(spec.ingress, {
          host: 'outil.exemple.net',
          tls: true,
          targetService: exposedService(spec).name,
        });
      });

      it('rend une AppSpec valable sans domaine, sans ingress', () => {
        const spec = instantiateCatalogTemplate(template, WITHOUT_HOST);
        assert.equal(spec.ingress, undefined);
        // Aucune variable ne doit porter une URL inventée quand il n'y a pas de domaine.
        for (const service of spec.services) {
          for (const [name, value] of Object.entries(service.env)) {
            assert.doesNotMatch(value, /exemple\.net/, `${template.id} ${name}`);
          }
        }
      });

      it('ne demande que des secrets que la spec déclare vraiment', () => {
        const declared = new Set(secretNamesOf(instantiateCatalogTemplate(template, WITH_HOST)));
        for (const name of template.askedSecrets) {
          assert.ok(declared.has(name), `${template.id} demande ${name}, jamais déclaré`);
        }
      });

      it('référence des images étiquetées', () => {
        const spec = instantiateCatalogTemplate(template, WITH_HOST);
        for (const service of spec.services) {
          if (service.source.type !== 'image') continue;
          assert.match(service.source.ref, /:[\w.-]+$/, `${template.id}/${service.name}`);
        }
      });
    });
  }

  it('retrouve un modèle par son identifiant', () => {
    assert.equal(findCatalogTemplate('uptime-kuma')?.name, 'Uptime Kuma');
    assert.equal(findCatalogTemplate('inconnu'), null);
  });

  it('valide les paramètres d’installation', () => {
    assert.deepEqual(
      catalogParamsSchema.parse({
        name: 'kuma',
        host: ' Status.Atelier-Nord.FR ',
        email: 'a@b.fr',
      }),
      { name: 'kuma', host: 'status.atelier-nord.fr', tls: true, email: 'a@b.fr' },
    );
    assert.equal(
      catalogParamsSchema.safeParse({ name: 'kuma', host: 'https://x.fr', email: 'a@b.fr' })
        .success,
      false,
    );
    assert.equal(catalogParamsSchema.safeParse({ name: 'Kuma', email: 'a@b.fr' }).success, false);
  });

  it('laisse pgAdmin démarrer avec une adresse d’entreprise en .local', () => {
    // Vu sur une vraie cible : sans ce réglage, pgAdmin refuse l'adresse et s'arrête.
    const pgadmin = findCatalogTemplate('pgadmin');
    assert.ok(pgadmin);
    const spec = instantiateCatalogTemplate(pgadmin, { ...WITH_HOST, email: 'admin@corp.local' });
    assert.match(spec.services[0]?.env.PGADMIN_CONFIG_ALLOW_SPECIAL_EMAIL_DOMAINS ?? '', /'local'/);
  });

  it('coupe TLS quand il n’y a pas de domaine : il n’y aurait rien à certifier', () => {
    const n8n = findCatalogTemplate('n8n');
    assert.ok(n8n);
    const spec = instantiateCatalogTemplate(n8n, { ...WITHOUT_HOST, tls: true });
    assert.equal(spec.services[0]?.env.N8N_SECURE_COOKIE, 'false');
  });
});
