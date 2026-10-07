# Exploitation

Tout ce qui se passe une fois les applications en service : les surveiller, sonder leurs URL, anticiper les ennuis, faire taire les alertes pendant une maintenance, prévenir les visiteurs, notifier l’équipe, les tâches planifiées et les sauvegardes.

## Supervision : ce qui tourne

**Supervision** (`deployment:read`) montre une carte par machine, avec ses jauges — charge, mémoire, disque — et, repliées dessous, les applications qui y tournent. Une machine injoignable affiche « injoignable » à la place de ses jauges et garde ses applications à l’écran : elles viennent de la base, pas de la machine.

Une application en service s’ouvre dans un tiroir : l’état de chaque service, sa santé, et ses **journaux en direct**, lus sur la machine. Avec `deployment:restart` :

- **Redémarrer** — les services redémarrent, sans redéployer ;
- **Arrêter** — les processus s’arrêtent ; volumes, port et domaine restent, et la sonde de santé est suspendue. L’application reste listée, « arrêtée depuis… » ;
- **Démarrer** — la même version revient, telle qu’elle était.

Une application dont la dernière mise à jour a échoué reste listée, avec un état qui le dit : elle tourne toujours, dans sa version précédente.

## Les sondes

**Sondes** (`monitor:read`, écriture `monitor:manage`) : le worker vérifie des URL et des certificats depuis l’extérieur.

| Type | Réglages | Intervalle |
|---|---|---|
| `http` | URL, méthode (GET, HEAD, POST), statut attendu, mot-clé facultatif, délai | 30 s minimum, 60 s par défaut |
| `tls` | hôte, port, nom SNI, jours d’alerte (21 par défaut), délai | 1 h minimum, 6 h par défaut |

- **Pas de fausse alerte** : un incident s’ouvre après 3 échecs consécutifs (réglable) et se referme après 2 succès. La fiche dit « 1 échec sur 3 — non confirmé » en attendant.
- **L’alerte TLS fait échouer la sonde** : un certificat à 20 jours de son échéance avec une alerte à 21 jours est malade.
- **Adresses publiques seulement**, sauf si `MONITOR_ALLOWED_CIDRS` (sur le panel **et** le worker) autorise des adresses privées — cela se lève là et nulle part ailleurs. Les adresses link-local (métadonnées des clouds) restent toujours refusées.
- **Deux façons d’alerter** : les canaux de notification de l’instance suivent `monitor.down` et `monitor.recovered` ; une sonde peut aussi porter son propre webhook, pour le salon d’un client.

```bash
curl --fail-with-body -X POST {{origin}}/api/monitors \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Boutique","type":"http","config":{"url":"https://shop.example.com/","expectedStatus":200,"keyword":"Ajouter au panier"}}'
```

**Sonder** sur la fiche d’une sonde la vérifie tout de suite.

## Les prévisions

Toutes les trente minutes, le worker lit les séries que la base garde déjà et dit ce qui va casser si rien ne change — sans IA : une pente, une médiane, un compte.

| Prévision | Quand elle se lève |
|---|---|
| Disque qui se remplit | 95 % atteints en moins de 14 jours à la pente de la dernière semaine |
| Mémoire qui ne redescend pas | 95 % en moins de 7 jours, une montée régulière |
| Charge qui monte | le seuil de charge en moins de 7 jours, jour après jour |
| Sonde plus lente | le temps de réponse médian du jour vaut 1,5 fois celui de la semaine d’avant |
| Sonde instable | 6 bascules entre en ligne et hors ligne en 24 heures |
| Certificat non renouvelé | moins de 20 jours de validité |
| Sauvegarde en retard | 48 heures sans sauvegarde réussie alors qu’elle est active |
| Déploiements qui échouent | les trois derniers déploiements de la semaine sur une machine ont tous échoué |

Elles apparaissent dans une carte **À venir** de la vue d’ensemble et sur la fiche de leur sujet ; `GET /api/forecasts` les renvoie sous forme de phrases. Chacune ne notifie qu’une fois (`forecast.raised`).

## Les fenêtres de maintenance

« prod-1 en maintenance de 22 h à 23 h » : pendant une fenêtre, les **alertes de surveillance** de ses sujets sont retenues — sondes, relevés, seuils, domaines. La sécurité, les déploiements, les sauvegardes et les prévisions passent toujours. **Maintenances** (`maintenance:read`, planification `maintenance:manage`) :

1. **Planifier** — ou **Mettre en maintenance** depuis la fiche d’une cible ou d’une sonde ;
2. la période, dans le fuseau de l’instance — un mois au plus ;
3. les sujets : des cibles et des sondes. Une cible couvre les sondes des applications qui y tournent et leurs domaines ;
4. enregistrer : `maintenance.started` est annoncé au début.

À la fin, ce qui est **toujours** en panne part — une panne réparée pendant la fenêtre ne réveille personne —, puis `maintenance.ended` dit ce qui a été retenu. Une fenêtre en cours se termine avec **Terminer maintenant**, jamais en la supprimant.

## Pages de statut et annonces

**Pages de statut** compose des pages publiques, sans connexion, à `/status` ou `/status/{adresse}` (`status_page:manage`) :

| Bloc | Ce qu’il montre |
|---|---|
| État général | opérationnel, dégradé, panne partielle ou majeure, maintenance — et la dernière annonce |
| Titre, Texte | ce que vous écrivez, en texte brut |
| Services | des sondes sous un nom public, avec une barre par jour sur 30 jours et le taux de disponibilité |
| Maintenance | les fenêtres en cours et à venir qui touchent ces services |
| Incidents récents | les pannes de ces services sur 7, 14 ou 30 jours, avec leurs annonces |

Une page montre des **libellés choisis** et des états — jamais une URL, un message d’erreur ou le nom d’une machine. Une page non publiée répond 404.

Pendant une panne, **Annonces** (`status_page:announce`) dit aux visiteurs ce qui se passe, phase par phase — *Enquête en cours*, *Cause identifiée*, *Sous surveillance*, *Résolu* pour un incident ; *Prévue*, *En cours*, *Terminée* pour une maintenance.

## Les notifications

**Paramètres → Notifications** (`settings:manage`) : des canaux qui relaient les évènements du journal d’activité.

| Canal | Ce qu’il lui faut |
|---|---|
| E-mail (SMTP) | hôte, port, sécurité (`starttls`, `implicit` ou `none`), compte, expéditeur, destinataires |
| Telegram | un jeton de bot et un identifiant de conversation |
| Discord | une URL de webhook |
| Webhook | une URL, et un jeton facultatif envoyé en `Authorization: Bearer` |

Chaque canal s’abonne aux évènements qu’il veut — 24 en tout : déploiements échoués ou bloqués, retours en arrière, succès ; sécurité (rôle changé, jeton d’API créé, second facteur réinitialisé, clé d’hôte changée, inscription en attente) ; sondes en panne et rétablies ; seuils et joignabilité des machines ; mises à jour d’images ; sauvegardes échouées ; domaines injoignables, certificats qui expirent et renouvelés ; début et fin de maintenance ; prévisions. **Envoyer un test** vérifie le canal, puis envoie pour de vrai. Les messages sont écrits dans la langue de l’instance ; les rafales sont regroupées.

> [!NOTE]
> Un évènement absent du journal d’activité ne peut pas être notifié : les notifications sont construites à partir de lui. Un canal qui échoue ne casse jamais l’action qu’il rapporte — ses échecs se lisent sur le canal.

## Les tâches planifiées

**Tâches** (`job:read`, agir `job:manage`) : ce qui se déclenche tout seul, par la file — jamais un cron Linux.

| Type | Ce qu’elle fait | Ce qu’elle ne fait jamais |
|---|---|---|
| `scan` | réanalyse ce qui est en service | redéployer, bloquer |
| `healthcheck` | sonde ce qui est en service, enregistre sa santé | revenir en arrière |
| `cleanup` | retire les vieilles releases, en gardant cinq et l’actuelle | toucher la version en service |
| `preflight` | revérifie chaque cible | modifier une cible |
| `backup` | sauvegarde les applications en sauvegarde automatique | restaurer |
| `panel_backup` | sauvegarde la base du panel | restaurer |

Une cadence se saisit simplement (« tous les jours à 3 h ») ou en expression cron, avec son propre fuseau. **Lancer** déclenche une occurrence tout de suite, même sur une tâche désactivée — pour l’essayer avant de l’activer.

## Les sauvegardes

Deux choses sont sauvegardées : **la base du panel** — tout ce que Pupitre sait — et **les volumes de chaque application**. Le code, les images et les AppSpecs ne le sont pas : l’AppSpec est dans la base, les images se tirent ou se reconstruisent.

### La destination

**Paramètres → Sauvegardes** (`settings:manage`), une destination, **hors de la machine du panel** :

| Type | Ce qu’il faut donner |
|---|---|
| Stockage S3 | point d’accès, région, bucket, préfixe, clés d’accès et secrète — AWS, Scaleway, OVH, Backblaze B2, Wasabi, R2, MinIO |
| SFTP | hôte, port, compte, dossier, mot de passe ou clé privée, l’empreinte de l’hôte |
| Dossier monté | un dossier de la machine du worker, monté sur `/backups` |

Chaque enregistrement est suivi d’un test — écrire, relire, supprimer. Chaque sauvegarde est chiffrée, fichier par fichier, sous une clé dérivée de `MASTER_KEY`.

### Les sauvegardes d’une application

Dans l’onglet **Sauvegardes** de l’application (`backup:read`, réglages `backup:manage`) :

- **Sauvegarde automatique** — chaque nuit à 2 h par défaut, réglable dans **Tâches** ;
- **Avant chaque déploiement ou mise à jour** — l’étape `backup` du pipeline ; si elle échoue, le déploiement ne démarre pas ;
- **Mode** — à chaud ou court arrêt ;
- **Rétention** — les 3 dernières, puis une par jour sur 7 jours, par semaine sur 4 semaines, par mois sur 6 mois.

### À chaud ou court arrêt

**À chaud**, rien ne s’arrête : PostgreSQL (et PostGIS, pgvector, TimescaleDB), MySQL, MariaDB et MongoDB sont exportées avec leur propre outil — cohérentes par construction —, les autres volumes sont archivés tels quels. **Court arrêt** : l’application s’arrête, chaque volume est archivé, elle redémarre — le bon mode pour une base que Pupitre ne reconnaît pas, comme SQLite.

### Restaurer une application

**Restaurer** sur une sauvegarde (`backup:restore`) :

1. choisissez la cible sur laquelle restaurer — une autre, même de l’autre runtime, est possible ;
2. laissez **sauvegarder l’état actuel** coché : la restauration pourra alors être défaite ;
3. confirmez : chaque morceau est téléchargé et vérifié avant que rien ne soit touché ; les volumes sont remplacés, les exports rejoués, l’application redémarre.

Le code et la version déployés ne changent pas : seules les données reviennent.

### La base du panel

**Sauvegarder maintenant**, et une sauvegarde automatique à 1 h 30 par défaut. Elle se restaure en ligne de commande, panel et worker arrêtés :

```bash
docker compose stop panel worker
docker compose run --rm worker backup list
docker compose run --rm worker backup restore-panel panel/<folder> --yes
docker compose start panel worker
```

> [!CAUTION]
> `MASTER_KEY` n’est pas dans les sauvegardes, et sans elle aucune ne se lit. Gardez-la — avec `BETTER_AUTH_SECRET` — ailleurs que sur la machine du panel.

### Si la machine du panel est perdue

Sur une nouvelle machine : le même `.env` — la même `MASTER_KEY` avant tout —, `docker compose up -d postgres redis`, puis `backup restore-panel` depuis la destination (configurez-la d’abord sur un panel vide, ou téléchargez le fichier `panel.dump.pupb` et passez-le). La base restaurée connaît les sauvegardes des applications : restaurez-les depuis leurs pages.
