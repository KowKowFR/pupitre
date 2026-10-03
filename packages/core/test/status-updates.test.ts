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
  it('une panne et une maintenance ne parlent pas avec les mêmes mots', () => {
    for (const phase of INCIDENT_UPDATE_PHASES) {
      assert.ok(isStatusUpdatePhaseFor('incident', phase));
      assert.ok(
        !isStatusUpdatePhaseFor('maintenance', phase),
        `${phase} n'est pas une phase de maintenance`,
      );
    }
    for (const phase of MAINTENANCE_UPDATE_PHASES) {
      assert.ok(isStatusUpdatePhaseFor('maintenance', phase));
      assert.ok(!isStatusUpdatePhaseFor('incident', phase), `on ne « ${phase} » pas une panne`);
    }
  });

  it('le formulaire reprend la dernière phase publiée, ou la première du sujet', () => {
    assert.equal(suggestedStatusUpdatePhase('incident', null), 'investigating');
    assert.equal(suggestedStatusUpdatePhase('maintenance', null), 'scheduled');
    assert.equal(suggestedStatusUpdatePhase('incident', 'identified'), 'identified');
    // Une phase de l'autre sujet ne se reprend pas.
    assert.equal(suggestedStatusUpdatePhase('incident', 'in_progress'), 'investigating');
  });
});

describe('annonces — ce qui se publie', () => {
  it('accepte une phase qui convient au sujet, texte nettoyé', () => {
    const input = createStatusUpdateSchema.parse({
      subject: INCIDENT,
      phase: 'identified',
      message: '  La base est saturée ; un correctif part.  ',
    });
    assert.equal(input.message, 'La base est saturée ; un correctif part.');
  });

  it('refuse une phase qui ne convient pas au sujet', () => {
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

  it('refuse un texte vide ou trop long, et un sujet inconnu', () => {
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

  it('une correction porte au moins un champ', () => {
    assert.ok(!updateStatusUpdateSchema.safeParse({}).success);
    assert.ok(updateStatusUpdateSchema.safeParse({ message: 'Précision.' }).success);
  });
});

describe('annonces — la clé du sujet dans une adresse', () => {
  it('fait l’aller-retour', () => {
    for (const subject of [INCIDENT, WINDOW]) {
      assert.deepEqual(parseStatusUpdateSubjectKey(statusUpdateSubjectKey(subject)), subject);
    }
  });

  it('rend null pour ce qui n’est pas un sujet', () => {
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

describe('annonces — ce qu’un visiteur lit', () => {
  const at = (
    iso: string,
    phase: PublicStatusUpdate['phase'] = 'investigating',
  ): PublicStatusUpdate => ({
    phase,
    message: `annonce de ${iso}`,
    at: iso,
  });

  it('la plus récente d’abord', () => {
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

  it('en tête de page : la dernière annonce de chaque sujet en cours, et rien d’autre', () => {
    const notices = statusNotices([
      // En cours, deux annonces : la dernière seulement.
      {
        kind: 'incident',
        services: ['Coffre-fort'],
        ongoing: true,
        updates: [at('2026-10-03T10:00:00Z'), at('2026-10-03T10:20:00Z', 'identified')],
      },
      // Refermée : elle a sa place dans les incidents, pas en tête.
      {
        kind: 'incident',
        services: ['Wiki'],
        ongoing: false,
        updates: [at('2026-10-03T11:00:00Z')],
      },
      // En cours, mais muette : rien à dire.
      { kind: 'incident', services: ['Forge'], ongoing: true, updates: [] },
      // En cours, mais sur une sonde que la page ne montre pas.
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

describe('annonces — qui publie, et qui l’apprend', () => {
  it('annoncer revient à l’opérateur, pas aux rôles de lecture', () => {
    assert.ok(ROLE_DEFINITIONS.operator.permissions.includes('status_page:announce'));
    assert.ok(!ROLE_DEFINITIONS.operator.permissions.includes('status_page:manage'));
    assert.ok(!ROLE_DEFINITIONS.viewer.permissions.includes('status_page:announce'));
    assert.ok(!ROLE_DEFINITIONS.auditor.permissions.includes('status_page:announce'));
    assert.ok(ROLE_DEFINITIONS.admin.permissions.includes('status_page:announce'));
  });

  it('une annonce réveille les écrans de la supervision', () => {
    assert.equal(liveTopicOfResource('status_update'), 'monitors');
  });
});
