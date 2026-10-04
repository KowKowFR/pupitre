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
 * The catalog: each template must return a valid AppSpec, with and without a
 * domain — otherwise installing fails in front of the operator, or worse, the
 * deployment fails on a target.
 */

const WITH_HOST: CatalogParams = {
  name: 'outil',
  host: 'outil.exemple.net',
  tls: true,
  email: 'camille@atelier-nord.fr',
};
const WITHOUT_HOST: CatalogParams = { ...WITH_HOST, host: null };

describe('catalog', () => {
  it('gives each template a unique identifier, in kebab-case', () => {
    const ids = CATALOG_TEMPLATES.map((template) => template.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, SERVICE_NAME_PATTERN);
  });

  it('puts each template in a known category, with its texts in both languages', () => {
    for (const template of CATALOG_TEMPLATES) {
      assert.ok(CATALOG_CATEGORIES.includes(template.category), template.id);
      for (const text of [template.summary, template.firstRun]) {
        assert.ok(text.fr.trim().length > 0, `${template.id}: fr missing`);
        assert.ok(text.en.trim().length > 0, `${template.id}: en missing`);
      }
      assert.match(template.website, /^https:\/\//, template.id);
    }
  });

  for (const template of CATALOG_TEMPLATES) {
    describe(template.id, () => {
      it('returns a valid AppSpec with a domain, and the ingress that goes with it', () => {
        const spec = instantiateCatalogTemplate(template, WITH_HOST);
        assert.equal(spec.name, 'outil');
        assert.deepEqual(spec.ingress, {
          host: 'outil.exemple.net',
          tls: true,
          targetService: exposedService(spec).name,
        });
      });

      it('returns a valid AppSpec without a domain, without an ingress', () => {
        const spec = instantiateCatalogTemplate(template, WITHOUT_HOST);
        assert.equal(spec.ingress, undefined);
        // No variable must carry a made-up URL when there is no domain.
        for (const service of spec.services) {
          for (const [name, value] of Object.entries(service.env)) {
            assert.doesNotMatch(value, /exemple\.net/, `${template.id} ${name}`);
          }
        }
      });

      it('only asks for secrets the spec really declares', () => {
        const declared = new Set(secretNamesOf(instantiateCatalogTemplate(template, WITH_HOST)));
        for (const name of template.askedSecrets) {
          assert.ok(declared.has(name), `${template.id} asks for ${name}, never declared`);
        }
      });

      it('references tagged images', () => {
        const spec = instantiateCatalogTemplate(template, WITH_HOST);
        for (const service of spec.services) {
          if (service.source.type !== 'image') continue;
          assert.match(service.source.ref, /:[\w.-]+$/, `${template.id}/${service.name}`);
        }
      });
    });
  }

  it('finds a template by its identifier', () => {
    assert.equal(findCatalogTemplate('uptime-kuma')?.name, 'Uptime Kuma');
    assert.equal(findCatalogTemplate('inconnu'), null);
  });

  it('validates the install parameters', () => {
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

  it('lets pgAdmin start with a company address in .local', () => {
    // Seen on a real target: without this setting, pgAdmin refuses the address and
    // stops.
    const pgadmin = findCatalogTemplate('pgadmin');
    assert.ok(pgadmin);
    const spec = instantiateCatalogTemplate(pgadmin, { ...WITH_HOST, email: 'admin@corp.local' });
    assert.match(spec.services[0]?.env.PGADMIN_CONFIG_ALLOW_SPECIAL_EMAIL_DOMAINS ?? '', /'local'/);
  });

  it('turns TLS off when there is no domain: there would be nothing to certify', () => {
    const n8n = findCatalogTemplate('n8n');
    assert.ok(n8n);
    const spec = instantiateCatalogTemplate(n8n, { ...WITHOUT_HOST, tls: true });
    assert.equal(spec.services[0]?.env.N8N_SECURE_COOKIE, 'false');
  });
});
