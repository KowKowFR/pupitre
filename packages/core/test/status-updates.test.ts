import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INCIDENT_UPDATE_PHASES,
  MAINTENANCE_UPDATE_PHASES,
  ROLE_DEFINITIONS,
  STATUS_UPDATE_MESSAGE_MAX,
  createStatusUpdateSchema,
  isStatusUpdatePhaseFor,
  latestFirst,
  liveTopicOfResource,
  parseStatusUpdateSubjectKey,
  statusNotices,
  statusUpdateSubjectKey,
  suggestedStatusUpdatePhase,
  updateStatusUpdateSchema,
  type PublicStatusUpdate,
} from '../src/index.js';

const INCIDENT = { type: 'incident' as const, id: '6f1c2c1e-6c0a-4b8e-9d55-0d6d3e1b2a40' };
const WINDOW = { type: 'maintenance' as const, id: '0b8e3f7a-2d4c-4a51-8f0e-7c2d1a9b6e33' };

describe('annonces — les phases', () => {
  it('an outage and a maintenance window do not speak with the same words', () => {
    for (const phase of INCIDENT_UPDATE_PHASES) {
      assert.ok(isStatusUpdatePhaseFor('incident', phase));
      assert.ok(
        !isStatusUpdatePhaseFor('maintenance', phase),
        `${phase} is not a maintenance phase`,
      );
    }
    for (const phase of MAINTENANCE_UPDATE_PHASES) {
      assert.ok(isStatusUpdatePhaseFor('maintenance', phase));
      assert.ok(!isStatusUpdatePhaseFor('incident', phase), `one does not “${phase}” an outage`);
    }
  });

  it('the form reuses the last published phase, or the subject’s first', () => {
    assert.equal(suggestedStatusUpdatePhase('incident', null), 'investigating');
    assert.equal(suggestedStatusUpdatePhase('maintenance', null), 'scheduled');
    assert.equal(suggestedStatusUpdatePhase('incident', 'identified'), 'identified');
    // A phase of the other subject is not reused.
    assert.equal(suggestedStatusUpdatePhase('incident', 'in_progress'), 'investigating');
  });
});

describe('announcements — what gets published', () => {
  it('accepts a phase that suits the subject, text cleaned up', () => {
    const input = createStatusUpdateSchema.parse({
      subject: INCIDENT,
      phase: 'identified',
      message: '  La base est saturée ; un correctif part.  ',
    });
    assert.equal(input.message, 'La base est saturée ; un correctif part.');
  });

  it('refuses a phase that does not suit the subject', () => {
    const result = createStatusUpdateSchema.safeParse({
      subject: INCIDENT,
      phase: 'scheduled',
      message: 'Prévue demain.',
    });
    assert.ok(!result.success);
    assert.deepEqual(result.error.issues[0]?.path, ['phase']);
    assert.ok(
      createStatusUpdateSchema.safeParse({ subject: WINDOW, phase: 'completed', message: 'Fini.' })
        .success,
    );
  });

  it('refuses an empty or too long text, and an unknown subject', () => {
    const base = { subject: INCIDENT, phase: 'investigating' };
    assert.ok(!createStatusUpdateSchema.safeParse({ ...base, message: '   ' }).success);
    assert.ok(
      !createStatusUpdateSchema.safeParse({
        ...base,
        message: 'x'.repeat(STATUS_UPDATE_MESSAGE_MAX + 1),
      }).success,
    );
    assert.ok(
      !createStatusUpdateSchema.safeParse({
        ...base,
        subject: { type: 'target', id: INCIDENT.id },
        message: 'Bonjour',
      }).success,
    );
  });

  it('a correction carries at least one field', () => {
    assert.ok(!updateStatusUpdateSchema.safeParse({}).success);
    assert.ok(updateStatusUpdateSchema.safeParse({ message: 'Précision.' }).success);
  });
});

describe('announcements — the subject’s key in an address', () => {
  it('fait l’aller-retour', () => {
    for (const subject of [INCIDENT, WINDOW]) {
      assert.deepEqual(parseStatusUpdateSubjectKey(statusUpdateSubjectKey(subject)), subject);
    }
  });

  it('returns null for what is not a subject', () => {
    for (const key of [
      null,
      '',
      'incident',
      'incident:',
      'cible:' + INCIDENT.id,
      'incident:pas-un-uuid',
    ]) {
      assert.equal(parseStatusUpdateSubjectKey(key), null, String(key));
    }
  });
});

describe('announcements — what a visitor reads', () => {
  const at = (
    iso: string,
    phase: PublicStatusUpdate['phase'] = 'investigating',
  ): PublicStatusUpdate => ({
    phase,
    message: `annonce de ${iso}`,
    at: iso,
  });

  it('the most recent first', () => {
    const sorted = latestFirst([
      at('2026-10-03T10:00:00Z'),
      at('2026-10-03T12:00:00Z'),
      at('2026-10-03T11:00:00Z'),
    ]);
    assert.deepEqual(
      sorted.map((update) => update.at),
      ['2026-10-03T12:00:00Z', '2026-10-03T11:00:00Z', '2026-10-03T10:00:00Z'],
    );
  });

  it('at the top of the page: the last announcement of each ongoing subject, and nothing else', () => {
    const notices = statusNotices([
      // Ongoing, two announcements: only the last one.
      {
        kind: 'incident',
        services: ['Coffre-fort'],
        ongoing: true,
        updates: [at('2026-10-03T10:00:00Z'), at('2026-10-03T10:20:00Z', 'identified')],
      },
      // Closed: it has its place in the incidents, not at the top.
      {
        kind: 'incident',
        services: ['Wiki'],
        ongoing: false,
        updates: [at('2026-10-03T11:00:00Z')],
      },
      // Ongoing, but silent: nothing to say.
      { kind: 'incident', services: ['Forge'], ongoing: true, updates: [] },
      // Ongoing, but on a probe the page does not show.
      { kind: 'incident', services: [], ongoing: true, updates: [at('2026-10-03T11:30:00Z')] },
      {
        kind: 'maintenance',
        services: ['Tableau blanc', 'Coffre-fort'],
        ongoing: true,
        updates: [at('2026-10-03T10:30:00Z', 'in_progress')],
      },
    ]);
    assert.deepEqual(
      notices.map((notice) => [notice.kind, notice.services.join(' + '), notice.update.phase]),
      [
        ['maintenance', 'Tableau blanc + Coffre-fort', 'in_progress'],
        ['incident', 'Coffre-fort', 'identified'],
      ],
    );
  });
});

describe('announcements — who publishes, and who learns about it', () => {
  it('announcing belongs to the operator, not to the read roles', () => {
    assert.ok(ROLE_DEFINITIONS.operator.permissions.includes('status_page:announce'));
    assert.ok(!ROLE_DEFINITIONS.operator.permissions.includes('status_page:manage'));
    assert.ok(!ROLE_DEFINITIONS.viewer.permissions.includes('status_page:announce'));
    assert.ok(!ROLE_DEFINITIONS.auditor.permissions.includes('status_page:announce'));
    assert.ok(ROLE_DEFINITIONS.admin.permissions.includes('status_page:announce'));
  });

  it('an announcement wakes up the monitoring screens', () => {
    assert.equal(liveTopicOfResource('status_update'), 'monitors');
  });
});
