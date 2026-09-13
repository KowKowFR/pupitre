import type { Translated } from '@pupitre/core';

/**
 * L'aide « Qu'est-ce qu'une cible ? » — la plus grosse surface de texte du
 * panel, et la seule qui soit de la documentation plutôt que de l'interface.
 *
 * ── Pourquoi son propre module ──────────────────────────────────────────────
 * Cent cinquante phrases dont aucune ne s'affiche tant que personne n'a ouvert
 * la modale. Les laisser dans `targets.ts` aurait fait payer ce poids à chaque
 * rendu de la liste. Un dictionnaire par écran, c'est aussi ce qui permet au
 * bundler de ne charger que le nécessaire.
 *
 * ── Le balisage en ligne ────────────────────────────────────────────────────
 * Une entrée de dictionnaire est une chaîne, pas du JSX. Les quelques marques
 * de mise en forme voyagent donc dans le texte, et `rich()` (dans
 * `components/target-help.tsx`) les rend :
 *
 *   `x`      → `<Code>` : une commande, un chemin, un identifiant
 *   **x**    → `<strong>` : une emphase dans une phrase
 *   __x__    → `<strong>` de tête, celui qui ouvre un paragraphe ou une puce
 *   *x*      → `<em>`
 *
 * Les trois derniers acceptent du balisage à l'intérieur ; `` `…` `` non — ce
 * qu'il contient est du code, on n'y touche pas.
 *
 * ── Ce qui n'est pas traduit ────────────────────────────────────────────────
 * Les deux blocs shell (`PREPARE_SCRIPT`, `KEY_SCRIPT`) restent dans le
 * composant : c'est du code à copier-coller, pas de la prose. Idem pour les
 * noms de binaires, de paquets et de distributions, les clés de contrôle du
 * preflight (`ssh`, `os`, `sudo`, `tools`, `firewall`, `docker`, `k3s`,
 * `disk`, `memory`), et les messages que produisent les programmes distants.
 *
 * Rappel de la règle : la colonne `fr` reproduit à l'identique ce que rendait
 * le JSX — `&nbsp;` compris, transcrit en U+00A0.
 */
const fr = {
  // ── L'ouverture ─────────────────────────────────────────────────────────
  'trigger.label': 'Qu’est-ce qu’une cible ?',
  'dialog.title': "Qu'est-ce qu'une cible ?",
  'dialog.description':
    'Une machine Linux jointe en SSH, sur laquelle le panel déploie. Le panel orchestre — la cible héberge.',

  // ── Section 1 : les deux rôles ──────────────────────────────────────────
  'roles.title': 'Le panel n’est pas l’application déployée',
  'roles.intro':
    'Déclarer une cible, c’est donner au panel de quoi ouvrir une session SSH sur une machine qui vous appartient. Rien n’est installé sur elle à ce moment-là : la création n’écrit qu’une ligne en base. La machine n’est touchée qu’au premier preflight, et vraiment utilisée qu’au premier déploiement.',
  'roles.column.panel': 'Le panel',
  'roles.column.target': 'La cible',

  'role.role.topic': 'Rôle',
  'role.role.panel': 'Orchestre. Il décide, trace, chiffre, ordonnance.',
  'role.role.target': 'Héberge. Elle exécute les conteneurs et sert le trafic.',

  'role.code.topic': 'Où tourne le code de vos applications',
  'role.code.panel': 'Nulle part. Le panel n’exécute aucune application déployée.',
  'role.code.target':
    'Ici, et seulement ici. Les images sont même **construites sur la cible** — il n’y a pas de registry entre les deux.',

  'role.wire.topic': 'Ce qui circule entre les deux',
  'role.wire.panel': 'Une session SSH ouverte par le worker, à la demande.',
  'role.wire.target':
    'Des fichiers déposés sous `/opt/bootstrap/apps/{slug}/{version}` et des commandes `docker compose` ou `kubectl`.',

  'role.reach.topic': 'Qui doit être joignable de qui',
  'role.reach.panel': 'Le panel n’a besoin d’aucun port ouvert vers la cible autre que SSH.',
  'role.reach.target':
    'Le **worker** doit joindre `host:port`. Votre navigateur, lui, ne parle jamais à la cible.',

  'role.down.topic': 'Si le panel tombe',
  'role.down.panel': 'Plus de déploiement, plus de supervision.',
  'role.down.target':
    'Les applications déjà déployées continuent de tourner. Elles ne dépendent pas de lui.',

  'roles.callout':
    '__Le formulaire ne demande pas de runtime.__ Vous ne déclarez pas « cette machine est une cible Docker » : c’est le preflight qui découvre ce qui est installé, et le renseigne dans les badges « Docker ✓ / K3s ✗ ». Le runtime est une décision du *déploiement*, pas de la déclaration — c’est ce qui permet de redéployer la même application sur l’autre moteur sans rien retoucher ici. En l’état, l’écran de déploiement ne propose que les cibles dont le preflight a vu Docker.',

  // ── Section 2 : préparer la machine ─────────────────────────────────────
  'prepare.title': 'Ce qu’il faut préparer sur la machine',
  'prepare.intro':
    'Quatre choses, et rien d’autre : un compte, sa clé, un moteur de conteneurs joignable par ce compte, et de quoi élever les privilèges quand c’est nécessaire. Les commandes ci-dessous sont l’équivalent Debian/Ubuntu de ce que fait la cible de test du dépôt (`scripts/test-target/`, en Alpine).',
  'prepare.traps':
    '__Deux pièges dans ce bloc.__ L’appartenance au groupe `docker` n’est lue qu’à l’ouverture d’une session : tant que vous n’êtes pas ressorti, `docker info` continue de répondre « permission denied ». Et l’ordre d’UFW n’est pas négociable — autoriser le port 22 *avant* d’activer, sinon la politique `deny incoming` coupe la session qui pilote la machine, et il n’y a plus personne pour la rouvrir.',

  // ── Section 3 : la clé SSH ──────────────────────────────────────────────
  'key.title': 'La clé SSH',
  'key.intro':
    'Générez une paire **dédiée au panel**, sans passphrase. Ce n’est pas du laxisme : le panel stocke un seul secret par cible et n’a nulle part où mettre une passphrase, donc une clé protégée échoue à la connexion. Une clé dédiée se révoque en retirant une ligne d’`authorized_keys`, sans toucher à la vôtre.',
  'key.paste':
    'Dans le formulaire, on colle **la clé privée** — le fichier *sans* `.pub`, en-têtes `-----BEGIN OPENSSH PRIVATE KEY-----` compris. La publique reste sur la machine cible.',
  'key.crypto':
    'Elle est chiffrée en __AES-256-GCM__ avant insertion, sous une clé dérivée de `MASTER_KEY` par HKDF-SHA256. La valeur en base a la forme `v1:iv:authTag:ciphertext`. Les lectures de l’API passent par une projection de colonnes où `encrypted_credential` n’existe pas : la réponse HTTP ne peut pas la contenir, même par oubli de filtrage. Le seul point de déchiffrement du projet est le handler `target:preflight` du worker, au moment d’ouvrir la session. Conséquence à assumer : **le credential ne se relit jamais**. Pour en changer, on le remplace.',

  // ── Section 4 : chaque champ du formulaire ──────────────────────────────
  'fields.title': 'Chaque champ du formulaire',
  'fields.column.field': 'Champ',
  'fields.column.role': 'Ce que le panel en fait',
  'fields.column.wrong': 'Si c’est faux',

  'field.name.name': 'Nom',
  'field.name.role':
    'Étiquette humaine, 2 à 80 caractères. **Unique en base.** C’est ce nom qui apparaît dans les logs de déploiement et les avertissements du pare-feu.',
  'field.name.wrong':
    'Nom déjà pris → `409` « Une cible se nomme déjà « … » ».',

  'field.host.name': 'Hôte',
  'field.host.role':
    'IP ou nom DNS, passé tel quel à la connexion SSH. Il est résolu **depuis le conteneur worker**, pas depuis votre poste.',
  'field.host.wrong':
    'Un nom qui ne résout que sur votre machine, ou un `127.0.0.1` qui désigne le worker lui-même : « Connexion SSH impossible vers … après 3 tentatives ».',

  'field.port.name': 'Port',
  'field.port.role':
    'Port de `sshd`, 22 par défaut. Le triplet (hôte, port, utilisateur) est unique en base — deux lignes ne peuvent pas décrire la même machine.',
  'field.port.wrong':
    'Triplet déjà pris → `409` « Une cible pointe déjà vers user@host:port ».',

  'field.user.name': 'Utilisateur SSH',
  'field.user.role':
    'Le compte qui exécutera *tout* : les `docker build`, les `docker compose up`, les `kubectl apply`, les scanners. Le formulaire propose `root` ; un compte dédié membre du groupe `docker` est préférable.',
  'field.user.wrong':
    'Un compte qui ne peut pas parler au démon Docker fait échouer le contrôle `docker` du preflight avec « daemon injoignable », pas la connexion.',

  'field.auth.name': 'Authentification',
  'field.auth.role':
    '`key` : vous collez une **clé privée**. `password` : vous collez un mot de passe. Un seul credential est stocké par cible.',
  'field.auth.wrong':
    'Coller la clé *publique* au lieu de la privée → « Authentification SSH refusée ». Une clé protégée par passphrase échoue aussi (voir plus bas).',

  'field.sudo.name': 'Élévation sudo',
  'field.sudo.role':
    "`nopasswd` enrobe la commande en `sudo -n -- sh -c …` ; `password` en `sudo -S -p '' -- sh -c …`, le mot de passe étant poussé par **stdin** — jamais sur la ligne de commande, donc jamais dans `ps`.",
  'field.sudo.wrong':
    '**Le piège** : `password` avec une authentification par `key` lève une `SshConfigError` — il n’y a aucun mot de passe à donner à sudo. Les deux vont ensemble.',

  'field.credential.name': 'Clé privée / Mot de passe',
  'field.credential.role':
    'Chiffré en **AES-256-GCM** avant insertion. 32 768 caractères au plus. En édition, laisser le champ vide conserve le credential déjà en base.',
  'field.credential.wrong':
    'Le champ est obligatoire à la création. Il n’est jamais relu : le récupérer plus tard est impossible, il faut le remplacer.',

  'field.portRange.name': 'Plage de ports publiables',
  'field.portRange.role':
    'Bornes comprises, entre 1024 et 65535, début ≤ fin. Défaut 30000-32767, la plage `nodePort` de Kubernetes — inoccupée sur une machine standard.',
  'field.portRange.wrong':
    'Une plage inversée est refusée deux fois : par Zod, puis par la contrainte `targets_port_range_check` en base. Une plage trop étroite épuise les ports (section suivante).',

  'field.labels.name': 'Étiquettes',
  'field.labels.role':
    'Une paire `clé=valeur` par ligne, libre : `env=prod`, `zone=eu-west`. Purement descriptif.',
  'field.labels.wrong': 'Une ligne sans `=` est ignorée en silence, pas rejetée.',

  // ── Section 5 : la plage de ports ───────────────────────────────────────
  'ports.title': 'La plage de ports, à part',
  'ports.intro':
    'Elle mérite sa section parce qu’elle est le seul champ du formulaire qui décrit quelque chose d’extérieur au panel : ce que cette machine-là accepte de publier. Une application déployée en Docker Compose et exposée y réserve un port, sur lequel le driver publie et pose une règle UFW commentée `pupitre:{slug}`.',
  'ports.collision':
    '__L’anti-collision n’est pas un `if`.__ C’est la contrainte unique `port_allocations (target_id, port)`. L’allocation ne fait jamais « SELECT puis INSERT » : elle insère, et une violation renvoie le perdant au tirage suivant. Deux workers simultanés ne peuvent pas obtenir le même port.',
  'ports.blind':
    '__La base ne connaît pas la machine.__ Un service installé à la main qui écoute déjà sur le port tiré est invisible pour elle. Le driver le constate après coup (`ss -tlnH`, ou `netstat -tln` sur les images sans `iproute2`), abandonne la réservation et rejoue en excluant ce port.',
  /**
   * « pare-feu*hors* » n'est pas une faute de frappe de la traduction : le JSX
   * d'origine passait à la ligne juste avant `<em>hors</em>`, et JSX supprime
   * cette espace-là. Le français rendu était donc « pare-feuhors », et la règle
   * dit de reproduire à l'identique. L'anglais, lui, met l'espace.
   */
  'ports.firewall':
    '__Le pare-feu est une seconde barrière, pas la même.__ Le panel ouvre le port sur UFW s’il est actif et si sudo le permet. Un pare-feu*hors* de la machine — groupe de sécurité d’un hébergeur, box — est hors de sa portée : c’est à vous d’y ouvrir la plage.',
  'ports.workerRange':
    '__Le worker a sa propre plage.__ `DRIVER_PORT_RANGE` décrit ce que l’environnement du worker peut atteindre. Les deux sont vraies : c’est **l’intersection** qui est retenue. Si elles ne se recouvrent pas, la plage de la cible l’emporte et le log du déploiement le dit.',
  'ports.narrow':
    'Une plage étroite se remplit vite : la cible de test du dépôt tient sur dix ports (30000-30009), soit dix applications exposées. Le panneau d’une cible affiche la jauge et la table application → port.',

  // ── Section 6 : le preflight ────────────────────────────────────────────
  'checks.title': 'Le preflight, contrôle par contrôle',
  'checks.intro':
    'Le preflight est une tâche BullMQ, pas un appel HTTP : le bouton « Tester la connexion » l’enfile et suit la tâche. Règle de conception — __chaque contrôle est indépendant__. Un `kubectl` absent marque K3s indisponible, il ne fait pas échouer le preflight. Chaque contrôle dispose de 15 secondes.',
  'checks.column.check': 'Contrôle',
  'checks.column.what': 'Ce qu’il lance',
  'checks.column.failure': 'Ce que son échec veut dire',

  'check.ssh.what':
    'Ouvre la session et mesure la latence. Trois tentatives, backoff 500 ms / 1 s / 2 s sur échec réseau — **aucune** sur échec d’authentification.',
  'check.ssh.failure':
    '**Seul échec fatal.** La cible passe en `unreachable` et aucun autre contrôle n’est tenté : sans session, ils n’ont pas de sens.',

  'check.os.what': '`uname -a` et `/etc/os-release`.',
  'check.os.failure': 'Informatif. N’empêche rien.',

  'check.sudo.what':
    '`sudo -n true` puis `command -v sudo`. Le détail vaut réponse : « sudo sans mot de passe », « sudo présent, mot de passe requis » ou « sudo absent ».',
  'check.sudo.failure':
    'Sans sudo, le pare-feu n’est pas lisible et `/opt/bootstrap` ne pourra pas être créé si `/opt` appartient à root.',

  'check.tools.what':
    'Un seul aller-retour : `command -v` sur `ufw`, `curl`, `git`, `docker`, `kubectl`.',
  'check.tools.failure':
    'Aucun outil n’est obligatoire. L’absence conditionne simplement les contrôles suivants.',

  'check.firewall.what':
    '`ufw status` via sudo, et compte les règles portant le commentaire `pupitre:` — celles que le panel a posées, distinctes de celles de l’administrateur.',
  'check.firewall.failure':
    '« ufw absent » ou « installé mais inactif » n’est pas bloquant. Le panel **n’active jamais** un pare-feu lui-même.',

  'check.docker.what':
    "`docker info --format '{{.ServerVersion}}'` et `docker compose version --short`.",
  'check.docker.failure':
    '« binaire absent » : rien n’est installé. « daemon injoignable » : le binaire est là mais le compte ne parle pas au socket, ou `dockerd` est arrêté. C’est presque toujours le groupe `docker`.',

  'check.k3s.what':
    '`kubectl get nodes -o json` : nombre de nodes, nodes prêts, version du kubelet.',
  'check.k3s.failure':
    '« kubectl présent mais aucun cluster joignable » : le plus souvent `/etc/rancher/k3s/k3s.yaml` n’est pas *lisible* par le compte de déploiement (voir les pannes fréquentes).',

  'check.disk.what': '`df -Pk /` — le format POSIX, stable, contrairement à `df -h`.',
  'check.disk.failure': 'Informatif ici. Au déploiement, le driver exige **1 Gio** disponible.',

  'check.memory.what': '`free -m`, ligne `Mem:`.',
  'check.memory.failure': 'Informatif.',

  'checks.status':
    'Le statut qui en sort tient en trois valeurs. `ok` : au moins un runtime exploitable — Docker disponible, ou K3s avec un node prêt — et aucun contrôle en échec. `degraded` : la machine répond, mais rien n’y est déployable, ou un contrôle a échoué. `unreachable` : la session SSH n’a pas pu s’ouvrir. Le rapport complet est conservé et relisible sur la page de la cible.',

  // ── Section 7 : le parcours complet ─────────────────────────────────────
  'tutorial.title': 'De la machine nue à la première application',

  'step.machine.title': 'Une machine Linux joignable en SSH depuis le worker',
  'step.machine.body':
    "VM, VPS, serveur physique. Vérifiez depuis le conteneur qui déploie, pas depuis votre poste : `docker compose exec worker sh -lc 'nc -z 10.0.0.12 22'`. C’est lui qui ouvrira la session.",

  'step.account.title': 'Un compte de déploiement dédié',
  'step.account.body':
    "Pas `root` si vous pouvez l’éviter : `sudo adduser --disabled-password --gecos '' deploy`. Il portera toutes les commandes du panel.",

  'step.key.title': 'La clé, sans passphrase, déposée sur la machine',
  'step.key.body':
    "`ssh-keygen -t ed25519 -N '' -f ~/.ssh/pupitre-deploy` puis `ssh-copy-id -i ~/.ssh/pupitre-deploy.pub deploy@10.0.0.12`. Testez avec `ssh -i ~/.ssh/pupitre-deploy deploy@10.0.0.12 true` avant d’aller plus loin.",

  'step.runtime.title': 'Docker, ou K3s, ou les deux',
  'step.runtime.body':
    'Le panel n’installe rien. Pour Docker, ajoutez le compte au groupe `docker` — sans quoi tout le reste échouera sur « daemon injoignable ». Pour K3s, installez-le avec un kubeconfig lisible (`--write-kubeconfig-mode 644`).',

  'step.sudo.title': 'sudo sans mot de passe',
  'step.sudo.body':
    'Nécessaire pour créer `/opt/bootstrap` au premier déploiement et pour poser les règles UFW. Vérifiez exactement ce que vérifie le preflight : `sudo -n true`.',

  'step.firewall.title': 'Le pare-feu, si vous en avez un',
  'step.firewall.body':
    'Ouvrez 22, puis la plage que vous déclarerez au panel. Si le filtrage est en amont (groupe de sécurité, box), c’est là qu’il faut ouvrir : UFW n’y peut rien.',

  'step.declare.title': 'Déclarer la cible dans le panel',
  'step.declare.body':
    'Le formulaire de cette page. Nom, hôte, port, compte, clé privée collée, sudo `nopasswd`, et une plage de ports qui corresponde à ce que vous venez d’ouvrir.',

  'step.preflight.title': 'Lancer le preflight',
  'step.preflight.body':
    'Bouton « Tester la connexion », depuis la liste ou la page de la cible. Vous attendez des badges « Docker ✓ » ou « K3s ✓ » et un statut `ok`. Un statut `degraded` avec deux runtimes absents signifie que la machine répond mais que rien n’y est déployable.',

  'step.app.title': 'Créer une application',
  'step.app.body':
    '*Applications → Nouvelle application*, depuis une description ou un JSON. Une AppSpec ne connaît ni Docker ni Kubernetes ; la modale « Qu’est-ce qu’une AppSpec ? » de cette page-là détaille les champs.',

  'step.deploy.title': 'Déployer, et regarder les étapes',
  'step.deploy.body':
    'Choisissez la cible — seules celles dont le preflight a vu Docker sont proposées — et la politique de scan. Le déploiement est une tâche : la page de suivi montre les étapes à gauche et les logs en direct à droite. Une cible qui porte un déploiement vivant n’est plus supprimable, c’est voulu.',

  'tutorial.shortcut':
    'Sans machine sous la main, `./scripts/setup-test-target.sh` monte un conteneur docker-in-docker qui porte son propre démon Docker, y installe une clé jetable et enregistre la cible — les étapes 1 à 7 en une commande.',

  // ── Section 8 : les pannes fréquentes ───────────────────────────────────
  'failures.title': 'Les pannes fréquentes',
  'failures.column.symptom': 'Ce que vous lisez',
  'failures.column.cause': 'Ce que c’est',

  'failure.publickey.symptom':
    '`Permission denied (publickey)`, ou du panel : « Authentification SSH refusée (clé ou mot de passe invalide, ou passphrase manquante) »',
  'failure.publickey.cause':
    'Quatre causes, par ordre de fréquence. (1) La **clé publique** a été collée au lieu de la privée. (2) La clé privée est **protégée par une passphrase** : le panel ne stocke qu’un secret par cible et ne peut pas la fournir — regénérez une clé dédiée sans passphrase. (3) Les permissions : `700` sur `~/.ssh`, `600` sur `authorized_keys`, le tout possédé par le compte. (4) Le compte est **verrouillé** (`!` dans `/etc/shadow`) : `sshd` le refuse même par clé.',

  'failure.connect.symptom':
    '« Connexion SSH impossible vers *host*:*port* après 3 tentatives »',
  'failure.connect.cause':
    'Réseau, DNS ou TCP — l’authentification n’a même pas été tentée. Le nom est résolu par le **conteneur worker** : un hostname de votre `/etc/hosts`, ou un `localhost` qui désigne votre poste, n’existent pas pour lui.',

  'failure.sudoPassword.symptom':
    'Preflight vert, mais le détail sudo dit « sudo présent, mot de passe requis »',
  'failure.sudoPassword.cause':
    '`sudo -n true` a renvoyé un code non nul. Le compte n’a pas de règle `NOPASSWD`. Tant que `/opt/bootstrap` est écrivable, les déploiements passent quand même ; l’ouverture de port UFW, elle, échouera.',

  'failure.sudoConfig.symptom':
    '`SshConfigError` : « sudo_method « password » exige une authentification par mot de passe »',
  'failure.sudoConfig.cause':
    'La cible est déclarée en authentification par clé *et* en sudo par mot de passe. Il n’y a alors aucun mot de passe à pousser dans `sudo -S`. Passez la cible en `nopasswd`, ou authentifiez-vous par mot de passe.',

  'failure.dockerSock.symptom':
    'Contrôle `docker` : « daemon injoignable : permission denied … /var/run/docker.sock »',
  'failure.dockerSock.cause':
    'Le compte n’est pas dans le groupe `docker`, ou l’a rejoint dans une session déjà ouverte — l’appartenance à un groupe n’est lue qu’à l’ouverture de session. Déconnectez-vous, reconnectez-vous, relancez le preflight.',

  'failure.kubeconfig.symptom':
    'Contrôle `k3s` : « kubectl présent mais aucun cluster joignable »',
  'failure.kubeconfig.cause':
    'Le driver n’utilise **pas** sudo pour `kubectl` : il exporte `KUBECONFIG=/etc/rancher/k3s/k3s.yaml` uniquement si ce fichier est *lisible* par le compte. K3s l’écrit en `0600 root` par défaut. Installez K3s avec `--write-kubeconfig-mode 644`, ou déposez une copie dans `~/.kube/config`.',

  'failure.noPort.symptom':
    '« Aucun port libre entre *min* et *max* sur « … » : N port(s) réservés en base se sont révélés occupés »',
  'failure.noPort.cause':
    'La base a accordé des ports, mais la cible les avait déjà en écoute — un service installé à la main, que la base ne peut pas connaître. Le driver relâche la réservation et rejoue, jusqu’à épuisement. Élargissez la plage de la cible, ou libérez les ports.',

  'failure.deployRoot.symptom':
    '« Racine de déploiement inutilisable » / « `/opt/bootstrap` n’est pas écrivable et sudo a échoué »',
  'failure.deployRoot.cause':
    '`/opt` appartient à root sur une machine standard. Le premier déploiement a besoin d’une élévation pour créer l’arborescence et la donner au compte ; les suivants n’en ont plus besoin. Sans `NOPASSWD`, créez le répertoire à la main.',

  'failure.ufwInactive.symptom':
    'Log de déploiement : « ⚠ ufw inactif sur *cible* — aucune règle posée pour le port N »',
  'failure.ufwInactive.cause':
    'Ce n’est pas une erreur. UFW étant inactif, il ne filtre rien et le port est joignable de toute façon. Le panel n’active jamais un pare-feu : couper la session SSH qui pilote la machine est un risque réel.',

  'failure.deleteRefused.symptom':
    'Suppression refusée : « Cette cible porte N déploiement(s) actif(s) »',
  'failure.deleteRefused.cause':
    'Supprimer la ligne laisserait des conteneurs orphelins sur une machine que le panel ne saurait plus joindre. Détruisez les déploiements d’abord.',
} as const;

const en: Translated<typeof fr> = {
  'trigger.label': 'What is a target?',
  'dialog.title': 'What is a target?',
  'dialog.description':
    'A Linux machine reached over SSH, on which the panel deploys. The panel orchestrates — the target hosts.',

  'roles.title': 'The panel is not the deployed application',
  'roles.intro':
    'Declaring a target gives the panel what it needs to open an SSH session on a machine you own. Nothing is installed on it at that point: creating a target writes one database row. The machine is first touched by the preflight, and only really used by the first deployment.',
  'roles.column.panel': 'The panel',
  'roles.column.target': 'The target',

  'role.role.topic': 'Role',
  'role.role.panel': 'Orchestrates. It decides, records, encrypts, schedules.',
  'role.role.target': 'Hosts. It runs the containers and serves the traffic.',

  'role.code.topic': 'Where your application code runs',
  'role.code.panel': 'Nowhere. The panel runs no deployed application.',
  'role.code.target':
    'Here, and only here. The images are even **built on the target** — there is no registry between the two.',

  'role.wire.topic': 'What travels between the two',
  'role.wire.panel': 'One SSH session, opened by the worker on demand.',
  'role.wire.target':
    'Files dropped under `/opt/bootstrap/apps/{slug}/{version}`, and `docker compose` or `kubectl` commands.',

  'role.reach.topic': 'Who has to reach whom',
  'role.reach.panel': 'The panel needs no port open toward the target other than SSH.',
  'role.reach.target':
    'The **worker** must reach `host:port`. Your browser never talks to the target.',

  'role.down.topic': 'If the panel goes down',
  'role.down.panel': 'No more deployments, no more monitoring.',
  'role.down.target':
    'Applications already deployed keep running. They do not depend on it.',

  'roles.callout':
    '__The form asks for no runtime.__ You do not declare “this machine is a Docker target”: the preflight finds out what is installed and fills in the “Docker ✓ / K3s ✗” badges. The runtime is a decision of the *deployment*, not of the declaration — that is what lets you redeploy the same application on the other engine without touching anything here. As it stands, the deployment screen only offers targets whose preflight saw Docker.',

  'prepare.title': 'What to prepare on the machine',
  'prepare.intro':
    'Four things, nothing more: an account, its key, a container engine that account can reach, and a way to elevate privileges when needed. The commands below are the Debian/Ubuntu equivalent of what the repo’s test target does (`scripts/test-target/`, on Alpine).',
  'prepare.traps':
    '__Two traps in this block.__ Group membership in `docker` is only read when a session opens: until you have logged out, `docker info` keeps answering “permission denied”. And the UFW order is not negotiable — allow port 22 *before* enabling, or the `deny incoming` policy cuts the very session that drives the machine, and no one is left to reopen it.',

  'key.title': 'The SSH key',
  'key.intro':
    'Generate a pair **dedicated to the panel**, without a passphrase. This is not sloppiness: the panel stores one secret per target and has nowhere to put a passphrase, so a protected key fails at connection time. A dedicated key is revoked by dropping one line from `authorized_keys`, without touching yours.',
  'key.paste':
    'In the form you paste **the private key** — the file *without* `.pub`, `-----BEGIN OPENSSH PRIVATE KEY-----` headers included. The public one stays on the target machine.',
  'key.crypto':
    'It is encrypted with __AES-256-GCM__ before insertion, under a key derived from `MASTER_KEY` by HKDF-SHA256. The stored value has the shape `v1:iv:authTag:ciphertext`. API reads go through a column projection where `encrypted_credential` does not exist: the HTTP response cannot carry it, not even by a forgotten filter. The only decryption point in the project is the worker’s `target:preflight` handler, when it opens the session. The consequence to accept: **the credential is never read back**. To change it, you replace it.',

  'fields.title': 'Every field of the form',
  'fields.column.field': 'Field',
  'fields.column.role': 'What the panel does with it',
  'fields.column.wrong': 'If it is wrong',

  'field.name.name': 'Name',
  'field.name.role':
    'A human label, 2 to 80 characters. **Unique in the database.** This name is what shows up in deployment logs and firewall warnings.',
  'field.name.wrong': 'Name already taken → `409` “A target is already named “…””.',

  'field.host.name': 'Host',
  'field.host.role':
    'IP or DNS name, passed as-is to the SSH connection. It is resolved **from the worker container**, not from your workstation.',
  'field.host.wrong':
    'A name that only resolves on your machine, or a `127.0.0.1` that means the worker itself: “Cannot open an SSH connection to … after 3 attempts”.',

  'field.port.name': 'Port',
  'field.port.role':
    '`sshd` port, 22 by default. The triple (host, port, user) is unique in the database — two rows cannot describe the same machine.',
  'field.port.wrong':
    'Triple already taken → `409` “A target already points to user@host:port”.',

  'field.user.name': 'SSH user',
  'field.user.role':
    'The account that will run *everything*: the `docker build`, the `docker compose up`, the `kubectl apply`, the scanners. The form suggests `root`; a dedicated account in the `docker` group is better.',
  'field.user.wrong':
    'An account that cannot talk to the Docker daemon fails the preflight’s `docker` check with “daemon unreachable”, not the connection.',

  'field.auth.name': 'Authentication',
  'field.auth.role':
    '`key`: you paste a **private key**. `password`: you paste a password. One credential is stored per target.',
  'field.auth.wrong':
    'Pasting the *public* key instead of the private one → “SSH authentication refused”. A key protected by a passphrase fails too (see below).',

  'field.sudo.name': 'Sudo elevation',
  'field.sudo.role':
    "`nopasswd` wraps the command in `sudo -n -- sh -c …`; `password` in `sudo -S -p '' -- sh -c …`, with the password pushed through **stdin** — never on the command line, so never in `ps`.",
  'field.sudo.wrong':
    '**The trap**: `password` together with `key` authentication raises an `SshConfigError` — there is no password to hand to sudo. The two go together.',

  'field.credential.name': 'Private key / Password',
  'field.credential.role':
    'Encrypted with **AES-256-GCM** before insertion. 32,768 characters at most. When editing, leaving the field empty keeps the credential already stored.',
  'field.credential.wrong':
    'The field is required at creation. It is never read back: recovering it later is impossible, you replace it.',

  'field.portRange.name': 'Publishable port range',
  'field.portRange.role':
    'Bounds included, between 1024 and 65535, start ≤ end. Default 30000-32767, Kubernetes’ `nodePort` range — unused on a standard machine.',
  'field.portRange.wrong':
    'An inverted range is refused twice: by Zod, then by the `targets_port_range_check` constraint. A range too narrow runs out of ports (next section).',

  'field.labels.name': 'Labels',
  'field.labels.role':
    'One `key=value` pair per line, free-form: `env=prod`, `zone=eu-west`. Purely descriptive.',
  'field.labels.wrong': 'A line without `=` is dropped silently, not rejected.',

  'ports.title': 'The port range, on its own',
  'ports.intro':
    'It deserves its own section because it is the only field of the form describing something outside the panel: what that machine agrees to publish. An application deployed on Docker Compose and exposed reserves one port in it, on which the driver publishes and sets a UFW rule commented `pupitre:{slug}`.',
  'ports.collision':
    '__Collision avoidance is not an `if`.__ It is the `port_allocations (target_id, port)` unique constraint. Allocation never does “SELECT then INSERT”: it inserts, and a violation sends the loser to the next draw. Two workers at once cannot get the same port.',
  'ports.blind':
    '__The database does not know the machine.__ A hand-installed service already listening on the drawn port is invisible to it. The driver finds out afterward (`ss -tlnH`, or `netstat -tln` on images without `iproute2`), drops the reservation and draws again, excluding that port.',
  'ports.firewall':
    '__The firewall is a second barrier, not the same one.__ The panel opens the port on UFW if it is active and if sudo allows it. A firewall *outside* the machine — a hosting provider’s security group, a home router — is out of its reach: opening the range there is on you.',
  'ports.workerRange':
    '__The worker has its own range.__ `DRIVER_PORT_RANGE` describes what the worker’s environment can reach. Both hold: it is the **intersection** that wins. If they do not overlap, the target’s range wins and the deployment log says so.',
  'ports.narrow':
    'A narrow range fills up fast: the repo’s test target holds ten ports (30000-30009), so ten exposed applications. A target’s panel shows the gauge and the application → port table.',

  'checks.title': 'The preflight, check by check',
  'checks.intro':
    'The preflight is a BullMQ job, not an HTTP call: the “Test the connection” button queues it and follows it. Design rule — __every check stands alone__. A missing `kubectl` marks K3s unavailable, it does not fail the preflight. Each check gets 15 seconds.',
  'checks.column.check': 'Check',
  'checks.column.what': 'What it runs',
  'checks.column.failure': 'What its failure means',

  'check.ssh.what':
    'Opens the session and measures latency. Three attempts, backoff 500 ms / 1 s / 2 s on network failure — **none** on authentication failure.',
  'check.ssh.failure':
    '**The only fatal failure.** The target goes `unreachable` and no other check is attempted: without a session they mean nothing.',

  'check.os.what': '`uname -a` and `/etc/os-release`.',
  'check.os.failure': 'Informational. It blocks nothing.',

  'check.sudo.what':
    '`sudo -n true` then `command -v sudo`. The detail is the answer: “sudo without a password”, “sudo present, password required” or “sudo missing”.',
  'check.sudo.failure':
    'Without sudo the firewall cannot be read, and `/opt/bootstrap` cannot be created if `/opt` belongs to root.',

  'check.tools.what':
    'One round trip: `command -v` on `ufw`, `curl`, `git`, `docker`, `kubectl`.',
  'check.tools.failure':
    'No tool is required. Their absence simply conditions the checks that follow.',

  'check.firewall.what':
    '`ufw status` through sudo, counting the rules carrying the `pupitre:` comment — the ones the panel set, apart from the administrator’s.',
  'check.firewall.failure':
    '“ufw missing” or “installed but inactive” blocks nothing. The panel **never turns on** a firewall itself.',

  'check.docker.what':
    "`docker info --format '{{.ServerVersion}}'` and `docker compose version --short`.",
  'check.docker.failure':
    '“binary missing”: nothing is installed. “daemon unreachable”: the binary is there but the account does not talk to the socket, or `dockerd` is stopped. It is almost always the `docker` group.',

  'check.k3s.what': '`kubectl get nodes -o json`: node count, ready nodes, kubelet version.',
  'check.k3s.failure':
    '“kubectl present but no cluster reachable”: most often `/etc/rancher/k3s/k3s.yaml` is not *readable* by the deployment account (see common failures).',

  'check.disk.what': '`df -Pk /` — the POSIX format, stable, unlike `df -h`.',
  'check.disk.failure':
    'Informational here. At deployment time the driver demands **1 GiB** available.',

  'check.memory.what': '`free -m`, the `Mem:` line.',
  'check.memory.failure': 'Informational.',

  'checks.status':
    'The status it produces holds three values. `ok`: at least one usable runtime — Docker available, or K3s with a ready node — and no failed check. `degraded`: the machine answers, but nothing is deployable on it, or a check failed. `unreachable`: the SSH session could not open. The full report is kept and readable on the target page.',

  'tutorial.title': 'From a bare machine to the first application',

  'step.machine.title': 'A Linux machine reachable over SSH from the worker',
  'step.machine.body':
    "VM, VPS, physical server. Check from the container that deploys, not from your workstation: `docker compose exec worker sh -lc 'nc -z 10.0.0.12 22'`. It is the one that will open the session.",

  'step.account.title': 'A dedicated deployment account',
  'step.account.body':
    "Not `root` if you can avoid it: `sudo adduser --disabled-password --gecos '' deploy`. It will carry every command the panel runs.",

  'step.key.title': 'The key, passphrase-free, installed on the machine',
  'step.key.body':
    "`ssh-keygen -t ed25519 -N '' -f ~/.ssh/pupitre-deploy` then `ssh-copy-id -i ~/.ssh/pupitre-deploy.pub deploy@10.0.0.12`. Test it with `ssh -i ~/.ssh/pupitre-deploy deploy@10.0.0.12 true` before going further.",

  'step.runtime.title': 'Docker, or K3s, or both',
  'step.runtime.body':
    'The panel installs nothing. For Docker, add the account to the `docker` group — otherwise everything else fails on “daemon unreachable”. For K3s, install it with a readable kubeconfig (`--write-kubeconfig-mode 644`).',

  'step.sudo.title': 'sudo without a password',
  'step.sudo.body':
    'Needed to create `/opt/bootstrap` on the first deployment and to set the UFW rules. Check exactly what the preflight checks: `sudo -n true`.',

  'step.firewall.title': 'The firewall, if you have one',
  'step.firewall.body':
    'Open 22, then the range you will declare to the panel. If the filtering sits upstream (security group, home router), that is where to open it: UFW can do nothing about it.',

  'step.declare.title': 'Declare the target in the panel',
  'step.declare.body':
    'The form on this page. Name, host, port, account, private key pasted, `nopasswd` sudo, and a port range matching what you just opened.',

  'step.preflight.title': 'Run the preflight',
  'step.preflight.body':
    'The “Test the connection” button, from the list or from the target page. You are waiting for “Docker ✓” or “K3s ✓” badges and an `ok` status. A `degraded` status with both runtimes missing means the machine answers but nothing is deployable on it.',

  'step.app.title': 'Create an application',
  'step.app.body':
    '*Applications → New application*, from a description or from JSON. An AppSpec knows neither Docker nor Kubernetes; the “What is an AppSpec?” dialog on that page details the fields.',

  'step.deploy.title': 'Deploy, and watch the steps',
  'step.deploy.body':
    'Pick the target — only those whose preflight saw Docker are offered — and the scan policy. A deployment is a job: the tracking page shows the steps on the left and the live logs on the right. A target carrying a live deployment can no longer be deleted, and that is on purpose.',

  'tutorial.shortcut':
    'With no machine at hand, `./scripts/setup-test-target.sh` brings up a docker-in-docker container carrying its own Docker daemon, installs a throwaway key in it and registers the target — steps 1 to 7 in one command.',

  'failures.title': 'Common failures',
  'failures.column.symptom': 'What you read',
  'failures.column.cause': 'What it is',

  'failure.publickey.symptom':
    '`Permission denied (publickey)`, or from the panel: “SSH authentication refused (invalid key or password, or missing passphrase)”',
  'failure.publickey.cause':
    'Four causes, most frequent first. (1) The **public key** was pasted instead of the private one. (2) The private key is **protected by a passphrase**: the panel stores one secret per target and cannot supply it — generate a dedicated key without one. (3) Permissions: `700` on `~/.ssh`, `600` on `authorized_keys`, all owned by the account. (4) The account is **locked** (`!` in `/etc/shadow`): `sshd` refuses it even by key.',

  'failure.connect.symptom':
    '“Cannot open an SSH connection to *host*:*port* after 3 attempts”',
  'failure.connect.cause':
    'Network, DNS or TCP — authentication was never even attempted. The name is resolved by the **worker container**: a hostname from your `/etc/hosts`, or a `localhost` meaning your workstation, do not exist for it.',

  'failure.sudoPassword.symptom':
    'Preflight green, but the sudo detail says “sudo present, password required”',
  'failure.sudoPassword.cause':
    '`sudo -n true` returned a non-zero code. The account has no `NOPASSWD` rule. As long as `/opt/bootstrap` is writable, deployments still go through; opening a UFW port will not.',

  'failure.sudoConfig.symptom':
    '`SshConfigError`: “sudo_method “password” requires password authentication”',
  'failure.sudoConfig.cause':
    'The target is declared with key authentication *and* password sudo. There is then no password to push into `sudo -S`. Move the target to `nopasswd`, or authenticate by password.',

  'failure.dockerSock.symptom':
    '`docker` check: “daemon unreachable: permission denied … /var/run/docker.sock”',
  'failure.dockerSock.cause':
    'The account is not in the `docker` group, or joined it inside an already-open session — group membership is only read when a session opens. Log out, log back in, run the preflight again.',

  'failure.kubeconfig.symptom': '`k3s` check: “kubectl present but no cluster reachable”',
  'failure.kubeconfig.cause':
    'The driver does **not** use sudo for `kubectl`: it exports `KUBECONFIG=/etc/rancher/k3s/k3s.yaml` only if that file is *readable* by the account. K3s writes it `0600 root` by default. Install K3s with `--write-kubeconfig-mode 644`, or drop a copy in `~/.kube/config`.',

  'failure.noPort.symptom':
    '“No free port between *min* and *max* on “…”: N port(s) reserved in the database turned out to be taken”',
  'failure.noPort.cause':
    'The database granted ports, but the target already had them listening — a hand-installed service the database cannot know about. The driver releases the reservation and draws again, until exhaustion. Widen the target’s range, or free the ports.',

  'failure.deployRoot.symptom':
    '“Deployment root unusable” / “`/opt/bootstrap` is not writable and sudo failed”',
  'failure.deployRoot.cause':
    '`/opt` belongs to root on a standard machine. The first deployment needs elevation to create the tree and hand it to the account; later ones do not. Without `NOPASSWD`, create the directory by hand.',

  'failure.ufwInactive.symptom':
    'Deployment log: “⚠ ufw inactive on *target* — no rule set for port N”',
  'failure.ufwInactive.cause':
    'This is not an error. UFW being inactive, it filters nothing and the port is reachable anyway. The panel never turns on a firewall: cutting the SSH session that drives the machine is a real risk.',

  'failure.deleteRefused.symptom':
    'Deletion refused: “This target carries N live deployment(s)”',
  'failure.deleteRefused.cause':
    'Deleting the row would leave orphan containers on a machine the panel could no longer reach. Destroy the deployments first.',
};

export const targetHelp = { fr, en };
