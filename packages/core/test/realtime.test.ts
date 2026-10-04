import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  chatPlainText,
  isChatEmoji,
  keepMentions,
  mentionToken,
  mentionedIn,
  parseChatBody,
} from '../src/chat.js';
import {
  PRESENCE_IDLE_MS,
  PRESENCE_STALE_MS,
  effectivePresence,
  liveTopicOfJob,
  liveTopicOfResource,
  realtimeEventSchema,
} from '../src/realtime.js';

/**
 * Real time: what the badge shows, what a job wakes up, and how a message keeps
 * its mentions.
 */

const NOW = 1_800_000_000_000;

describe('presence', () => {
  const base = { connections: 1, lastSeen: NOW - 1_000, lastInput: NOW - 5_000, choice: null } as const;

  it('is online when a tab is open and active', () => {
    assert.equal(effectivePresence(base, NOW), 'online');
  });

  it('goes away without interaction for a while, or when one chooses so', () => {
    assert.equal(effectivePresence({ ...base, lastInput: NOW - PRESENCE_IDLE_MS - 1 }, NOW), 'away');
    assert.equal(effectivePresence({ ...base, lastInput: null }, NOW), 'away');
    assert.equal(effectivePresence({ ...base, choice: 'away' }, NOW), 'away');
  });

  it("“do not disturb” wins over activity", () => {
    assert.equal(effectivePresence({ ...base, lastInput: null, choice: 'busy' }, NOW), 'busy');
  });

  it("is offline without an open tab, whatever the choice", () => {
    assert.equal(effectivePresence({ ...base, connections: 0, choice: 'busy' }, NOW), 'offline');
    assert.equal(effectivePresence({ ...base, lastSeen: null }, NOW), 'offline');
  });

  it('is offline when the last sign of life is too old (process killed)', () => {
    assert.equal(
      effectivePresence({ ...base, lastSeen: NOW - PRESENCE_STALE_MS - 1 }, NOW),
      'offline',
    );
  });
});

describe('sujets en direct', () => {
  it('wakes up the screens concerned by a job', () => {
    assert.equal(liveTopicOfJob('deployment:run'), 'deployments');
    assert.equal(liveTopicOfJob('source:deploy'), 'deployments');
    assert.equal(liveTopicOfJob('target:preflight'), 'targets');
    assert.equal(liveTopicOfJob('monitor:sweep'), 'monitors');
    assert.equal(liveTopicOfJob('target:preflight:all'), 'jobs');
    assert.equal(liveTopicOfJob('health:periodic'), 'jobs');
  });

  it("ignores the jobs that change nothing on screen", () => {
    assert.equal(liveTopicOfJob('app:logs'), null);
    assert.equal(liveTopicOfJob('workload:list'), null);
    assert.equal(liveTopicOfJob('ping'), null);
  });

  it('associates a log line with its subject', () => {
    assert.equal(liveTopicOfResource('application_source'), 'applications');
    assert.equal(liveTopicOfResource('session'), null);
  });
});

describe('messages', () => {
  const body = `Qui regarde ${mentionToken('target', 'prod-1-id')} ? ${mentionToken('user', 'u1')} ${mentionToken('user', 'u1')}`;

  it('splits the body into text and mentions', () => {
    assert.deepEqual(parseChatBody(body), [
      { type: 'text', text: 'Qui regarde ' },
      { type: 'mention', kind: 'target', id: 'prod-1-id' },
      { type: 'text', text: ' ? ' },
      { type: 'mention', kind: 'user', id: 'u1' },
      { type: 'text', text: ' ' },
      { type: 'mention', kind: 'user', id: 'u1' },
    ]);
  });

  it('lists the mentions without duplicates', () => {
    assert.deepEqual(mentionedIn(body), [
      { kind: 'target', id: 'prod-1-id' },
      { kind: 'user', id: 'u1' },
    ]);
  });

  it("neutralizes the mentions the author could not set", () => {
    const kept = keepMentions(body, [{ kind: 'user', id: 'u1', label: 'camille' }]);
    assert.equal(kept, 'Qui regarde @? ? <@user:u1> <@user:u1>');
  });

  it('renders a plain-text preview', () => {
    assert.equal(
      chatPlainText(body, [
        { kind: 'target', id: 'prod-1-id', label: 'prod-1' },
        { kind: 'user', id: 'u1', label: 'camille' },
      ]),
      'Qui regarde @prod-1 ? @camille @camille',
    );
  });

  it("does not take for a mention what only looks like one", () => {
    assert.deepEqual(parseChatBody('<@disk:x> et <@user:>'), [
      { type: 'text', text: '<@disk:x> et <@user:>' },
    ]);
  });
});

describe('reactions', () => {
  it('accepts an emoji, with its variants', () => {
    for (const emoji of ['👍', '❤️', '👍🏽', '🧑‍💻', '🇫🇷', '✅', '🚀', '#️⃣']) {
      assert.equal(isChatEmoji(emoji), true, emoji);
    }
  });

  it('refuses text, even mixed with an emoji', () => {
    for (const value of ['', 'ok', '👍 bien', 'a👍', '<script>', '1', ' 👍']) {
      assert.equal(isChatEmoji(value), false, JSON.stringify(value));
    }
  });
});

describe('events', () => {
  it('refuses a malformed event', () => {
    assert.equal(realtimeEventSchema.safeParse({ type: 'presence', userId: 'u1' }).success, false);
    assert.equal(
      realtimeEventSchema.safeParse({
        type: 'live',
        topic: 'deployments',
        source: 'job',
        detail: 'deployment:run',
      }).success,
      true,
    );
  });
});
