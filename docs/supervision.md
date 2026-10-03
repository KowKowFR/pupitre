# Supervision et automatisation

Quatre choses portent des noms voisins et ne font pas la même chose. Autant les
séparer d'emblée :

| Écran | Ce que c'est | Sens du regard |
|---|---|---|
| **`/apps` — Supervision** | ce qui tourne sur vos machines, groupé par serveur, avec les métriques d'hôte | le panel lit les machines, par SSH |
| **`/monitors` — Sondes** | des URL et des certificats sondés depuis le worker | le worker sort sur le réseau |
| **Notifications** | quatre canaux qui relaient les événements du journal d'activité | le panel sort vers vos outils |
| **`/jobs` — Tâches** | ce qui se déclenche tout seul, à heure dite | BullMQ, en interne |

- [Supervision par serveur](#supervision-par-serveur)
- [Sondes de sites](#sondes-de-sites)
- [Notifications](#notifications)
- [Tâches planifiées](#tâches-planifiées)

## Supervision par serveur

`/apps` — « Supervision, vue par serveur ». Permission de page `deployment:read` ;
le parc complet n'est listé qu'avec `target:read`.

Une carte par machine, chacune avec son identité, ses jauges, et un dépliant
contenant ses applications. **Deux sources qui ne se mélangent jamais** : un
serveur injoignable affiche « injoignable » à la place de ses jauges, et **garde
ses applications à l'écran** — elles viennent de la base, pas de la machine.

### Les métriques d'hôte

Six relevés, lancés **en parallèle sur une seule session SSH**, chacun plafonné à
5 s :

| Relevé | Commande | Ce qui en sort |
|---|---|---|
| `load` | `cat /proc/loadavg` | charge à 1, 5, 15 min |
| `cpu` | `nproc` | cœurs, d'où la charge par cœur |
| `memory` | `cat /proc/meminfo` | total et **`MemAvailable`** — jamais `MemFree` |
| `disk` | `df -Pk` sur le premier ancêtre existant de `DRIVER_ROOT_PATH` | taille, utilisé, disponible, point de montage |
| `uptime` | `cat /proc/uptime` | secondes |
| `os` | `uname -r` + `/etc/os-release` | noyau, distribution |

Aucun `docker`, aucun `kubectl` : c'est exactement pourquoi ce relevé n'est pas
une méthode de driver. Il parle à une machine, pas à un runtime.

**Chaque relevé est indépendant.** Un `nproc` absent laisse la charge lisible, et
la valeur rendue est `null` — jamais `0`. « Je ne sais pas » et « zéro » ne sont
pas la même information, et une jauge à 0 % mentirait.

**Le worker relève chaque machine toutes les cinq minutes** (tâche
`target:metrics_sweep`) et garde les relevés trente jours
(`target_metric_samples`, avec leur raison quand la machine n'a pas répondu).
C'est le worker, pas l'écran, qui relève : un onglet oublié ne devient pas une
sonde permanente. L'écran affiche le dernier relevé et son âge ; un bouton en
redemande un.

**Seuils.** Disque et mémoire à 90 %, charge par cœur à 100 %, réglables par
machine, avec une hystérésis : il faut plusieurs relevés au-dessus pour ouvrir
un dépassement (un pour le disque, deux pour la mémoire, trois pour la charge),
et autant en dessous pour le refermer. L'ouverture écrit
`target.threshold.breached`, la fermeture `target.threshold.cleared` — une
entrée par épisode, pas par relevé.

**Machine injoignable.** Une machine éteinte ne franchit aucun seuil : ses
relevés échouent, tout simplement. **Deux relevés manqués de suite** ouvrent
donc un épisode (`targets.unreachable_since`, daté du premier) et écrivent
`target.unreachable`, avec la raison — connexion refusée, délai dépassé, clé
d'hôte refusée ; le premier relevé réussi le referme et écrit
`target.reachable`, avec la durée de l'interruption. Un redémarrage ne réveille
personne ; deux balayages manqués, si.

Chemin technique : `GET /api/targets/:id/metrics` (`target:read`) enfile un job
sur la file **`supervision`** et attend son résultat 20 s — le panel n'ouvre
jamais de session SSH lui-même. Une cible injoignable rend un `200` avec
`reachable: false`, pas une erreur.

### Les applications en marche

`/apps/:id` montre le détail d'une application : état de ses services et **logs
en direct par SSE**, lus sur la machine. `deployment:restart` permet de la
redémarrer — par la file, avec son cycle de vie publié dans le flux.

Une application dont la **dernière mise à jour a échoué** reste listée, avec un
état qui le dit : elle tourne toujours, dans sa version d'avant. C'est le cas que
`verify-supervision.sh` isole spécifiquement.

## Sondes de sites

`/monitors` — « Sondes ». `monitor:read` pour lire, `monitor:manage` pour écrire.
Ici le worker **sort sur le réseau** vers une URL fournie par un utilisateur.
C'est une SSRF en puissance, et c'est ce qui explique la moitié du design.

### Deux types

| Type | Configuration | Cadence minimale |
|---|---|---|
| `http` | `url`, `method` (GET/HEAD/POST), `expectedStatus`, `keyword` facultatif, `timeoutMs` | 30 s (défaut 60 s) |
| `tls` | `host`, `port`, `servername` (SNI), **`warnDays`** (défaut 21), `timeoutMs` | 1 h (défaut 6 h) |

Le mot-clé attendu est une **option de la sonde HTTP**, pas un type à part.

Point à connaître : le préavis TLS **fait échouer la sonde**, il ne se contente
pas d'avertir. Un certificat à 20 jours de l'expiration avec `warnDays: 21` rend
`unhealthy`. C'est délibéré — un avertissement qu'on peut ignorer n'en est pas
un — mais ça surprend la première fois.

### Le seuil de confirmation

Deux compteurs en base, `consecutive_failures` et `consecutive_successes`, mis à
jour **dans la même transaction** que l'insertion de la mesure et
l'ouverture/fermeture de l'incident.

- Un incident s'ouvre après `failure_threshold` échecs consécutifs (défaut **3**).
- Il se ferme après `recovery_threshold` succès consécutifs (défaut **2**).
- Un index unique partiel sur `(monitor_id) where resolved_at is null` interdit
  structurellement un second incident ouvert.
- Depuis l'état `unknown`, une seule mesure saine suffit à afficher « sain ».
- Déjà en panne et la nature change (`unhealthy` → `unreachable`) : le statut est
  mis à jour, mais **aucun nouvel incident, aucune alerte**.

`monitors.status` porte l'état **confirmé**, `monitors.last_outcome` le dernier
verdict brut. C'est ce qui permet à l'écran de dire « 1 échec sur 3 — non
confirmé » plutôt que de crier au loup.

Un rebond isolé ne crée donc aucun incident, et c'est le point 3 de
`verify-monitors.sh`.

### La garde SSRF

`packages/core/src/monitors/ssrf.ts`. Le réglage est la variable d'environnement
**`MONITOR_ALLOWED_CIDRS`**, vide par défaut : **seules les adresses publiques
sont sondables**.

Elle se lève **là et nulle part ailleurs** — ni depuis un écran, ni derrière une
permission. La raison est simple : `monitor:manage` est justement ce que porte
quiconque crée une sonde. Une garde qu'on lève avec la permission qu'elle est
censée encadrer ne garde rien.

Quatre catégories restent refusées **même si un CIDR les liste** :
lien-local (`169.254.0.0/16`, `fe80::/10` — les services de métadonnées),
multicast, réservé (`192.0.2.0/24`, `198.18/15`, TEST-NET, `240/4`, Teredo…) et
l'adresse indéterminée. Sont autorisables : loopback, privé, unique-local, CGNAT.

Le durcissement va plus loin que la liste : refus de l'octal (`0177.0.0.1`),
dé-encapsulation de l'IPv4-dans-IPv6 (`::ffff:`, NAT64, `::a.b.c.d`), suffixe de
zone ignoré, refus du nom `localhost` et de `*.localhost`, refus des schémas
autres que http/https, refus des URL portant `user:pass@`.

Elle s'applique **trois fois** :

1. à la création et à la modification, côté panel — sur la config **et** sur
   l'URL du webhook, avec le champ fautif nommé dans le `422` ;
2. **à chaque saut de redirection** côté worker, cinq au maximum, avec le
   préfixe « redirection refusée : » ;
3. contre le **DNS rebinding** : `resolveGuarded()` contrôle *toutes* les
   adresses rendues, puis la sonde se connecte à l'**adresse littérale** en
   passant le nom d'origine en `Host` et en SNI. Pas de seconde résolution.

Le webhook d'alerte est soumis à la même politique. La réponse est plafonnée à
256 Kio, en `accept-encoding: identity`, socket coupée à la troncature.

> **`MONITOR_ALLOWED_CIDRS` doit valoir la même chose côté panel et côté worker**,
> et les deux la mettent en cache au niveau module : un changement exige un
> redémarrage des deux services.

### L'ordonnancement

Un **seul** scheduler BullMQ, `monitor-sweep`, toutes les 30 s sur la file
`supervision`. Il ne sonde pas : il **balaie**. `claimDueMonitors(200)` réclame
les sondes dues en SQL brut, avec `for update skip locked`, et **avance
`next_check_at` avant de sonder**. La cadence de chaque sonde vit donc dans
`monitors.interval_seconds`, pas dans BullMQ — mille sondes ne font pas mille
schedulers.

Gardes du balayage : verrou Redis, budget de 22 s, concurrence 10, lots de 200.
Une sonde en erreur ne fait pas tomber le balayage. Il en profite pour suspendre
les sondes dont l'application a été détruite, et pour purger les mesures de plus
de 30 jours — au plus une fois par heure. **Les incidents ne sont jamais purgés.**

« Sonder maintenant » (`POST /api/monitors/:id/check`) marque la sonde due et
enfile le même job en mode forcé : il court-circuite le verrou, et ne purge rien.

### L'alerte

Un **webhook par sonde**, dont l'URL est chiffrée en base et n'est jamais rendue
par l'API (seul un `hasWebhook: boolean` sort). Il part à la transition, **une
seule fois**, et au rétablissement. Le résultat est consigné sur l'incident
(`alert_sent_at`, `alert_error`) et un webhook injoignable **ne fait pas échouer
le balayage**. L'audit (`monitor.down` / `monitor.recovered`) est écrit quoi qu'il
arrive, même sans webhook configuré.

**Deux sorties, et c'est délibéré.** Depuis que `monitor.down` et
`monitor.recovered` sont au catalogue des événements notifiables, une transition
part *aussi* vers les canaux d'instance (e-mail, Telegram, Discord, webhook),
avec regroupement des rafales et résumés nommés. Le raccord ne passe par aucun
appel depuis la supervision : les sondes écrivaient déjà dans `audit_logs`, et
l'audit est la source des notifications.

Le webhook par sonde n'a pas été supprimé pour autant. Un canal est abonné à un
**événement**, donc à toutes les sondes ; ce webhook est attaché à **une** sonde.
Qui surveille trente sites pour vingt clients veut le salon de chacun dans sa
propre sonde. Renseigner les deux fait donc partir deux messages pour la même
panne — deux abonnements, deux gestes ; l'écran des sondes le dit au moment de
saisir l'URL.

Vérification de bout en bout : `scripts/verify-monitor-notifications.sh`.

## Prévisions

Ce qui va casser si rien ne change. Toutes les 30 minutes, le worker relit les
séries que la base garde déjà et en tire des **prévisions** — sans IA : une
pente aux moindres carrés, une médiane, un compte. Le calcul est pur et testé
sur des séries fabriquées (`packages/core/src/forecast.ts`) ; le balayage
(`apps/worker/src/forecast/sweep.ts`) ne fait que lire, appeler et accorder.

| Prévision | Sujet | Ce qui la déclenche |
|---|---|---|
| Disque bientôt plein | cible | 95 % atteint dans moins de 14 jours, à la pente des 7 derniers jours (moyennes horaires ; pente ≥ 0,3 pt/jour, r² ≥ 0,6, deux jours de relevés au moins) |
| Mémoire qui ne redescend pas | cible | 95 % dans moins de 7 jours, à la pente des 3 derniers jours (≥ 2 pts/jour, r² ≥ 0,8 : une fuite monte droit) |
| Charge en hausse | cible | le seuil de charge de la cible dans moins de 7 jours, à la pente des moyennes **journalières** — la charge respire chaque jour, la tendance se lit d'un jour à l'autre |
| Sonde plus lente | sonde | la médiane des réponses saines des 24 dernières heures vaut 1,5× celle des six jours d'avant, et 100 ms de plus au moins (20 mesures récentes, 50 anciennes) |
| Sonde instable | sonde | 6 bascules en 24 h entre « en ligne » et « en panne » — l'hystérésis évite l'alerte, pas la fragilité |
| Certificat non renouvelé | domaine | moins de 20 jours de validité : le renouvellement aurait dû passer à 30 |
| Sauvegarde en retard | application | 48 h sans sauvegarde réussie alors que la sauvegarde est active |
| Déploiements en échec | cible | les trois derniers déploiements de la semaine ont tous échoué |

Les seuils sont choisis pour **se taire** sur un parc ordinaire : une pente
sans régularité (r² faible) ou tirée de trop peu de jours ne dit rien. Une
prévision est **« bientôt »** quand son échéance est à trois jours ou moins ;
sans échéance, quand l'écart est franc — latence triplée, 12 bascules, 96 h
sans sauvegarde. **« À surveiller »** sinon.

**Des épisodes, comme les seuils.** La table `forecasts` tient un épisode
ouvert par `(nature, sujet)` — index unique partiel, comme
`target_metric_breaches`. Un constat nouveau l'ouvre, un constat qui dure le
met à jour (échéance, chiffres), un épisode sans constat se referme. Seules
l'ouverture et la fermeture s'écrivent au journal (`forecast.raised`,
`forecast.cleared`) ; seule l'ouverture est notifiable, **une fois** par épisode.

**Où elles se lisent.**
- La vue d'ensemble : une carte « À venir », sous le bloc d'attention. Rien
  quand il n'y a rien.
- L'aperçu du tiroir de leur sujet : cible, sonde, application.
- `GET /api/forecasts`, en phrases dans la langue de l'instance.

Chacune n'est montrée qu'à qui peut lire son sujet (`target:read`,
`monitor:read`, `application:read`).

## Notifications

Quatre canaux, treize événements, derrière un catalogue et une fabrique. Même
patron que `getDriver()`, `getScanner()` et `getAiProviderFactory()` — et le code
le revendique.

```ts
interface NotificationChannel {
  readonly kind: NotificationChannelKind;
  test(resolved: ResolvedChannelConfig): Promise<NotificationTestResult>;
  send(resolved: ResolvedChannelConfig, message: NotificationMessage): Promise<void>;
}
```

Le patron est même **plus strict** que pour les drivers : le catalogue est une
*donnée*, chaque champ y porte son propre schéma Zod et son type d'UI. Le
formulaire est généré depuis `presentNotificationChannels()`, la validation
depuis `channelConfigSchema()`. Ni l'UI ni les routes ne codent en dur le nom
d'un canal ou d'un champ. Ajouter un cinquième canal = une entrée dans le
catalogue, une classe, une ligne dans le registre. Le typage
`Record<NotificationChannelKind, …>` fait qu'un canal déclaré sans fabrique ne
compile pas.

### Les quatre canaux

| Canal | Champs | Secrets |
|---|---|---|
| `smtp` | `host`, `port` (587), `security`, `user`, `password`, `from`, `to`, `rejectUnauthorized` | `password` |
| `telegram` | `botToken`, `chatId`, `apiBaseUrl` | `botToken` |
| `discord` | `webhookUrl` (doit contenir `/api/webhooks/`), `username` | `webhookUrl` |
| `webhook` | `url`, `token` (envoyé en `Authorization: Bearer`) | `token` |

**SMTP et SMTPS sont un seul canal**, avec le champ `security` :
`starttls` (STARTTLS **obligatoire**, échoue s'il est absent), `implicit`
(SMTPS, session déjà chiffrée) ou `none`. Laisser nodemailer choisir
opportunistement reviendrait à accepter en silence une session en clair sur un
serveur mal configuré.

C'est **la seule voie e-mail de l'instance** : il n'existe aucun réglage SMTP
global ailleurs.

### Les vingt-deux événements

Tous dérivés du journal d'activité :

| Clé | Gravité | Action d'audit |
|---|---|---|
| `deployment.failed` | critical | `deployment.failed`, hors échec de scan |
| `deployment.scan_blocked` | critical | `deployment.failed` avec `failedStep === 'scan'` |
| `deployment.rolled_back` | warning | `deployment.rolled_back.automatic` |
| `deployment.succeeded` | info | `deployment.succeeded` — une version en ligne : l'application, sa version, la machine, l'URL. À choisir pour le salon de l'équipe, pas pour l'astreinte |
| `security.two_factor_reset` | warning | `user.2fa.reset` |
| `security.role_changed` | warning | `user.role.changed` |
| `security.api_token_created` | info | `api_token.created` — un jeton d'API créé : son nom, son préfixe, ce qu'il couvre, jamais le jeton |
| `security.signup_pending` | info | `user.created` avec le rôle `no-access` — une inscription publique attend qu'on lui choisisse un rôle |
| `security.host_key_changed` | critical | `target.host_key.mismatch` — une cible présente une autre clé d'hôte, une fois par clé |
| `monitor.down` | critical | `monitor.down` |
| `monitor.recovered` | info | `monitor.recovered` |
| `target.threshold.breached` | warning | `target.threshold.breached` |
| `target.threshold.cleared` | info | `target.threshold.cleared` |
| `target.unreachable` | critical | `target.unreachable` — deux relevés manqués de suite, avec la raison |
| `target.reachable` | info | `target.reachable` — de nouveau joignable, avec la durée de l'interruption |
| `image.update.available` | warning | `image.update.available` — une image déployée republiée, ou un tag plus récent de la même série ; voir [exploitation](exploitation.md#les-mises-à-jour-dimages) |
| `backup.failed` | critical | `backup.failed` — une sauvegarde d'application ou du panel, automatique, manuelle ou avant déploiement ; voir [exploitation](exploitation.md#sauvegardes) |
| `route.down` | warning | `route.down` — un domaine ne répond plus à travers son reverse proxy, deux sondes de suite ; voir [exploitation](exploitation.md#ce-qui-part-en-alerte) |
| `route.recovered` | info | `route.recovered` — ce domaine répond de nouveau |
| `route.certificate_expiring` | warning | `route.certificate.expiring` — le certificat d'un domaine expire sous quatorze jours : son renouvellement n'a pas abouti. Une fois par certificat |
| `route.certificate_renewed` | info | `route.certificate.renewed` — ce certificat a été renouvelé |
| `forecast.raised` | warning | `forecast.raised` — une [prévision](#prévisions) s'ouvre : un problème en vue, annoncé une fois. Sa fermeture (`forecast.cleared`) n'est pas notifiable |

**Un seul `monitor.down`**, pas un par nature de panne. Séparer « répond mal »
d'« injoignable » donnerait deux clés, donc deux groupes de regroupement, donc
deux résumés pour une panne d'infrastructure qui produit un mélange de 503 et de
connexions refusées. La nature est dans le contenu du message et dans la ligne
de résumé, jamais dans la clé.

**Le rétablissement est en `info`** : il ne demande aucun geste, il ferme une
alerte déjà reçue. Le peindre en rouge apprendrait à ignorer le rouge.

L'hystérésis n'est pas refaite ici : `nextMonitorState()` n'annonce une
transition qu'au seuil, donc une sonde qui oscille n'écrit rien dans
`audit_logs`, donc ne notifie rien.

Le point d'entrée est `logAudit()`, et un observateur y est posé **des deux
côtés** (panel et worker écrivent tous deux dans `audit_logs`). Corollaire
assumé : **un événement qui n'est pas audité n'est pas notifiable**.

Anti-doublon par déduplication BullMQ native, clé `(événement, ressource)`, TTL
5 min — BullMQ rejoue, et un rejeu écrivait trois `deployment.failed`.
`attempts: 1` : rejouer une distribution partielle re-notifierait les canaux déjà
servis. `notification.delivery.failed` est délibérément **non** notifiable, pour
la raison évidente.

Un canal injoignable ne casse jamais l'action notifiée : le `PATCH` qui a changé
un rôle rend `200`, et l'échec se lit sur le canal (`consecutive_failures`,
`last_error`) et dans le journal.

### Le bouton d'essai

« Envoyer un message d'essai » → `POST /api/notifications/channels/:id/test`,
permission **`settings:manage`** et non `settings:read` : un essai fait partir un
message vers un tiers, c'est une écriture vers l'extérieur.

Le panel ne peut pas envoyer lui-même — `nodemailer` est hors de son graphe. Il
enfile un job et attend 35 s. Le worker rapporte **deux étapes séparément** :

1. la **sonde**, qui ne délivre rien : `transporter.verify()` pour SMTP, `getMe`
   pour Telegram, un `GET` sur l'URL pour Discord. Le canal webhook générique n'a
   aucune sonde et **le dit** plutôt que de prétendre avoir vérifié ;
2. l'**envoi réel**.

## Tâches planifiées

BullMQ repeatable jobs. **Pas de cron Linux** — décision de `CLAUDE.md`, jamais
rouverte. Écran `/jobs`, `job:read` pour lire, `job:manage` pour agir.

| Type | Tâche BullMQ | Ce qu'elle fait | Ce qu'elle ne fait **pas** |
|---|---|---|---|
| `scan` | `scan:periodic` | relance les scanners sur les déploiements courants | ne redéploie rien, ne bloque rien — une CRITICAL **alerte** |
| `healthcheck` | `health:periodic` | sonde les déploiements courants, écrit `deployments.health_status` | **ne déclenche aucun rollback** |
| `cleanup` | `cleanup:versions` | `driver.pruneReleases()` — les 5 dernières versions, plus la courante | ne touche jamais la version en service |
| `preflight` | `target:preflight:all` | enfile un `target:preflight` par cible | ne modifie aucune cible |
| `backup` | `backup:schedule` | enfile une sauvegarde par application à sauvegarde automatique, sur chaque cible où elle tourne | ne restaure rien ; n'efface que ce que la rétention ne garde plus |
| `panel_backup` | `backup:schedule-panel` | sauvegarde la base du panel vers la destination | ne restaure rien — une restauration du panel se fait en ligne de commande |

Les deux tâches de sauvegarde n'ont pas à être créées à la main : activer une
sauvegarde automatique, sur une application ou pour le panel, crée la tâche si
elle n'existe pas — ou la réactive si on l'avait désactivée.

### Rien d'automatique et de destructeur

C'est la règle, et elle est **visible dans l'UI** : chaque tâche affiche ce
qu'elle ne fait pas, à côté de ce qu'elle fait. Un scan périodique qui remonte
une CRITICAL enregistre le finding, marque le verdict et écrit une ligne de
journal. Le déploiement reste en place, l'URL répond toujours.

`deployments.health_status` est distinct de `deployments.status`, délibérément :
un déploiement `success` peut devenir `unreachable` trois heures plus tard sans
cesser d'avoir réussi. Le statut de santé informe l'opérateur ; c'est lui qui
décide de la suite.

### Saisie simplifiée et fuseau horaire

L'écran propose une **saisie simple** (« tous les jours à 3 h ») qui écrit une
vraie expression cron en base, et bascule en **mode expert** dès qu'on saisit une
expression que le mode simple ne sait pas représenter. Relire une tâche simple
la rend en mode simple.

Chaque tâche porte **son propre fuseau**. Sans indication, elle prend celui des
paramètres d'instance au moment de sa création. « Tous les jours à 3 h » en
`Europe/Paris` tombe à 01:00 ou 02:00 UTC selon la saison — jamais à 03:00 — et
changer le fuseau d'une tâche existante **reprogramme sa prochaine occurrence
dans BullMQ**. Les tâches antérieures à la migration `0009` sont restées en UTC,
et leur prochaine occurrence n'a pas bougé.

### Réconciliation base ↔ BullMQ

**La base est la source de vérité, Redis n'est que l'exécutant.** Au démarrage du
worker, `reconcileSchedulers()` remet les deux d'accord : une tâche active et
absente de Redis y est réinstallée, un cron modifié est réappliqué, une tâche
désactivée ou supprimée est retirée, et tout scheduler orphelin disparaît.

Sans cette étape, un worker redémarré hériterait de l'état de Redis, qui peut
être n'importe lequel.

Le panel écrit lui aussi dans les deux, **base d'abord** : si l'écriture Redis
échoue, la base reste juste et le worker rattrapera l'écart. L'inverse laisserait
tourner une tâche que plus personne ne voit. Une tâche active mais absente de
BullMQ est **affichée comme telle** dans `/jobs` plutôt que masquée — c'est une
information d'exploitation.

Le handler relit la ligne en base à chaque occurrence : un scheduler resté dans
Redis alors que la tâche vient d'être désactivée n'exécute rien.

### Périodique ≠ pipeline

`runSecurityScan()` efface les exécutions précédentes du déploiement — une
relance rejoue l'étape et doit repartir d'une ardoise propre. Le scan périodique
passe `clearPrevious: false` : tout son intérêt est d'**empiler** les rapports
dans le temps sur un déploiement qui, lui, n'a pas bougé. Un seul drapeau, nommé,
plutôt que deux fonctions qui divergeraient.

`scheduled_job_runs` est une table dédiée et non des lignes d'`audit_logs`, parce
que ce ne sont pas les mêmes questions. Le journal répond à « qui a fait quoi » :
append-only, lu par un humain qui enquête. L'historique des exécutions répond à
« le scan de 4 h a-t-il tourné, combien de temps, et qu'a-t-il trouvé » : cadré
par une clé étrangère, purgé avec sa tâche, affiché en regard du cron. Chaque
exécution passe **aussi** par `logAudit()`.
