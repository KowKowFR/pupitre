import type { Translated } from '@pupitre/core';

/**
 * Les notifications — les canaux, leur essai, et le garde-fou de volume.
 *
 * Un module à part plutôt qu'une famille de clés dans `settings.ts` : la
 * section pèse à elle seule autant que les cinq autres réunies, et son
 * vocabulaire — canal, secret enregistré, fenêtre de regroupement, résumé — ne
 * sert nulle part ailleurs. Le bundler ne charge donc ces cent lignes que sur
 * l'écran qui les affiche, et les routes `/api/notifications/**` puisent leurs
 * phrases d'échec au même endroit que l'écran qui les déclenche.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique les chaînes qui
 * existaient — apostrophes courbes comprises, elles étaient déjà là.
 */
const fr = {
  // ── Canaux : la liste ───────────────────────────────────────────────────
  empty:
    "Aucun canal configuré. Tant qu'il n'y en a pas, un déploiement en échec, un scan bloquant ou une réinitialisation de second facteur ne laissent de trace que dans les logs d'activité — qu'il faut penser à aller lire.",
  'channel.on': 'actif',
  'channel.off': 'éteint',
  'channel.failures': {
    one: "{count} échec d'affilée",
    other: "{count} échecs d'affilée",
  },
  'channel.noEvents': 'Abonné à aucun événement — ce canal ne recevra jamais rien.',
  'channel.events': 'Abonné à : {list}',
  'channel.secrets': 'Secrets enregistrés : {list} — chiffrés en base, jamais renvoyés.',
  'channel.lastError': 'Dernier échec ({at}) : {error}',
  'channel.lastSuccess': 'Dernier envoi réussi : {at}',
  'channels.title': 'Canaux',
  'channels.description': 'Sans canal, les événements ne laissent de trace que dans le journal.',
  'drawer.kind': 'Notifications',
  'channel.test': 'Envoyer un essai',
  'channel.edit.title': 'Modifier « {name} »',
  'channel.delete.aria': 'Supprimer le canal {name}',
  'channel.delete.title': 'Supprimer le canal « {name} » ?',
  'channel.delete.events': 'Les événements auxquels il est abonné ne partiront plus par ce canal.',
  'channel.delete.secrets': 'Ses secrets sont effacés de la base.',
  'channel.delete.confirm': 'Supprimer le canal',
  'channel.never': 'Jamais utilisé',
  'form.events.count': '{count} sur {total}',
  'channel.add': 'Ajouter un canal',
  'channel.created': 'Canal créé.',
  'channel.saved': 'Canal enregistré.',
  'channel.deleted': 'Canal « {name} » supprimé.',

  // ── Canaux : l'essai ────────────────────────────────────────────────────
  'test.sending': 'Envoi…',
  'test.probe': 'sonde : ',
  'test.probeFailed': 'sonde en échec : ',
  'test.delivered':
    "Message d'essai délivré. Allez vérifier qu'il est bien arrivé : le destinataire est le seul juge.",
  'test.failed': 'Envoi en échec : {detail}',
  'test.noDetail': 'sans détail',

  // ── Canaux : le formulaire ──────────────────────────────────────────────
  'form.kind': 'Type de canal',
  'form.name': 'Nom',
  'form.name.placeholder': 'astreinte',
  'form.events.legend': 'Événements notifiés',
  'form.events.help':
    "Chaque événement retenu part sur ce canal. La liste est volontairement courte : un événement bavard rend la boîte inutilisable en une journée, et la première chose qu'on fait alors est de tout couper.",
  'form.enabled': 'Canal actif',
  'form.create': 'Créer le canal',
  'field.optional': 'facultatif',
  'field.secret.keep': 'Laisser vide conserve la valeur enregistrée.',
  'field.secret.clear': 'Effacer ce secret',
  'field.secret.cleared': '— sera effacé.',

  // ── Regroupement des alertes ────────────────────────────────────────────
  'digest.card.title': 'Regroupement des alertes',
  'digest.card.description':
    'Ce qui empêche cinquante pannes en dix minutes de produire cinquante messages — sans jamais retarder la première.',
  /**
   * Les deux paragraphes de la règle sont coupés autour de leurs `<strong>` :
   * une phrase entière dans une clé ne saurait pas où poser le gras, et un
   * `dangerouslySetInnerHTML` sur du texte traduit serait payer une injection
   * pour deux mots en gras.
   */
  'digest.rule.lead': 'La',
  'digest.rule.first': 'première',
  'digest.rule.opens':
    'alerte d’un incident part sans délai — c’est la règle qui prime sur toutes les autres. Elle ouvre une fenêtre de',
  'digest.rule.holds':
    'pendant laquelle les alertes suivantes du même type sont retenues au lieu d’être envoyées une par une.',
  'digest.close.lead':
    'À la fermeture : rien de retenu, la fenêtre se referme et la prochaine panne isolée repart immédiatement. Quelque chose de retenu, un',
  'digest.close.digest': 'résumé',
  'digest.close.rest':
    'part — il nomme chacune des alertes qu’il remplace, jusqu’à {limit} — et la fenêtre s’ouvre à nouveau, deux fois plus longue, jusqu’à {widest}. Un orage qui dure fait donc baisser la cadence tout seul.',
  'digest.window.label': 'Fenêtre de regroupement',
  'digest.window.help':
    'Réglable de {min} à {max}. Le plancher n’est pas zéro : un garde-fou de volume qu’on peut désactiver est un garde-fou désactivé, et cinquante pannes redeviendraient cinquante messages.',
  'digest.refresh': 'Actualiser l’état',
  'digest.saved': 'Fenêtre enregistrée.',
  'digest.open.title': 'Regroupements en cours',
  'digest.open.none':
    'Aucune fenêtre ouverte : la prochaine alerte, quelle qu’elle soit, partira sans délai.',
  'digest.held': { one: '{count} retenue', other: '{count} retenues' },
  'digest.state.window': 'fenêtre de {window}',
  'digest.state.widened': '(élargie {times}×)',
  'digest.state.closesAt': '· se ferme à {time}',

  // ── Échecs rendus par l'API ─────────────────────────────────────────────
  'error.channelNotFound': 'Canal « {id} » introuvable',
  'error.nameTaken': 'Un canal nommé « {name} » existe déjà',
  'error.testTimeout':
    "L'essai n'a pas abouti dans le délai imparti. Le worker est peut-être saturé.",
  'error.testFailed': 'Essai impossible : {detail}',
  'error.testUnreadable': 'Le worker a renvoyé un verdict illisible',
} as const;

const en: Translated<typeof fr> = {
  empty:
    'No channel configured. Until there is one, a failed deployment, a blocking scan or a second-factor reset leave a trace only in the activity log — which someone has to remember to read.',
  'channel.on': 'on',
  'channel.off': 'off',
  'channel.failures': {
    one: '{count} failure in a row',
    other: '{count} failures in a row',
  },
  'channel.noEvents': 'Subscribed to no event — this channel will never receive anything.',
  'channel.events': 'Subscribed to: {list}',
  'channel.secrets': 'Secrets saved: {list} — encrypted in the database, never returned.',
  'channel.lastError': 'Last failure ({at}): {error}',
  'channel.lastSuccess': 'Last successful send: {at}',
  'channels.title': 'Channels',
  'channels.description': 'Without a channel, events leave a trace only in the log.',
  'drawer.kind': 'Notifications',
  'channel.test': 'Send a test',
  'channel.edit.title': 'Edit “{name}”',
  'channel.delete.aria': 'Delete the channel {name}',
  'channel.delete.title': 'Delete the channel “{name}”?',
  'channel.delete.events':
    'The events it is subscribed to will no longer leave through this channel.',
  'channel.delete.secrets': 'Its secrets are erased from the database.',
  'channel.delete.confirm': 'Delete the channel',
  'channel.never': 'Never used',
  'form.events.count': '{count} of {total}',
  'channel.add': 'Add a channel',
  'channel.created': 'Channel created.',
  'channel.saved': 'Channel saved.',
  'channel.deleted': 'Channel “{name}” deleted.',

  'test.sending': 'Sending…',
  'test.probe': 'probe: ',
  'test.probeFailed': 'probe failed: ',
  'test.delivered':
    'Test message delivered. Go check it actually arrived: the recipient is the only judge.',
  'test.failed': 'Send failed: {detail}',
  'test.noDetail': 'no detail',

  'form.kind': 'Channel type',
  'form.name': 'Name',
  'form.name.placeholder': 'on-call',
  'form.events.legend': 'Events notified',
  'form.events.help':
    'Every event kept goes out on this channel. The list is deliberately short: one chatty event makes the inbox unusable in a day, and the first thing anyone does then is cut everything.',
  'form.enabled': 'Channel enabled',
  'form.create': 'Create the channel',
  'field.optional': 'optional',
  'field.secret.keep': 'Leaving it empty keeps the saved value.',
  'field.secret.clear': 'Clear this secret',
  'field.secret.cleared': '— will be cleared.',

  'digest.card.title': 'Alert grouping',
  'digest.card.description':
    'What keeps fifty outages in ten minutes from producing fifty messages — without ever delaying the first.',
  'digest.rule.lead': 'The',
  'digest.rule.first': 'first',
  'digest.rule.opens':
    'alert of an incident goes out with no delay — that rule beats every other. It opens a window of',
  'digest.rule.holds':
    'during which later alerts of the same type are held instead of being sent one by one.',
  'digest.close.lead':
    'On close: nothing held, the window shuts and the next isolated outage goes out at once. Something held, a',
  'digest.close.digest': 'digest',
  'digest.close.rest':
    'goes out — it names each of the alerts it stands in for, up to {limit} — and the window opens again, twice as long, up to {widest}. A storm that lasts therefore slows its own pace.',
  'digest.window.label': 'Grouping window',
  'digest.window.help':
    'Adjustable from {min} to {max}. The floor is not zero: a volume guard you can switch off is a guard switched off, and fifty outages would be fifty messages again.',
  'digest.refresh': 'Refresh the state',
  'digest.saved': 'Window saved.',
  'digest.open.title': 'Groupings under way',
  'digest.open.none': 'No window open: the next alert, whatever it is, goes out with no delay.',
  'digest.held': { one: '{count} held', other: '{count} held' },
  'digest.state.window': 'window of {window}',
  'digest.state.widened': '(widened {times}×)',
  'digest.state.closesAt': '· closes at {time}',

  'error.channelNotFound': 'Channel “{id}” not found',
  'error.nameTaken': 'A channel named “{name}” already exists',
  'error.testTimeout':
    'The test did not complete within the allotted time. The worker may be saturated.',
  'error.testFailed': 'Test impossible: {detail}',
  'error.testUnreadable': 'The worker returned an unreadable verdict',
};

export const notifications = { fr, en };
