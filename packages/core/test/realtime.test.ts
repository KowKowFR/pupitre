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
 * Le temps réel : ce que la pastille affiche, ce qu'une tâche réveille, et
 * comment un message garde ses mentions.
 */

const NOW = 1_800_000_000_000;

describe('présence', () => {
  const base = { connections: 1, lastSeen: NOW - 1_000, lastInput: NOW - 5_000, choice: null } as const;

  it('est en ligne quand un onglet est ouvert et actif', () => {
    assert.equal(effectivePresence(base, NOW), 'online');
  });

  it('passe absente sans interaction depuis un moment, ou quand on le choisit', () => {
    assert.equal(effectivePresence({ ...base, lastInput: NOW - PRESENCE_IDLE_MS - 1 }, NOW), 'away');
    assert.equal(effectivePresence({ ...base, lastInput: null }, NOW), 'away');
    assert.equal(effectivePresence({ ...base, choice: 'away' }, NOW), 'away');
  });

  it("« ne pas déranger » l'emporte sur l'activité", () => {
    assert.equal(effectivePresence({ ...base, lastInput: null, choice: 'busy' }, NOW), 'busy');
  });

  it("est hors ligne sans onglet ouvert, quel que soit le choix", () => {
    assert.equal(effectivePresence({ ...base, connections: 0, choice: 'busy' }, NOW), 'offline');
    assert.equal(effectivePresence({ ...base, lastSeen: null }, NOW), 'offline');
  });

  it('est hors ligne quand le dernier signe de vie est trop ancien (processus tué)', () => {
    assert.equal(
      effectivePresence({ ...base, lastSeen: NOW - PRESENCE_STALE_MS - 1 }, NOW),
      'offline',
    );
  });
});

describe('sujets en direct', () => {
  it('réveille les écrans concernés par une tâche', () => {
    assert.equal(liveTopicOfJob('deployment:run'), 'deployments');
    assert.equal(liveTopicOfJob('source:deploy'), 'deployments');
    assert.equal(liveTopicOfJob('target:preflight'), 'targets');
    assert.equal(liveTopicOfJob('monitor:sweep'), 'monitors');
    assert.equal(liveTopicOfJob('target:preflight:all'), 'jobs');
    assert.equal(liveTopicOfJob('health:periodic'), 'jobs');
  });

  it("ignore les tâches qui ne changent rien à l'écran", () => {
    assert.equal(liveTopicOfJob('app:logs'), null);
    assert.equal(liveTopicOfJob('workload:list'), null);
    assert.equal(liveTopicOfJob('ping'), null);
  });

  it('associe une ligne du journal à son sujet', () => {
    assert.equal(liveTopicOfResource('application_source'), 'applications');
    assert.equal(liveTopicOfResource('session'), null);
  });
});

describe('messages', () => {
  const body = `Qui regarde ${mentionToken('target', 'prod-1-id')} ? ${mentionToken('user', 'u1')} ${mentionToken('user', 'u1')}`;

  it('découpe le corps en texte et mentions', () => {
    assert.deepEqual(parseChatBody(body), [
      { type: 'text', text: 'Qui regarde ' },
      { type: 'mention', kind: 'target', id: 'prod-1-id' },
      { type: 'text', text: ' ? ' },
      { type: 'mention', kind: 'user', id: 'u1' },
      { type: 'text', text: ' ' },
      { type: 'mention', kind: 'user', id: 'u1' },
    ]);
  });

  it('liste les mentions sans doublon', () => {
    assert.deepEqual(mentionedIn(body), [
      { kind: 'target', id: 'prod-1-id' },
      { kind: 'user', id: 'u1' },
    ]);
  });

  it("neutralise les mentions que l'auteur ne pouvait pas poser", () => {
    const kept = keepMentions(body, [{ kind: 'user', id: 'u1', label: 'camille' }]);
    assert.equal(kept, 'Qui regarde @? ? <@user:u1> <@user:u1>');
  });

  it('rend un aperçu en texte brut', () => {
    assert.equal(
      chatPlainText(body, [
        { kind: 'target', id: 'prod-1-id', label: 'prod-1' },
        { kind: 'user', id: 'u1', label: 'camille' },
      ]),
      'Qui regarde @prod-1 ? @camille @camille',
    );
  });

  it("ne prend pas pour une mention ce qui n'en a que l'air", () => {
    assert.deepEqual(parseChatBody('<@disk:x> et <@user:>'), [
      { type: 'text', text: '<@disk:x> et <@user:>' },
    ]);
  });
});

describe('réactions', () => {
  it('accepte un emoji, avec ses variantes', () => {
    for (const emoji of ['👍', '❤️', '👍🏽', '🧑‍💻', '🇫🇷', '✅', '🚀', '#️⃣']) {
      assert.equal(isChatEmoji(emoji), true, emoji);
    }
  });

  it('refuse le texte, même mêlé à un emoji', () => {
    for (const value of ['', 'ok', '👍 bien', 'a👍', '<script>', '1', ' 👍']) {
      assert.equal(isChatEmoji(value), false, JSON.stringify(value));
    }
  });
});

describe('événements', () => {
  it('refuse un événement mal formé', () => {
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
