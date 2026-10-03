import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * Une modification ne remplit pas ce qu'elle ne dit pas.
 *
 * `.partial()` sur un champ porteur de `.default()` le remplit quand il
 * manque : un `PATCH` d'un seul champ remettait les autres à leur valeur de
 * création. Les écrans envoient tout, ils ne le voyaient pas ; un jeton d'API,
 * si.
 */
const { applicationSourceCreateSchema, applicationSourcePatchSchema } = await import('@pupitre/db');

describe('liaison de dépôt — une modification', () => {
  it('PATCH { branch } ne touche ni la spec, ni le mode, ni les cibles, ni l’activation', () => {
    assert.deepEqual(applicationSourcePatchSchema.parse({ branch: 'develop' }), {
      branch: 'develop',
    });
  });

  it('la création, elle, garde ses valeurs par défaut', () => {
    const source = applicationSourceCreateSchema.parse({
      repository: 'atelier/wiki',
      branch: 'main',
      deployTo: 'none',
    });
    assert.equal(source.provider, 'github');
    assert.equal(source.specPath, 'pupitre.json');
    assert.equal(source.enabled, true);
    assert.deepEqual(source.targets, []);
  });
});
