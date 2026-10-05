import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isChatEmoji } from '@pupitre/core';
import { EMOJI_GROUPS, QUICK_REACTIONS } from '../src/lib/emoji.ts';

/**
 * The chat: what the screen offers, the server must accept. An emoji of the
 * picker refused at sending would be a reaction that fails without anyone
 * understanding why.
 */
describe('chat emojis', () => {
  it('only offers emojis the server accepts', () => {
    const offered = [...QUICK_REACTIONS, ...EMOJI_GROUPS.flatMap((group) => group.emojis)];
    const refused = offered.filter((emoji) => !isChatEmoji(emoji));
    assert.deepEqual(refused, []);
  });

  it('does not offer the same emoji twice in a family', () => {
    for (const group of EMOJI_GROUPS) {
      assert.equal(new Set(group.emojis).size, group.emojis.length, group.key);
    }
  });
});
