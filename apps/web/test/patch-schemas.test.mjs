import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

/**
 * A change does not fill what it does not say.
 *
 * `.partial()` on a field carrying `.default()` fills it when it is missing: a
 * single-field `PATCH` reset the others to their creation value. The screens send
 * everything, they did not see it; an API token did.
 */
const { applicationSourceCreateSchema, applicationSourcePatchSchema } = await import('@pupitre/db');

describe('repository link — a change', () => {
  it('PATCH { branch } touches neither the spec, nor the mode, nor the targets, nor the activation', () => {
    assert.deepEqual(applicationSourcePatchSchema.parse({ branch: 'develop' }), {
      branch: 'develop',
    });
  });

  it('creation, for its part, keeps its default values', () => {
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
