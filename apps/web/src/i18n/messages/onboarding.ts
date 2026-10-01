import type { Translated } from '@pupitre/core';

/**
 * L'assistant de démarrage — sa coquille, ses sept étapes, son bandeau de
 * reprise et les deux erreurs de sa route.
 *
 * ── Pourquoi le catalogue d'étapes vit ici ──────────────────────────────────
 * `ONBOARDING_STEP_DEFINITIONS` portait jusqu'ici son titre, sa phrase de
 * résumé, son détail et le prix à payer pour la passer. Ces quatre champs sont
 * de l'affichage : rien dans `packages/core` ne les lit, seuls des écrans les
 * rendent. Les laisser là-bas aurait imposé au catalogue de connaître deux
 * langues — donc de porter un `Record<UiLanguage, string>` par champ, ou pire,
 * d'être dupliqué. Le catalogue garde ce qui est de la logique : `id`,
 * `requires`, `optional`. La prose est ici, sous `step.<id>.*`.
 *
 * `step.<id>.cost` n'existe que pour les quatre étapes facultatives. C'est
 * volontaire et vérifiable : `optional` dit qu'on peut passer l'étape, la clé
 * dit ce qu'on y perd. Une clé vide pour « bienvenue » aurait laissé croire
 * qu'il manque une phrase à écrire.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique les chaînes qui
 * existaient — apostrophes courbes comprises là où le source en avait.
 */
const fr = {
  // ── Coquille ────────────────────────────────────────────────────────────
  'shell.eyebrow': 'Premiers pas',
  'page.title': 'Assistant de démarrage',
  'page.description':
    "Ce qu'il faut poser une fois pour que ce panel serve à quelque chose : le nommer, lui donner une machine, décider qui y accède. Le parcours n'affiche que les étapes que vos permissions autorisent, et chacune appelle exactement la même API que l'écran correspondant — rien de ce que vous faites ici n'est un raccourci, ni ne sera à refaire.",

  // ── L'assistant ne concerne pas cette personne ──────────────────────────
  'notApplicable.title': 'Rien à configurer ici',
  'notApplicable.description':
    "L'assistant de démarrage ne propose que des étapes qu'on peut réellement accomplir. Aucune ne relève de vos permissions actuelles.",
  'notApplicable.empty.title': 'Cet assistant ne vous concerne pas',
  'notApplicable.empty.hint':
    "Déclarer une cible, créer un rôle ou un compte, régler l'instance : chacune de ces actions demande une permission que votre rôle ne porte pas. Une étape qui finirait en 403 est pire qu'une étape absente.",
  'notApplicable.back': 'Retour au tableau de bord',

  // ── Bandeau de reprise ──────────────────────────────────────────────────

  // ── Verbes de l'assistant ───────────────────────────────────────────────
  'action.later': 'Plus tard',
  'action.start': 'Commencer',
  'action.finish': 'Terminer',
  'action.skipStep': 'Passer cette étape',
  'action.saveAndContinue': 'Enregistrer et continuer',

  // ── Pastilles d'état ────────────────────────────────────────────────────
  'badge.optional': 'facultative',
  'badge.done': 'déjà faite',
  'badge.skipped': 'passée',
  'outcome.done': 'faite',
  'outcome.skipped': 'passée',
  'outcome.todo': 'à faire',
  'stepper.label': 'Étapes',
  'stepper.current': 'en cours',
  'progress.label': '{done} étapes faites sur {total}',

  // Le « : » et l'espace finale appartiennent à la phrase : le prix suit.
  'cost.inlineLead': 'Si vous la passez : ',

  // ── Les sept étapes ─────────────────────────────────────────────────────
  'step.welcome.title': 'Bienvenue',
  'step.welcome.summary': "Ce que ce panel fait, et ce qu'il ne fait pas.",
  'step.welcome.detail':
    "Ce panel orchestre, il n'héberge pas. Il se connecte en SSH à des machines que vous possédez déjà et y installe vos applications, en Docker Compose ou en Kubernetes selon la cible. Rien de ce que vous déployez ne tourne ici : ce conteneur-ci ne porte que le panel, sa base et sa file de tâches.",

  'step.identity.title': 'Identité et régionalisation',
  'step.identity.summary': "Le nom de l'instance, son fuseau et sa locale.",
  'step.identity.detail':
    "Le nom apparaît en haut à gauche et dans le titre de l'onglet — utile dès qu'on administre deux instances. Le fuseau et la locale ne sont pas cosmétiques : toutes les dates affichées en dépendent, et une tâche planifiée « à 3 h » prendra ce fuseau par défaut. Ces réglages se changent à tout moment depuis les paramètres.",

  'step.target.title': 'Première cible',
  'step.target.summary': 'La machine Linux sur laquelle le panel déploiera, jointe en SSH.',
  'step.target.detail':
    "Une cible est une machine Linux joignable en SSH, avec Docker ou K3s installé. Le panel y construit vos images et y lance vos conteneurs ; il n'y a aucun registre d'images intermédiaire. La clé SSH que vous collez est chiffrée en AES-256-GCM avant d'atteindre la base, et n'en ressort jamais en clair.",
  'step.target.cost':
    "Sans cible déclarée, rien ne peut être déployé : les écrans d'application et de déploiement resteront sans destination. Vous pourrez la déclarer plus tard depuis « Cibles → Ajouter une cible ».",

  'step.proxy.title': 'Reverse proxy',
  'step.proxy.summary': 'Ce qui servira vos applications par leur nom de domaine, en HTTPS.',
  'step.proxy.detail':
    'Le reverse proxy reçoit les visiteurs sur les ports 80 et 443 et les mène à la bonne application selon le domaine. Pupitre peut reprendre celui qui tourne déjà sur la machine, ou installer Traefik ou BunkerWeb — un reverse proxy qui est aussi un pare-feu applicatif (WAF) — avec des certificats Let’s Encrypt. Ensuite, déployer une application avec un domaine suffit : la route et le certificat suivent.',
  'step.proxy.cost':
    'Sans reverse proxy, les applications ne sont joignables que par leur port, sans nom de domaine ni HTTPS. Il se règle plus tard sur la page de la cible.',
  'proxy.intro': 'Choisissez la machine, puis laissez Pupitre regarder ce qu’elle a déjà.',
  'proxy.noTarget': 'Aucune cible n’est déclarée : cette étape vient après la première.',
  'proxy.target': 'Machine',
  'proxy.done': 'C’est réglé',

  'step.role.title': 'Un rôle',
  'step.role.summary': 'Un jeu de permissions taillé pour votre équipe.',
  'step.role.detail':
    "Un rôle est un jeu de permissions du type « ressource:action » — par exemple « deployment:create » ou « target:delete ». Les rôles sont des données, pas du code : vous pouvez en créer autant que nécessaire et modifier leurs permissions à chaud. Seul « administrateur » est verrouillé, pour qu'une instance ne puisse jamais se retrouver sans personne capable de la réparer.",
  'step.role.cost':
    'Les trois rôles installés d’office (administrateur, opérateur, observateur) restent disponibles. Vous n’aurez simplement pas de rôle intermédiaire : toute personne à qui il faut plus que la lecture recevra les droits complets d’un opérateur.',

  'step.user.title': 'Un utilisateur',
  'step.user.summary': 'Un compte pour quelqu’un d’autre que vous.',
  'step.user.detail':
    "Chaque compte porte un rôle, et chaque geste du panel est tracé avec son auteur dans les logs d'activité. Créer un compte par personne plutôt que d'en partager un rend ces logs exploitables. Chacun pourra ensuite protéger son accès par un second facteur depuis son espace personnel.",
  'step.user.cost':
    'Vous resterez seul à pouvoir vous connecter. Chaque geste du panel étant tracé avec son auteur, un compte partagé rend les logs d’activité inexploitables.',

  'step.security.title': 'Sécurité et IA',
  'step.security.summary': 'Les scanners d’images, et l’accès au modèle qui rédige les AppSpec.',
  'step.security.detail':
    "Les images sont analysées avant mise en ligne par Trivy, Grype et Syft, avec un seuil de blocage réglable. Vous pouvez désactiver l'analyse durablement, ou n'écarter qu'un scanner — utile quand un seul d'entre eux n'atteint pas sa base de vulnérabilités. La clé d'API du modèle sert à rédiger une description d'application à partir d'une phrase ; elle est chiffrée comme les clés SSH, et le modèle ne produit jamais de commande shell, seulement du JSON validé.",
  'step.security.cost':
    'Les scanners restent actifs avec leurs réglages par défaut. Sans clé d’API, la génération d’AppSpec par description restera indisponible et il faudra écrire le JSON à la main.',

  'step.summary.title': 'Fin',
  'step.summary.summary': 'Ce qui a été fait, ce qui a été passé, et où y revenir.',
  'step.summary.detail':
    "Rien de ce qui a été passé n'est perdu : chaque étape correspond à un écran du panel, atteignable à tout moment. Vous pouvez aussi relancer cet assistant depuis les paramètres, autant de fois que vous voulez.",

  // ── Étape « bienvenue » ─────────────────────────────────────────────────
  // Les `{nom}` sont des fragments mis en forme — un mot en gras, un lien, un
  // identifiant en chasse fixe. La phrase reste entière dans le dictionnaire :
  // la découper en trois clés aurait donné des bouts sans contexte, et interdit
  // à l'anglais de déplacer le fragment. Voir `rich()` dans l'assistant.
  'welcome.p1':
    "Ce panel est un {controlPlane}. Il décide, trace, chiffre et ordonnance ; il n'héberge rien. Vos applications tournent sur {your} machines, jointes en SSH — leurs images sont même construites là-bas, il n'y a pas de registry entre les deux.",
  'welcome.p1.controlPlane': 'plan de contrôle',
  'welcome.p1.your': 'vos',
  'welcome.p2':
    "Conséquence directe, et c'est la seule chose à retenir de cet écran : {keepRunning}. Vous perdez la capacité de déployer et de superviser, pas le service rendu.",
  'welcome.p2.keepRunning': "si le panel s'arrête, vos applications continuent de tourner",
  'welcome.does.title': "Ce qu'il fait",
  'welcome.does.ssh': 'Ouvre des sessions SSH vers vos machines',
  'welcome.does.render': 'Rend une AppSpec en Docker Compose ou en manifests K3s',
  'welcome.does.scan': 'Analyse les images, journalise qui a fait quoi',
  'welcome.doesNot.title': "Ce qu'il ne fait pas",
  'welcome.doesNot.run': 'Exécuter vos applications',
  'welcome.doesNot.install': 'Installer Docker ou K3s sur une cible',
  'welcome.doesNot.firewall': 'Activer un pare-feu à votre place',

  // ── Étape « première cible » ────────────────────────────────────────────
  'target.intro':
    "Déclarer une cible n'installe rien : cela n'écrit qu'une ligne en base et un credential chiffré. La machine n'est touchée qu'au preflight, lancé automatiquement juste après — il découvre ce qui y est exécutable, Docker, K3s, ou ni l'un ni l'autre.",
  'target.help': 'Qu’est-ce qu’une cible, et que faut-il préparer sur la machine ?',
  // `{n}` porte le nombre en gras : `count` sert au choix de la forme, `{n}` au
  // rendu. Deux noms, parce que l'un est substitué et l'autre remplacé par un
  // nœud.
  'target.existing': {
    one: "Ce panel connaît déjà {n} cible. Vous pouvez en déclarer une de plus, ou considérer l'étape faite.",
    other:
      "Ce panel connaît déjà {n} cibles. Vous pouvez en déclarer une de plus, ou considérer l'étape faite.",
  },
  'target.haveOne': "J'en ai déjà une",
  'target.submit': 'Déclarer et tester',
  'target.noPreflight':
    '« {name} » déclarée. Preflight non lancé : permission target:update requise.',
  'target.running': '« {name} » déclarée — preflight en cours…',
  'target.tested': '« {name} » déclarée et testée.',

  // ── Étape « un rôle » ───────────────────────────────────────────────────
  'role.intro':
    'Un utilisateur porte un rôle ; le rôle porte les permissions. Trois rôles sont déjà installés — {admin}, {operator}, {viewer}. Un rôle naît {noPermission} : on les coche ensuite, une par une, depuis {rolesLink}.',
  'role.intro.noPermission': 'sans aucune permission',
  'role.intro.link': 'Rôles',

  // ── Étape « un utilisateur » ────────────────────────────────────────────
  'user.intro':
    "Chaque geste du panel est journalisé avec son auteur. Un compte par personne n'est pas une formalité : c'est ce qui rend les logs lisibles.",
  'user.existing': {
    one: 'Ce panel compte déjà {count} compte.',
    other: 'Ce panel compte déjà {count} comptes.',
  },

  // ── Étape « identité et régionalisation » ───────────────────────────────
  'identity.name.label': "Nom de l'instance",
  'identity.tagline.label': 'Sous-titre',
  'identity.tagline.placeholder': "Laisser vide pour n'afficher que le nom",
  'identity.timezone.label': 'Fuseau horaire',
  'identity.locale.label': 'Langue et locale',
  'identity.locale.help':
    "Ce réglage commande la langue du panel et la forme des dates. Il n'est pas personnel : il vaut pour tout le monde, et les e-mails comme les alertes partent dans cette langue.",
  'identity.dateStyle.label': 'Style de date',
  'identity.timeStyle.label': "Style d'heure",
  'style.short': 'court',
  'style.medium': 'moyen',
  'style.long': 'long',
  'preview.title': 'Aperçu',
  'preview.help': 'Instant de référence : 2026-01-15 14:32:07 UTC',

  // ── Étape « sécurité et IA » ────────────────────────────────────────────
  'security.scan.label': 'Analyser les images avant déploiement',
  'security.scan.help':
    "Trivy et Grype cherchent les vulnérabilités connues des dépendances, Syft dresse le SBOM. Le réglage s'applique au moment où un déploiement est enfilé, et il est gelé avec lui.",
  'security.scanners.label': 'Scanners écartés',
  'security.scan.off':
    'Plus aucune image ne sera analysée. Les vulnérabilités connues des dépendances de vos applications passeront sans être signalées.',
  'security.ai.label': "Autoriser la génération d'AppSpec par IA",
  'security.ai.help':
    'Le modèle ne produit jamais de shell : il rend du JSON, validé par Zod avant que quoi que ce soit ne soit exécuté.',
  'security.apiKey.label': "Clé d'API du modèle",
  'security.apiKey.placeholder.stored': 'Clé déjà enregistrée, laisser vide pour la conserver',
  'security.apiKey.placeholder.storedLast4':
    'Clé déjà enregistrée — …{last4}, laisser vide pour la conserver',
  'security.apiKey.placeholder.none': 'Laisser vide pour ne pas en poser',
  // `MASTER_KEY` s'affiche en chasse fixe entre les deux moitiés : un nom de
  // variable d'environnement ne se traduit pas, et ne se substitue pas non plus.
  'security.apiKey.help.before': 'Chiffrée en AES-256-GCM sous',
  'security.apiKey.help.after':
    ", comme les credentials SSH. Elle ne ressort jamais de la base : ni par l'API, ni dans les logs, ni ici. Pour en changer plus tard, on la remplace — on ne la relit pas.",

  // ── Récapitulatif ───────────────────────────────────────────────────────
  'link.settings': 'Paramètres',
  'link.targets': 'Cibles',
  'link.roles': 'Rôles',
  'link.users': 'Utilisateurs',
  'summary.skipped': {
    one: "{count} étape passée : {list}. Rien n'est perdu — chacune se refait depuis l'écran correspondant, et l'assistant se relance depuis {settings}.",
    other:
      "{count} étapes passées : {list}. Rien n'est perdu — chacune se refait depuis l'écran correspondant, et l'assistant se relance depuis {settings}.",
  },
  'summary.skipped.settings': 'les paramètres',
  'summary.finishNote':
    "Terminer marque le parcours comme accompli : le bandeau de reprise disparaît et l'assistant ne se proposera plus de lui-même.",
  'summary.run': "C'est le passage n° {n}.",

  // ── Abandon ─────────────────────────────────────────────────────────────
  'leave.title': "Quitter l'assistant sans l'avoir terminé ?",
  'leave.progress': {
    one: 'Vous avez traité {count} étape sur {total}.',
    other: 'Vous avez traité {count} étapes sur {total}.',
  },
  'leave.body':
    "Le panel restera utilisable, mais dans l'état où vous le laissez. Les étapes non traitées correspondent chacune à un écran : vous pourrez les faire à la main, ou relancer cet assistant depuis les paramètres.",
  'leave.remaining': 'Il reste à faire :',
  'leave.noTarget':
    "Aucune cible n'est déclarée. Tant qu'il n'en existe pas une, le panel ne peut rien déployer : les écrans d'application et de déploiement resteront vides.",
  'leave.stay': "Continuer l'assistant",
  'leave.confirm': 'Quitter quand même',

  // ── Passer une étape ────────────────────────────────────────────────────
  'skip.title': 'Passer « {step} » ?',
  'skip.note':
    "Vous restez dans l'assistant : seule cette étape est marquée comme passée, et elle se refait plus tard depuis l'écran correspondant.",
  'skip.back': "Revenir à l'étape",

  // ── Erreurs de `PATCH /api/onboarding` ──────────────────────────────────
  'error.notApplicable': "Aucune étape de l'assistant de démarrage ne relève de vos permissions",
  'error.restartForbidden':
    "Relancer l'assistant modifie l'instance : permission « settings:manage » requise",
  'error.stepForbidden': "L'étape « {step} » ne relève pas de vos permissions",
  'error.stepNotOptional': "L'étape « {title} » n'est pas facultative",
} as const;

const en: Translated<typeof fr> = {
  'shell.eyebrow': 'First steps',
  'page.title': 'Setup guide',
  'page.description':
    'What has to be set once for this panel to be good for anything: name it, give it a machine, decide who gets in. The guide shows only the steps your permissions allow, and each one calls the same API as its own screen — nothing you do here is a shortcut, and nothing will have to be done twice.',

  'notApplicable.title': 'Nothing to set up here',
  'notApplicable.description':
    'The setup guide only offers steps that can actually be carried out. None fall within your current permissions.',
  'notApplicable.empty.title': 'This guide is not for you',
  'notApplicable.empty.hint':
    'Declaring a target, creating a role or an account, setting up the instance: each of these needs a permission your role does not carry. A step that would end in a 403 is worse than a step that is missing.',
  'notApplicable.back': 'Back to the dashboard',


  'action.later': 'Later',
  'action.start': 'Start',
  'action.finish': 'Finish',
  'action.skipStep': 'Skip this step',
  'action.saveAndContinue': 'Save and continue',

  'badge.optional': 'optional',
  'badge.done': 'already done',
  'badge.skipped': 'skipped',
  'outcome.done': 'done',
  'outcome.skipped': 'skipped',
  'outcome.todo': 'to do',
  'stepper.label': 'Steps',
  'stepper.current': 'in progress',
  'progress.label': '{done} of {total} steps done',

  'cost.inlineLead': 'If you skip it: ',

  'step.welcome.title': 'Welcome',
  'step.welcome.summary': 'What this panel does, and what it does not.',
  'step.welcome.detail':
    'This panel orchestrates, it does not host. It connects over SSH to machines you already own and installs your applications there, in Docker Compose or in Kubernetes depending on the target. Nothing you deploy runs here: this container carries only the panel, its database and its queue.',

  'step.identity.title': 'Identity and regional settings',
  'step.identity.summary': 'The instance name, its time zone and its locale.',
  'step.identity.detail':
    'The name shows top left and in the tab title — useful as soon as you run two instances. The time zone and the locale are not cosmetic: every date on screen depends on them, and a scheduled job set “at 3 a.m.” takes this time zone by default. You can change both at any time from the settings.',

  'step.target.title': 'First target',
  'step.target.summary': 'The Linux machine the panel deploys to, reached over SSH.',
  'step.target.detail':
    'A target is a Linux machine reachable over SSH, with Docker or K3s installed. The panel builds your images and starts your containers there; no image registry sits in between. The SSH key you paste is encrypted with AES-256-GCM before it reaches the database, and never comes back out in the clear.',
  'step.target.cost':
    'With no target declared, nothing can be deployed: the application and deployment screens stay without a destination. You can declare one later from “Targets → Add a target”.',

  'step.proxy.title': 'Reverse proxy',
  'step.proxy.summary': 'What will serve your applications by their domain name, over HTTPS.',
  'step.proxy.detail':
    'The reverse proxy receives visitors on ports 80 and 443 and leads them to the right application depending on the domain. Pupitre can take over the one already running on the machine, or install Traefik or BunkerWeb — a reverse proxy that is also a web application firewall (WAF) — with Let’s Encrypt certificates. From then on, deploying an application with a domain is enough: the route and the certificate follow.',
  'step.proxy.cost':
    'Without a reverse proxy, applications are only reachable by their port, with no domain name nor HTTPS. It can be set up later on the target page.',
  'proxy.intro': 'Pick the machine, then let Pupitre look at what it already has.',
  'proxy.noTarget': 'No target is declared: this step comes after the first one.',
  'proxy.target': 'Machine',
  'proxy.done': 'Done',

  'step.role.title': 'A role',
  'step.role.summary': 'A set of permissions cut for your team.',
  'step.role.detail':
    'A role is a set of “resource:action” permissions — “deployment:create” or “target:delete”, for instance. Roles are data, not code: create as many as you need, and change their permissions live. Only “administrator” is locked, so an instance can never end up with nobody able to repair it.',
  'step.role.cost':
    'The three roles installed out of the box (administrator, operator, viewer) stay available. You simply get no middle ground: anyone who needs more than read access receives an operator’s full rights.',

  'step.user.title': 'A user',
  'step.user.summary': 'An account for someone other than you.',
  'step.user.detail':
    'Each account carries a role, and every move in the panel is recorded with its author in the activity log. One account per person, rather than one shared, is what makes that log usable. Everyone can then protect their access with a second factor from their own space.',
  'step.user.cost':
    'You stay the only one who can sign in. Since every move is recorded with its author, a shared account makes the activity log useless.',

  'step.security.title': 'Security and AI',
  'step.security.summary': 'Image scanners, and access to the model that writes AppSpecs.',
  'step.security.detail':
    'Images are scanned before going live by Trivy, Grype and Syft, against an adjustable blocking threshold. You can turn scanning off for good, or skip a single scanner — useful when only one of them cannot reach its vulnerability database. The model API key writes an application description from a sentence; it is encrypted like the SSH keys, and the model never produces a shell command, only validated JSON.',
  'step.security.cost':
    'Scanners stay on with their default settings. With no API key, generating an AppSpec from a description stays out of reach and you write the JSON by hand.',

  'step.summary.title': 'End',
  'step.summary.summary': 'What was done, what was skipped, and where to go back to it.',
  'step.summary.detail':
    'Nothing skipped is lost: each step matches a panel screen, reachable at any time. You can also run this guide again from the settings, as often as you want.',

  'welcome.p1':
    'This panel is a {controlPlane}. It decides, records, encrypts and schedules; it hosts nothing. Your applications run on {your} machines, joined over SSH — their images are even built over there, with no registry in between.',
  'welcome.p1.controlPlane': 'control plane',
  'welcome.p1.your': 'your own',
  'welcome.p2':
    'Direct consequence, and the only thing to take from this screen: {keepRunning}. You lose the ability to deploy and to monitor, not the service itself.',
  'welcome.p2.keepRunning': 'if the panel stops, your applications keep running',
  'welcome.does.title': 'What it does',
  'welcome.does.ssh': 'Opens SSH sessions to your machines',
  'welcome.does.render': 'Renders an AppSpec as Docker Compose or K3s manifests',
  'welcome.does.scan': 'Scans images, records who did what',
  'welcome.doesNot.title': 'What it does not',
  'welcome.doesNot.run': 'Run your applications',
  'welcome.doesNot.install': 'Install Docker or K3s on a target',
  'welcome.doesNot.firewall': 'Turn a firewall on for you',

  'target.intro':
    'Declaring a target installs nothing: it writes one row and one encrypted credential. The machine is touched only at preflight, run automatically right after — it finds out what can run there, Docker, K3s, or neither.',
  'target.help': 'What is a target, and what has to be ready on the machine?',
  'target.existing': {
    one: 'This panel already knows {n} target. Declare one more, or call the step done.',
    other: 'This panel already knows {n} targets. Declare one more, or call the step done.',
  },
  'target.haveOne': 'I already have one',
  'target.submit': 'Declare and test',
  'target.noPreflight': '“{name}” declared. Preflight not run: permission target:update required.',
  'target.running': '“{name}” declared — preflight running…',
  'target.tested': '“{name}” declared and tested.',

  'role.intro':
    'A user carries a role; the role carries the permissions. Three roles come installed — {admin}, {operator}, {viewer}. A new role starts {noPermission}: you tick them afterwards, one by one, from {rolesLink}.',
  'role.intro.noPermission': 'with no permission at all',
  'role.intro.link': 'Roles',

  'user.intro':
    'Every move in the panel is logged with its author. One account per person is not a formality: it is what makes those logs readable.',
  'user.existing': {
    one: 'This panel already holds {count} account.',
    other: 'This panel already holds {count} accounts.',
  },

  'identity.name.label': 'Instance name',
  'identity.tagline.label': 'Tagline',
  'identity.tagline.placeholder': 'Leave empty to show the name alone',
  'identity.timezone.label': 'Time zone',
  'identity.locale.label': 'Language and locale',
  'identity.locale.help':
    'This setting drives the panel’s language and the shape of dates. It is not personal: it holds for everyone, and emails and alerts go out in this language too.',
  'identity.dateStyle.label': 'Date style',
  'identity.timeStyle.label': 'Time style',
  'style.short': 'short',
  'style.medium': 'medium',
  'style.long': 'long',
  'preview.title': 'Preview',
  'preview.help': 'Reference instant: 2026-01-15 14:32:07 UTC',

  'security.scan.label': 'Scan images before deployment',
  'security.scan.help':
    'Trivy and Grype look for known vulnerabilities in dependencies, Syft draws up the SBOM. The setting applies the moment a deployment is queued, and is frozen with it.',
  'security.scanners.label': 'Skipped scanners',
  'security.scan.off':
    'No image will be scanned any more. Known vulnerabilities in your applications’ dependencies will go through unreported.',
  'security.ai.label': 'Allow AppSpec generation by AI',
  'security.ai.help':
    'The model never produces shell: it returns JSON, validated by Zod before anything runs.',
  'security.apiKey.label': 'Model API key',
  'security.apiKey.placeholder.stored': 'Key already saved, leave empty to keep it',
  'security.apiKey.placeholder.storedLast4': 'Key already saved — …{last4}, leave empty to keep it',
  'security.apiKey.placeholder.none': 'Leave empty to set none',
  'security.apiKey.help.before': 'Encrypted with AES-256-GCM under',
  'security.apiKey.help.after':
    ', like the SSH credentials. It never comes back out of the database: not through the API, not in the logs, not here. To change it later you replace it — you do not read it back.',

  'link.settings': 'Settings',
  'link.targets': 'Targets',
  'link.roles': 'Roles',
  'link.users': 'Users',
  'summary.skipped': {
    one: '{count} step skipped: {list}. Nothing is lost — each one can be done from its own screen, and the guide runs again from {settings}.',
    other:
      '{count} steps skipped: {list}. Nothing is lost — each one can be done from its own screen, and the guide runs again from {settings}.',
  },
  'summary.skipped.settings': 'the settings',
  'summary.finishNote':
    'Finishing marks the guide as done: the resume banner goes away and the guide stops offering itself.',
  'summary.run': 'This is run {n}.',

  'leave.title': 'Leave the setup guide unfinished?',
  'leave.progress': {
    one: 'You have handled {count} step out of {total}.',
    other: 'You have handled {count} steps out of {total}.',
  },
  'leave.body':
    'The panel stays usable, but in the state you leave it. Every untouched step matches a screen: you can do them by hand, or run this guide again from the settings.',
  'leave.remaining': 'Still to do:',
  'leave.noTarget':
    'No target is declared. Until one exists, the panel can deploy nothing: the application and deployment screens stay empty.',
  'leave.stay': 'Stay in the guide',
  'leave.confirm': 'Leave anyway',

  'skip.title': 'Skip “{step}”?',
  'skip.note':
    'You stay in the guide: only this step is marked skipped, and it can be done later from its own screen.',
  'skip.back': 'Back to the step',

  'error.notApplicable': 'No step of the setup guide falls within your permissions',
  'error.restartForbidden':
    'Running the guide again changes the instance: permission “settings:manage” required',
  'error.stepForbidden': 'Step “{step}” does not fall within your permissions',
  'error.stepNotOptional': 'Step “{title}” is not optional',
};

export const onboarding = { fr, en };
