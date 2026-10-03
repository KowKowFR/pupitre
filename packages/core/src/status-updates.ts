import { z } from 'zod';

/**
 * Les annonces d'une page de statut : des messages datés qu'un humain publie
 * pendant une panne ou une maintenance — « on enquête », « cause identifiée »,
 * « résolu ».
 *
 * Une annonce est **rattachée** à ce qu'elle commente : un incident de sonde,
 * ou une fenêtre de maintenance. Elle n'a pas de vie propre — elle paraît sur
 * les pages qui montrent la sonde touchée, et disparaît avec son sujet. Son
 * texte est écrit pour des inconnus : c'est le seul endroit où une page de
 * statut porte des mots que personne n'a mis dans un libellé.
 *
 * La phase est un mot de la conversation avec les visiteurs, pas un état de la
 * sonde : annoncer « résolu » ne referme pas l'incident, que seule la sonde
 * referme quand elle voit la cible saine.
 */

export const STATUS_UPDATE_SUBJECTS = ['incident', 'maintenance'] as const;
export type StatusUpdateSubjectType = (typeof STATUS_UPDATE_SUBJECTS)[number];

/** Les phases d'une panne, dans l'ordre où elles se suivent d'ordinaire. */
export const INCIDENT_UPDATE_PHASES = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;

/** Les phases d'une maintenance. */
export const MAINTENANCE_UPDATE_PHASES = ['scheduled', 'in_progress', 'completed'] as const;

export const STATUS_UPDATE_PHASES = [
  ...INCIDENT_UPDATE_PHASES,
  ...MAINTENANCE_UPDATE_PHASES,
] as const;
export type StatusUpdatePhase = (typeof STATUS_UPDATE_PHASES)[number];

export const STATUS_UPDATE_MESSAGE_MAX = 2000;

/**
 * Combien de temps une maintenance terminée reste sur une page publique — si
 * elle porte une annonce : sans cela, « terminée » ne serait jamais lu, la
 * fenêtre disparaissant de la page à l'instant où elle finit.
 */
export const ENDED_MAINTENANCE_SHOWN_HOURS = 24;

/** Combien de temps une panne refermée reste proposée à l'annonce : le temps d'écrire « résolu ». */
export const RESOLVED_INCIDENT_ANNOUNCE_DAYS = 7;

/** Les phases qu'un sujet accepte : on ne « planifie » pas une panne. */
export function statusUpdatePhasesFor(type: StatusUpdateSubjectType): readonly StatusUpdatePhase[] {
  return type === 'incident' ? INCIDENT_UPDATE_PHASES : MAINTENANCE_UPDATE_PHASES;
}

export function isStatusUpdatePhaseFor(type: StatusUpdateSubjectType, phase: string): boolean {
  return (statusUpdatePhasesFor(type) as readonly string[]).includes(phase);
}

export const statusUpdateSubjectSchema = z.object({
  type: z.enum(STATUS_UPDATE_SUBJECTS),
  id: z.string().uuid(),
});
export type StatusUpdateSubject = z.infer<typeof statusUpdateSubjectSchema>;

/** Du texte brut : les retours à la ligne sont gardés, aucun HTML n'est interprété. */
export const statusUpdateMessageSchema = z.string().trim().min(1).max(STATUS_UPDATE_MESSAGE_MAX);

export const createStatusUpdateSchema = z
  .object({
    subject: statusUpdateSubjectSchema,
    phase: z.enum(STATUS_UPDATE_PHASES),
    message: statusUpdateMessageSchema,
  })
  .refine((input) => isStatusUpdatePhaseFor(input.subject.type, input.phase), {
    message: 'cette phase ne convient pas à ce sujet',
    path: ['phase'],
  });
export type CreateStatusUpdateInput = z.infer<typeof createStatusUpdateSchema>;

/** Corriger une annonce : sa phase ou son texte. Le sujet, lui, ne change pas. */
export const updateStatusUpdateSchema = z
  .object({
    phase: z.enum(STATUS_UPDATE_PHASES).optional(),
    message: statusUpdateMessageSchema.optional(),
  })
  .refine((patch) => patch.phase !== undefined || patch.message !== undefined, {
    message: 'rien à modifier',
  });
export type UpdateStatusUpdateInput = z.infer<typeof updateStatusUpdateSchema>;

/** La clé d'un sujet dans une adresse : `incident:<id>`, `maintenance:<id>`. */
export function statusUpdateSubjectKey(subject: StatusUpdateSubject): string {
  return `${subject.type}:${subject.id}`;
}

export function parseStatusUpdateSubjectKey(
  key: string | null | undefined,
): StatusUpdateSubject | null {
  if (!key) return null;
  const separator = key.indexOf(':');
  if (separator < 0) return null;
  const parsed = statusUpdateSubjectSchema.safeParse({
    type: key.slice(0, separator),
    id: key.slice(separator + 1),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * La phase que le formulaire propose pour l'annonce suivante : celle de la
 * dernière publiée — on précise plus souvent qu'on ne change d'étape —, ou la
 * première du sujet.
 */
export function suggestedStatusUpdatePhase(
  type: StatusUpdateSubjectType,
  latest: StatusUpdatePhase | null,
): StatusUpdatePhase {
  if (latest && isStatusUpdatePhaseFor(type, latest)) return latest;
  return statusUpdatePhasesFor(type)[0]!;
}

// ─── Ce qu'un visiteur lit ────────────────────────────────────────────────────

/** Une annonce telle qu'elle sort sur une page publique : ni auteur, ni identifiant. */
export type PublicStatusUpdate = {
  phase: StatusUpdatePhase;
  message: string;
  at: string;
};

/** Les plus récentes d'abord : c'est la dernière qu'un visiteur cherche. */
export function latestFirst<T extends { at: string }>(updates: readonly T[]): T[] {
  return [...updates].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Ce que le haut d'une page dit d'un sujet en cours : sa dernière annonce. */
export type StatusNotice = {
  kind: StatusUpdateSubjectType;
  services: string[];
  update: PublicStatusUpdate;
};

/**
 * Les annonces à mettre en tête de page : pour chaque sujet **en cours**
 * (panne ouverte, maintenance commencée) qui en porte au moins une, la plus
 * récente. Un sujet sans service visible sur la page n'en a pas : l'annonce
 * commenterait quelque chose que le visiteur ne voit pas.
 */
export function statusNotices(
  subjects: ReadonlyArray<{
    kind: StatusUpdateSubjectType;
    services: readonly string[];
    ongoing: boolean;
    updates: readonly PublicStatusUpdate[];
  }>,
): StatusNotice[] {
  const notices: StatusNotice[] = [];
  for (const subject of subjects) {
    if (!subject.ongoing || subject.services.length === 0) continue;
    const [latest] = latestFirst(subject.updates);
    if (!latest) continue;
    notices.push({ kind: subject.kind, services: [...subject.services], update: latest });
  }
  return notices.sort((a, b) => Date.parse(b.update.at) - Date.parse(a.update.at));
}
