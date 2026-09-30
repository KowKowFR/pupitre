import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isChatEmoji } from '@pupitre/core';
import { EMOJI_GROUPS, QUICK_REACTIONS } from '../src/lib/emoji.ts';

/**
 * La discussion : ce que l'écran propose, le serveur doit l'accepter. Un
 * emoji du sélecteur refusé à l'envoi serait une réaction qui échoue sans
 * que personne ne comprenne pourquoi.
 */
describe('emojis de la discussion', () => {
  it('ne propose que des emojis que le serveur accepte', () => {
    const offered = [...QUICK_REACTIONS, ...EMOJI_GROUPS.flatMap((group) => group.emojis)];
    const refused = offered.filter((emoji) => !isChatEmoji(emoji));
    assert.deepEqual(refused, []);
  });

  it('ne propose pas deux fois le même emoji dans une famille', () => {
    for (const group of EMOJI_GROUPS) {
      assert.equal(new Set(group.emojis).size, group.emojis.length, group.key);
    }
  });
});
