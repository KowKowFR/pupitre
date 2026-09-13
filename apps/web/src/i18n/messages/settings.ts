import type { Translated } from '@pupitre/core';

/**
 * Les paramètres d'instance — le sommaire, le rail, les six sous-sections et
 * la plomberie d'enregistrement qu'elles partagent.
 *
 * Les notifications ont leur propre module (`messages/notifications.ts`) : la
 * section pèse à elle seule autant que les cinq autres réunies, et son
 * vocabulaire — canaux, secrets, résumés — ne sert nulle part ailleurs.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique les chaînes qui
 * existaient. `verify-settings.sh` cherche « Relancer l' » dans le HTML servi ;
 * une virgule déplacée le ferait échouer.
 */
const fr = {
  // ── Plomberie commune aux sous-sections ─────────────────────────────────
  'form.saved': 'Section enregistrée.',

  /**
   * Le catalogue des sections ne porte plus que `href`, `id` et l'icône : la
   * prose vit ici. Les clés sont indexées par l'`id` de la section, ce qui
   * permet au rail, au sommaire et à chaque sous-page de composer la clé
   * — `section.${id}.title` — sans table de correspondance.
   */
  'section.overview.label': 'Sommaire',

  'section.identity.label': 'Identité',
  'section.identity.title': "Identité de l'instance",
  'section.identity.governs':
    "Le nom et le sous-titre que le panel affiche de lui-même : en haut du rail de navigation, dans le titre de l'onglet du navigateur, et en tête de l'assistant de démarrage.",

  'section.regional.label': 'Régionalisation',
  'section.regional.title': 'Régionalisation',
  'section.regional.governs':
    "Le fuseau, la langue et la forme de toutes les dates du panel — tableaux, journaux, horodatages des logs d'activité —, serveur et navigateur compris. Le fuseau sert aussi de défaut aux tâches planifiées créées ensuite.",

  'section.security.label': 'Analyse de sécurité',
  'section.security.title': 'Analyse de sécurité',
  'section.security.governs':
    "Le scan des images avant mise en ligne : quels scanners tournent, et à partir de quelle sévérité un finding empêche le déploiement. Le réglage vaut pour toute l'instance, y compris les déploiements lancés depuis l'API.",

  'section.notifications.label': 'Notifications',
  'section.notifications.title': 'Notifications',
  'section.notifications.governs':
    "Qui est prévenu, comment, et de quoi : e-mail, Telegram, Discord ou webhook. Les alertes partent des mêmes événements que les logs d'activité — un déploiement en échec, un scan qui bloque, un geste de sécurité — mais elles vont chercher quelqu'un au lieu d'attendre qu'on vienne lire.",

  'section.ai.label': 'Intelligence artificielle',
  'section.ai.title': 'Intelligence artificielle',
  'section.ai.governs':
    "Le fournisseur, le modèle et la clé qui servent à générer une AppSpec depuis une description, sur l'écran « Nouvelle application ». Sans clé ni variable d'environnement, la génération reste hors service.",

  'section.onboarding.label': 'Assistant de démarrage',
  'section.onboarding.title': 'Assistant de démarrage',
  'section.onboarding.governs':
    "Le parcours de prise en main proposé à l'arrivée sur une instance vierge. On le relance d'ici quand il a été terminé ou abandonné — c'est un raccourci vers un parcours, pas un réglage de plus.",

  // ── Coquille : bandeau de page, rail, mention de lecture seule ──────────
  'page.eyebrow': 'Administration',
  'page.title': 'Paramètres',
  'page.description.before':
    "Réglages de l'instance, appliqués à chaud. Ils vivent dans une ligne unique de",
  'page.description.after':
    "— un seul JSONB, pour qu'ajouter un réglage ne coûte pas une migration. La clé d'API, elle, est chiffrée dans sa propre colonne et ne ressort jamais d'ici.",
  'page.state.customized': 'personnalisés',
  'page.state.defaults': 'valeurs par défaut',
  'page.readonly.before': 'Lecture seule : la permission',
  'page.readonly.after':
    'est requise pour modifier ces réglages. Les sections restent consultables, leurs champs sont inactifs.',
  'nav.label': 'Sections des paramètres',

  // ── Sommaire ────────────────────────────────────────────────────────────
  'overview.open': 'Ouvrir {label}',
  'overview.term.name': 'Nom',
  'overview.term.tagline': 'Sous-titre',
  'overview.term.timezone': 'Fuseau',
  'overview.term.locale': 'Locale',
  'overview.term.rendering': 'Rendu',
  'overview.term.activeScanners': 'Scanners actifs',
  'overview.term.failOn': 'Seuil de blocage',
  'overview.term.channels': 'Canaux',
  'overview.term.events': 'Événements couverts',
  'overview.term.failing': 'En échec',
  'overview.term.provider': 'Fournisseur',
  'overview.term.model': 'Modèle',
  'overview.term.apiKey': "Clé d'API",
  'overview.scanners.none': 'aucun',
  'overview.scanners.off': 'aucun — analyse coupée',
  'overview.channels.none': 'aucun — personne n’est prévenu',
  'overview.channels.active': {
    one: '{count} actif sur {total}',
    other: '{count} actifs sur {total}',
  },
  'overview.apiKey.set': 'enregistrée',
  'overview.apiKey.setWithTail': 'enregistrée — …{last4}',
  'overview.apiKey.none': 'aucune — repli sur la variable d’environnement',
  'overview.badge.channelsOn': 'branchées',
  'overview.badge.channelsOff': 'aucun canal',

  // ── Identité ────────────────────────────────────────────────────────────
  'identity.name.label': "Nom de l'instance",
  'identity.name.help':
    'Quarante caractères au plus : il doit tenir sur une ligne du rail, à côté du logo.',
  'identity.tagline.label': 'Sous-titre',
  'identity.tagline.placeholder': "Laisser vide pour n'afficher que le nom",
  'identity.tagline.help':
    'Utile quand plusieurs instances se ressemblent — « production », « bac à sable ».',
  'identity.preview.title': 'Aperçu du rail',
  'identity.preview.nameRequired': 'Nom requis',

  // ── Régionalisation ─────────────────────────────────────────────────────
  'regional.timezone.label': 'Fuseau horaire',
  'regional.timezone.help':
    "Toujours explicite, jamais celui du navigateur : c'est ce qui garantit que le serveur et le poste affichent la même heure pour le même événement. C'est aussi le fuseau proposé par défaut à la création d'une tâche planifiée — les tâches déjà installées gardent le leur.",
  'regional.locale.label': 'Langue et locale',
  'regional.locale.help':
    "Décide de la langue du panel, de l'ordre des composants d'une date et du nom des mois. Le changement prend effet au rendu suivant, sans redéploiement ni reconnexion, et vaut pour tout le monde : les e-mails d'invitation et les alertes partent dans cette langue.",
  'regional.dateStyle.label': 'Style de date',
  'regional.timeStyle.label': "Style d'heure",
  'regional.style.short': 'court',
  'regional.style.medium': 'moyen',
  'regional.style.long': 'long',
  'regional.preview.title': 'Aperçu',
  'regional.preview.help':
    "Instant de référence : 2026-01-15 14:32:07 UTC. L'aperçu suit les champs ci-dessus avant même d'enregistrer.",

  // ── Analyse de sécurité ─────────────────────────────────────────────────
  'security.badge.on': 'active',
  'security.badge.off': 'désactivée',
  'security.enabled.label': 'Analyser les images avant déploiement',
  'security.enabled.help':
    "Décocher coupe l'étape pour tout le monde, même si un déploiement demande explicitement des scanners.",
  'security.disabled.warning':
    'Plus aucune image ne sera analysée. Les vulnérabilités connues des dépendances de vos applications passeront sans être signalées, et le seuil de blocage devient sans effet.',
  'security.skipped.title': 'Scanners écartés',
  'security.skipped.help':
    'Utile quand un seul scanner pose problème — une base de vulnérabilités inaccessible depuis la machine cible, par exemple. Les autres continuent de tourner.',
  'security.failOn.label': 'Seuil de blocage',
  'security.failOn.help':
    "Sévérité à partir de laquelle un finding empêche la mise en ligne. Ce seuil vaut pour toute l'instance : l'écran de déploiement ne le demande plus, une politique de sécurité qui se rediscute à chaque mise en ligne n'en est pas une.",
  'security.frozen':
    "Le réglage s'applique au moment où un déploiement est enfilé, et la configuration retenue est gelée avec lui : réactiver l'analyse ne relance pas ce qui est déjà en file. Chaque modification est tracée dans les logs d'activité.",

  // ── Intelligence artificielle ───────────────────────────────────────────
  'ai.badge.off': 'désactivée',
  'ai.badge.missingKey': 'clé manquante',
  'ai.badge.missingKey.title': 'Aucune clé enregistrée, {envVar} vide',
  'ai.badge.on': 'activée',
  'ai.noShell':
    'Le modèle ne produit jamais de shell : il rend du JSON, validé par Zod avant que quoi que ce soit ne soit exécuté.',
  'ai.enabled.label': 'Autoriser la génération par IA',
  'ai.enabled.help':
    'Interrupteur explicite : décocher coupe la génération même si une clé est enregistrée.',
  'ai.provider.label': 'Fournisseur',
  'ai.provider.help.before':
    "Chaque fournisseur lit sa propre variable d'environnement de repli",
  'ai.provider.help.after': '. Une clé enregistrée ici la remplace.',
  'ai.model.label': 'Modèle',
  'ai.model.aria': 'Identifiant du modèle',
  'ai.model.other': 'Autre — saisir un identifiant',
  'ai.model.help':
    "{hint}. Prix indicatifs en dollars par million de jetons, entrée puis sortie, relevés le 11/09/2026 — ils vieillissent, et la liste n'est qu'une suggestion : tout identifiant reconnu par le fournisseur convient, y compris un modèle sorti après cette liste.",
  'ai.temperature.label': 'Température (0 à 1)',
  'ai.temperature.help':
    "Basse, la génération est reproductible — ce qu'on veut d'une AppSpec.",
  'ai.maxTokens.label': 'Jetons maximum',
  'ai.maxTokens.help':
    "Plafond d'une réponse. Trop bas, le JSON est tronqué et la validation échoue.",
  'ai.baseUrl.label': 'URL de base (facultatif)',
  'ai.baseUrl.placeholder': 'https://llm.interne.example/v1',
  'ai.baseUrl.help':
    "Pour une API compatible OpenAI auto-hébergée. Laissée vide, c'est l'API publique du fournisseur qui est appelée. L'URL est validée à l'enregistrement : une valeur bancale ferait échouer chaque génération sans rien dire.",
  'ai.apiKey.label': "Clé d'API",
  'ai.apiKey.placeholder.none': 'Aucune clé enregistrée',
  'ai.apiKey.placeholder.set': 'Clé enregistrée, laisser vide pour la conserver',
  'ai.apiKey.placeholder.setWithTail':
    'Clé enregistrée — …{last4}, laisser vide pour la conserver',
  'ai.apiKey.help.before': 'Chiffrée en AES-256-GCM sous',
  'ai.apiKey.help.middle':
    ", comme les credentials SSH. Elle n'est jamais renvoyée par l'API ni écrite dans les logs d'activité — ce champ part toujours vide, même quand une clé est en place. Sans clé ici, le panel retombe sur",
  'ai.apiKey.help.noEnvVar': 'aucune variable d’environnement',
  'ai.apiKey.help.after': ', la variable propre à {provider}.',
  'ai.apiKey.clear': 'Effacer la clé enregistrée',

  // ── Assistant de démarrage ──────────────────────────────────────────────
  'onboarding.status.pending': 'jamais lancé',
  'onboarding.status.inProgress': 'en cours',
  'onboarding.status.dismissed': 'abandonné',
  'onboarding.status.completed': 'terminé',
  'onboarding.description':
    "Le parcours de prise en main : nommer l'instance, déclarer une première cible, créer un rôle et un compte. Il ne fait rien que ces écrans ne fassent — il les met dans l'ordre.",
  'onboarding.term.status': 'État',
  'onboarding.term.completed': 'Étapes accomplies',
  'onboarding.term.skipped': 'Étapes passées',
  'onboarding.term.currentStep': 'Étape en cours',
  'onboarding.term.runs': 'Relances',
  'onboarding.reset.help':
    "Relancer remet le parcours à zéro et vous y renvoie. Rien n'est défait : les cibles, rôles et comptes déjà créés restent en place — seul le souvenir de l'avancement est effacé.",
  'onboarding.restarting': 'Relance…',
  'onboarding.restart': "Relancer l'assistant",
  'onboarding.needPermission.before': 'La permission',
  'onboarding.needPermission.after': 'est requise pour le relancer.',
  'onboarding.resume': "Reprendre où j'en étais",

  /**
   * Les seuils de supervision se règlent depuis une cible, mais leur route est
   * une route de réglage d'instance : ses deux phrases d'échec vivent donc ici,
   * faute d'un dictionnaire de supervision.
   */
  'threshold.error.targetNotFound': 'Cible « {id} » introuvable',
  'threshold.error.notSet': 'Aucun seuil posé à cette portée pour cette métrique',
} as const;

const en: Translated<typeof fr> = {
  'form.saved': 'Section saved.',

  'section.overview.label': 'Overview',

  'section.identity.label': 'Identity',
  'section.identity.title': 'Instance identity',
  'section.identity.governs':
    'The name and tagline the panel shows of itself: at the top of the navigation rail, in the browser tab title, and at the head of the setup guide.',

  'section.regional.label': 'Regional settings',
  'section.regional.title': 'Regional settings',
  'section.regional.governs':
    'The time zone, the language and the shape of every date in the panel — tables, journals, activity log timestamps — server and browser alike. The time zone is also the default for scheduled jobs created afterwards.',

  'section.security.label': 'Security scanning',
  'section.security.title': 'Security scanning',
  'section.security.governs':
    'Image scanning before going live: which scanners run, and from which severity a finding blocks the deployment. The setting holds for the whole instance, deployments launched from the API included.',

  'section.notifications.label': 'Notifications',
  'section.notifications.title': 'Notifications',
  'section.notifications.governs':
    'Who is warned, how, and of what: email, Telegram, Discord or webhook. Alerts come from the same events as the activity log — a failed deployment, a blocking scan, a security move — but they go find someone instead of waiting to be read.',

  'section.ai.label': 'Artificial intelligence',
  'section.ai.title': 'Artificial intelligence',
  'section.ai.governs':
    'The provider, the model and the key used to generate an AppSpec from a description, on the “New application” screen. With neither a key nor an environment variable, generation stays out of service.',

  'section.onboarding.label': 'Setup guide',
  'section.onboarding.title': 'Setup guide',
  'section.onboarding.governs':
    'The walkthrough offered on arrival at a blank instance. You run it again from here once it has been finished or dismissed — a shortcut to a walkthrough, not one more setting.',

  'page.eyebrow': 'Administration',
  'page.title': 'Settings',
  'page.description.before':
    'Instance settings, applied live. They live in a single row of',
  'page.description.after':
    '— one JSONB, so that adding a setting costs no migration. The API key sits encrypted in its own column and never comes back out of here.',
  'page.state.customized': 'customized',
  'page.state.defaults': 'default values',
  'page.readonly.before': 'Read-only: permission',
  'page.readonly.after':
    'is required to change these settings. Sections stay readable, their fields are inert.',
  'nav.label': 'Settings sections',

  'overview.open': 'Open {label}',
  'overview.term.name': 'Name',
  'overview.term.tagline': 'Tagline',
  'overview.term.timezone': 'Time zone',
  'overview.term.locale': 'Locale',
  'overview.term.rendering': 'Rendered',
  'overview.term.activeScanners': 'Active scanners',
  'overview.term.failOn': 'Blocking threshold',
  'overview.term.channels': 'Channels',
  'overview.term.events': 'Events covered',
  'overview.term.failing': 'Failing',
  'overview.term.provider': 'Provider',
  'overview.term.model': 'Model',
  'overview.term.apiKey': 'API key',
  'overview.scanners.none': 'none',
  'overview.scanners.off': 'none — scanning off',
  'overview.channels.none': 'none — nobody gets warned',
  'overview.channels.active': {
    one: '{count} of {total} enabled',
    other: '{count} of {total} enabled',
  },
  'overview.apiKey.set': 'saved',
  'overview.apiKey.setWithTail': 'saved — …{last4}',
  'overview.apiKey.none': 'none — falls back to the environment variable',
  'overview.badge.channelsOn': 'wired',
  'overview.badge.channelsOff': 'no channel',

  'identity.name.label': 'Instance name',
  'identity.name.help':
    'Forty characters at most: it has to fit on one line of the rail, next to the logo.',
  'identity.tagline.label': 'Tagline',
  'identity.tagline.placeholder': 'Leave empty to show the name alone',
  'identity.tagline.help':
    'Useful when several instances look alike — “production”, “sandbox”.',
  'identity.preview.title': 'Rail preview',
  'identity.preview.nameRequired': 'Name required',

  'regional.timezone.label': 'Time zone',
  'regional.timezone.help':
    'Always explicit, never the browser’s: that is what guarantees the server and the workstation show the same time for the same event. It is also the time zone offered by default when a scheduled job is created — jobs already installed keep theirs.',
  'regional.locale.label': 'Language and locale',
  'regional.locale.help':
    'Decides the panel’s language, the order of the parts of a date and the names of the months. The change takes effect on the next render, with no redeploy and no sign-in again, and it holds for everyone: invitation emails and alerts go out in this language.',
  'regional.dateStyle.label': 'Date style',
  'regional.timeStyle.label': 'Time style',
  'regional.style.short': 'short',
  'regional.style.medium': 'medium',
  'regional.style.long': 'long',
  'regional.preview.title': 'Preview',
  'regional.preview.help':
    'Reference instant: 2026-01-15 14:32:07 UTC. The preview follows the fields above before you even save.',

  'security.badge.on': 'on',
  'security.badge.off': 'off',
  'security.enabled.label': 'Scan images before deployment',
  'security.enabled.help':
    'Unchecking cuts the step for everyone, even when a deployment asks for scanners explicitly.',
  'security.disabled.warning':
    'No image will be scanned any more. Known vulnerabilities in your applications’ dependencies will go unreported, and the blocking threshold becomes moot.',
  'security.skipped.title': 'Skipped scanners',
  'security.skipped.help':
    'Useful when one scanner alone is the problem — a vulnerability database unreachable from the target machine, for instance. The others keep running.',
  'security.failOn.label': 'Blocking threshold',
  'security.failOn.help':
    'Severity from which a finding blocks going live. This threshold holds for the whole instance: the deployment screen no longer asks for it — a security policy renegotiated at every rollout is not one.',
  'security.frozen':
    'The setting applies the moment a deployment is queued, and the configuration chosen is frozen with it: turning scanning back on does not replay what is already in the queue. Every change is traced in the activity log.',

  'ai.badge.off': 'off',
  'ai.badge.missingKey': 'key missing',
  'ai.badge.missingKey.title': 'No key saved, {envVar} empty',
  'ai.badge.on': 'on',
  'ai.noShell':
    'The model never produces shell: it returns JSON, validated by Zod before anything is executed.',
  'ai.enabled.label': 'Allow AI generation',
  'ai.enabled.help':
    'An explicit switch: unchecking cuts generation even when a key is saved.',
  'ai.provider.label': 'Provider',
  'ai.provider.help.before': 'Each provider reads its own fallback environment variable',
  'ai.provider.help.after': '. A key saved here replaces it.',
  'ai.model.label': 'Model',
  'ai.model.aria': 'Model ID',
  'ai.model.other': 'Other — type an ID',
  'ai.model.help':
    '{hint}. Indicative prices in dollars per million tokens, input then output, taken on 2026-09-11 — they age, and the list is only a suggestion: any ID the provider recognizes will do, a model released after this list included.',
  'ai.temperature.label': 'Temperature (0 to 1)',
  'ai.temperature.help':
    'Low, generation is reproducible — what you want from an AppSpec.',
  'ai.maxTokens.label': 'Maximum tokens',
  'ai.maxTokens.help':
    'Ceiling for one response. Too low, the JSON is truncated and validation fails.',
  'ai.baseUrl.label': 'Base URL (optional)',
  'ai.baseUrl.placeholder': 'https://llm.internal.example/v1',
  'ai.baseUrl.help':
    'For a self-hosted OpenAI-compatible API. Left empty, the provider’s public API is called. The URL is validated on save: a shaky value would fail every generation without a word.',
  'ai.apiKey.label': 'API key',
  'ai.apiKey.placeholder.none': 'No key saved',
  'ai.apiKey.placeholder.set': 'Key saved, leave empty to keep it',
  'ai.apiKey.placeholder.setWithTail': 'Key saved — …{last4}, leave empty to keep it',
  'ai.apiKey.help.before': 'Encrypted with AES-256-GCM under',
  'ai.apiKey.help.middle':
    ', like the SSH credentials. It is never returned by the API nor written to the activity log — this field always starts empty, even when a key is in place. With no key here, the panel falls back to',
  'ai.apiKey.help.noEnvVar': 'no environment variable',
  'ai.apiKey.help.after': ', the variable specific to {provider}.',
  'ai.apiKey.clear': 'Clear the saved key',

  'onboarding.status.pending': 'never run',
  'onboarding.status.inProgress': 'in progress',
  'onboarding.status.dismissed': 'dismissed',
  'onboarding.status.completed': 'finished',
  'onboarding.description':
    'The walkthrough: name the instance, declare a first target, create a role and an account. It does nothing these screens do not — it puts them in order.',
  'onboarding.term.status': 'State',
  'onboarding.term.completed': 'Steps done',
  'onboarding.term.skipped': 'Steps skipped',
  'onboarding.term.currentStep': 'Current step',
  'onboarding.term.runs': 'Restarts',
  'onboarding.reset.help':
    'Running it again resets the walkthrough and sends you back to it. Nothing is undone: targets, roles and accounts already created stay in place — only the memory of your progress is erased.',
  'onboarding.restarting': 'Restarting…',
  'onboarding.restart': 'Run the guide again',
  'onboarding.needPermission.before': 'Permission',
  'onboarding.needPermission.after': 'is required to run it again.',
  'onboarding.resume': 'Pick up where I left off',

  'threshold.error.targetNotFound': 'Target “{id}” not found',
  'threshold.error.notSet': 'No threshold set at this scope for this metric',
};

export const settings = { fr, en };
