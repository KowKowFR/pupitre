import {
  NOTIFICATION_DIGEST_ITEM_LIMIT,
  NOTIFICATION_DIGEST_MAX_ESCALATION,
  NOTIFICATION_DIGEST_WINDOW_MS_DEFAULT,
  notificationDigestWindowMs,
  notificationDigestWindowMsSchema,
  type NotificationDigestItem,
} from '@tp/core';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { getDb, type Database } from './client.js';
import {
  notificationDigestGroups,
  notificationDigestItems,
  notificationPolicy,
} from './schema/notifications.js';

/**
 * L'état de regroupement des notifications — la partie durable du garde-fou de
 * volume.
 *
 * ── L'invariant que ce module tient ─────────────────────────────────────────
 * Pour un groupe donné, à tout instant, **une seule** des deux affirmations est
 * vraie :
 *   — la fenêtre est fermée (`window_ends_at is null`) : la prochaine alerte
 *     part sans délai, et il n'y a rien en attente ;
 *   — la fenêtre est ouverte : aucune alerte de ce groupe ne part, tout est
 *     retenu et nommé, et la fermeture produira exactement un résumé.
 *
 * Passer de l'un à l'autre est une décision, et une décision prise par deux
 * processus à la fois est une décision fausse : deux alertes « premières »
 * partiraient en même temps, ou deux résumés du même orage. D'où le fait que
 * chaque bascule tient dans **une transaction avec `select … for update`** sur
 * la ligne du groupe. L'exclusion est celle de Postgres — pas un verrou
 * applicatif, pas un `if` optimiste. C'est la même règle que l'anti-collision
 * de ports, qui est une contrainte d'unicité et non un test en TypeScript.
 *
 * ── Ce que « survivre à un redémarrage » veut dire ici ──────────────────────
 * Tout ce qui décide vit dans ces deux tables. Le worker n'a aucun état de
 * regroupement en mémoire : il redémarre, relit, et retrouve exactement la
 * fenêtre qu'il avait laissée, avec les événements déjà retenus. Un redémarrage
 * au milieu d'un orage ne relâche donc rien — c'était le risque, et c'est la
 * raison pour laquelle Redis ne convenait pas.
 */

// ─── le réglage ───────────────────────────────────────────────────────────────

export type NotificationDigestPolicy = {
  /** Fenêtre de base, en millisecondes. */
  windowMs: number;
  updatedAt: Date | null;
  updatedBy: string | null;
};

/**
 * Le réglage, ou son défaut.
 *
 * Aucune ligne en base = instance neuve : on rend le défaut plutôt que
 * d'imposer une insertion à l'installation. Même motif que les paramètres
 * d'instance, qui rendent un objet complet sur une base vierge.
 */
export async function getNotificationDigestPolicy(
  db: Database = getDb(),
): Promise<NotificationDigestPolicy> {
  const [row] = await db.select().from(notificationPolicy).where(eq(notificationPolicy.id, 1));
  return {
    windowMs: row?.windowMs ?? NOTIFICATION_DIGEST_WINDOW_MS_DEFAULT,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/**
 * Change la fenêtre de base. La valeur est **bornée par Zod**, côté `@tp/core` :
 * on peut raccourcir le regroupement, jamais le supprimer.
 *
 * Les fenêtres déjà ouvertes gardent leur durée jusqu'à leur fermeture — les
 * raccourcir d'autorité ferait partir un résumé plus tôt que promis par le
 * message précédent, qui annonçait un délai.
 */
export async function setNotificationDigestPolicy(
  windowMs: number,
  actorId: string | null,
  db: Database = getDb(),
): Promise<NotificationDigestPolicy> {
  const value = notificationDigestWindowMsSchema.parse(windowMs);
  const now = new Date();

  await db
    .insert(notificationPolicy)
    .values({ id: 1, windowMs: value, updatedAt: now, updatedBy: actorId })
    .onConflictDoUpdate({
      target: notificationPolicy.id,
      set: { windowMs: value, updatedAt: now, updatedBy: actorId },
    });

  return { windowMs: value, updatedAt: now, updatedBy: actorId };
}

// ─── l'admission : immédiat, ou retenu ────────────────────────────────────────

export type NotificationAdmissionInput = {
  groupKey: string;
  event: string;
  /** La ligne que cet événement occupera dans un résumé, déjà composée. */
  item: NotificationDigestItem;
  /** Injectable pour les vérifications ; `new Date()` en exploitation. */
  now?: Date;
};

export type NotificationAdmission = {
  /** `immediate` : la fenêtre était fermée, le message part. `held` : il est retenu. */
  mode: 'immediate' | 'held';
  windowEndsAt: Date;
  windowMs: number;
  /** Événements retenus dans la fenêtre en cours, celui-ci compris. */
  heldCount: number;
};

/**
 * Décide du sort d'un événement notifiable, et enregistre cette décision.
 *
 * Trois cas, dans cet ordre :
 *
 *   1. **fenêtre fermée** → `immediate`. Le message part sans délai et la
 *      fenêtre s'ouvre. C'est le cas de la panne isolée, et il est *le premier
 *      testé* : rien, jamais, ne retarde la première alerte d'un incident.
 *   2. **fenêtre ouverte** → `held`. L'événement est stocké, nommé.
 *   3. **fenêtre échue mais des retenus attendent** → `held` aussi. Laisser
 *      passer celui-ci en immédiat pendant que quarante autres attendent le
 *      balayage produirait un message unitaire au milieu d'un orage : la
 *      cohérence du résumé passe avant une poignée de secondes.
 *
 * Le stockage des lignes est borné à `NOTIFICATION_DIGEST_ITEM_LIMIT` ; au-delà
 * le compteur continue seul. Le résumé dira combien de lignes il tait — un
 * compteur qui déborde en silence serait exactement le défaut qu'on corrige.
 */
export async function admitNotification(
  input: NotificationAdmissionInput,
  db: Database = getDb(),
): Promise<NotificationAdmission> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const policy = await getNotificationDigestPolicy(tx);

    // Matérialise la ligne du groupe avant de la verrouiller : sur un groupe
    // encore inconnu, un `for update` ne verrouille rien et deux premières
    // alertes concurrentes partiraient toutes les deux.
    await tx
      .insert(notificationDigestGroups)
      .values({ groupKey: input.groupKey, event: input.event, windowMs: policy.windowMs })
      .onConflictDoNothing();

    const [group] = await tx
      .select()
      .from(notificationDigestGroups)
      .where(eq(notificationDigestGroups.groupKey, input.groupKey))
      .for('update');

    if (!group) {
      // Ne devrait pas arriver : l'insertion précède. On ne bloque pas une
      // alerte sur une anomalie de bookkeeping.
      return {
        mode: 'immediate' as const,
        windowEndsAt: new Date(now.getTime() + policy.windowMs),
        windowMs: policy.windowMs,
        heldCount: 0,
      };
    }

    const open = group.windowEndsAt !== null && group.windowEndsAt > now;
    /**
     * Fenêtre échue dont le balayage n'a pas encore pris le contenu. Laisser
     * passer celle-ci en immédiat pendant que quarante autres attendent
     * produirait un message unitaire au milieu d'un orage.
     *
     * Une fenêtre échue et **vide**, elle, vaut fenêtre fermée : l'alerte ne
     * doit pas patienter le temps que le balayage la referme formellement.
     */
    const awaitingSweep = group.windowEndsAt !== null && group.heldCount > 0;

    if (!open && !awaitingSweep) {
      await tx
        .update(notificationDigestGroups)
        .set({
          event: input.event,
          windowStartedAt: now,
          windowEndsAt: new Date(now.getTime() + policy.windowMs),
          windowMs: policy.windowMs,
          escalation: 0,
          heldCount: 0,
          firstHeldAt: null,
          lastHeldAt: null,
          updatedAt: now,
        })
        .where(eq(notificationDigestGroups.groupKey, input.groupKey));

      // Purge défensive : une fenêtre qu'on rouvre ne doit pas hériter de lignes
      // d'un orage précédent mal refermé.
      await tx
        .delete(notificationDigestItems)
        .where(eq(notificationDigestItems.groupKey, input.groupKey));

      return {
        mode: 'immediate' as const,
        windowEndsAt: new Date(now.getTime() + policy.windowMs),
        windowMs: policy.windowMs,
        heldCount: 0,
      };
    }

    if (group.heldCount < NOTIFICATION_DIGEST_ITEM_LIMIT) {
      await tx.insert(notificationDigestItems).values({
        groupKey: input.groupKey,
        occurredAt: new Date(input.item.occurredAt),
        label: input.item.label,
        detail: input.item.detail,
        url: input.item.url,
      });
    }

    await tx
      .update(notificationDigestGroups)
      .set({
        heldCount: sql`${notificationDigestGroups.heldCount} + 1`,
        firstHeldAt: sql`coalesce(${notificationDigestGroups.firstHeldAt}, ${now})`,
        lastHeldAt: now,
        updatedAt: now,
      })
      .where(eq(notificationDigestGroups.groupKey, input.groupKey));

    return {
      mode: 'held' as const,
      windowEndsAt: group.windowEndsAt ?? now,
      windowMs: group.windowMs,
      heldCount: group.heldCount + 1,
    };
  });
}

// ─── la fermeture : le résumé, ou le silence ──────────────────────────────────

export type NotificationDigestClaim = {
  event: string;
  items: NotificationDigestItem[];
  /** Total retenu — supérieur à `items.length` quand la borne de stockage a mordu. */
  count: number;
  windowStartedAt: Date;
  windowEndedAt: Date;
  windowMs: number;
  nextWindowMs: number;
};

/** Groupes dont la fenêtre est échue. Une requête indexée, appelée par le balayage. */
export async function dueNotificationDigestGroups(
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ groupKey: notificationDigestGroups.groupKey })
    .from(notificationDigestGroups)
    .where(
      and(
        isNotNull(notificationDigestGroups.windowEndsAt),
        lte(notificationDigestGroups.windowEndsAt, now),
      ),
    );
  return rows.map((row) => row.groupKey);
}

/**
 * Ferme une fenêtre échue et **s'attribue** son contenu.
 *
 * Rend `null` quand il n'y a rien à dire — soit la fenêtre n'est pas échue,
 * soit elle s'est refermée vide. Le second cas est le cœur de l'arbitrage : une
 * fenêtre vide remet le groupe au silence, donc la prochaine panne isolée
 * repartira **immédiatement**. Sans cela, un incident unique coûterait
 * indéfiniment la latence d'une fenêtre.
 *
 * Quand il y a matière, la même transaction fait trois choses indissociables :
 * elle prend les lignes, elle les efface, et elle rouvre une fenêtre plus
 * longue. Les séparer laisserait une fenêtre où un second balayage renverrait
 * le même résumé.
 */
export async function claimNotificationDigest(
  groupKey: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<NotificationDigestClaim | null> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .select()
      .from(notificationDigestGroups)
      .where(eq(notificationDigestGroups.groupKey, groupKey))
      .for('update');

    if (!group || group.windowEndsAt === null || group.windowEndsAt > now) return null;

    const policy = await getNotificationDigestPolicy(tx);

    const rows = await tx
      .select()
      .from(notificationDigestItems)
      .where(eq(notificationDigestItems.groupKey, groupKey))
      .orderBy(asc(notificationDigestItems.occurredAt))
      .limit(NOTIFICATION_DIGEST_ITEM_LIMIT);

    if (group.heldCount === 0 || rows.length === 0) {
      await tx
        .update(notificationDigestGroups)
        .set({
          windowEndsAt: null,
          windowStartedAt: null,
          windowMs: policy.windowMs,
          escalation: 0,
          heldCount: 0,
          firstHeldAt: null,
          lastHeldAt: null,
          updatedAt: now,
        })
        .where(eq(notificationDigestGroups.groupKey, groupKey));
      await tx
        .delete(notificationDigestItems)
        .where(eq(notificationDigestItems.groupKey, groupKey));
      return null;
    }

    const escalation = Math.min(group.escalation + 1, NOTIFICATION_DIGEST_MAX_ESCALATION);
    const nextWindowMs = notificationDigestWindowMs(policy.windowMs, escalation);

    await tx.delete(notificationDigestItems).where(eq(notificationDigestItems.groupKey, groupKey));

    await tx
      .update(notificationDigestGroups)
      .set({
        windowStartedAt: now,
        windowEndsAt: new Date(now.getTime() + nextWindowMs),
        windowMs: nextWindowMs,
        escalation,
        heldCount: 0,
        firstHeldAt: null,
        lastHeldAt: null,
        updatedAt: now,
      })
      .where(eq(notificationDigestGroups.groupKey, groupKey));

    return {
      event: group.event,
      items: rows.map((row) => ({
        occurredAt: row.occurredAt.toISOString(),
        label: row.label,
        detail: row.detail,
        url: row.url,
      })),
      count: group.heldCount,
      windowStartedAt: group.windowStartedAt ?? group.firstHeldAt ?? rows[0]!.occurredAt,
      windowEndedAt: now,
      windowMs: group.windowMs,
      nextWindowMs,
    };
  });
}

// ─── lecture pour l'écran ─────────────────────────────────────────────────────

export type NotificationDigestState = {
  groupKey: string;
  event: string;
  /** `null` = groupe silencieux : la prochaine alerte partira sans délai. */
  windowEndsAt: Date | null;
  windowMs: number;
  escalation: number;
  heldCount: number;
  firstHeldAt: Date | null;
  lastHeldAt: Date | null;
};

/**
 * Ce que le regroupement est en train de faire, à cet instant.
 *
 * L'écran des notifications le montre : un opérateur qui ne reçoit pas de
 * message doit pouvoir distinguer « rien ne s'est passé » de « quarante alertes
 * sont retenues et le résumé part dans deux minutes ». Sans cette lecture, le
 * garde-fou serait indiscernable d'une panne.
 */
export async function listNotificationDigestStates(
  db: Database = getDb(),
): Promise<NotificationDigestState[]> {
  const rows = await db
    .select()
    .from(notificationDigestGroups)
    .orderBy(asc(notificationDigestGroups.groupKey));

  return rows.map((row) => ({
    groupKey: row.groupKey,
    event: row.event,
    windowEndsAt: row.windowEndsAt,
    windowMs: row.windowMs,
    escalation: row.escalation,
    heldCount: row.heldCount,
    firstHeldAt: row.firstHeldAt,
    lastHeldAt: row.lastHeldAt,
  }));
}
