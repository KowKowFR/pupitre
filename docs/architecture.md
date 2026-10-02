# Architecture

[`CLAUDE.md`](../CLAUDE.md) porte les décisions. Ce document explique ce qu'elles
impliquent quand on ouvre le code — où regarder, et ce qui va vous surprendre.

- [Les quatre abstractions](#les-quatre-abstractions)
- [Dépôts liés](#dépôts-liés)
- [AppSpec — la spec neutre](#appspec--la-spec-neutre)
- [Pipeline de déploiement](#pipeline-de-déploiement)
- [Logs en direct](#logs-en-direct)
- [Ports : la base tranche, la cible vérifie](#ports--la-base-tranche-la-cible-vérifie)
- [UFW : une capacité du driver](#ufw--une-capacité-du-driver-pas-un-if-dans-le-worker)
- [Healthcheck : trois issues, pas deux](#healthcheck--trois-issues-pas-deux)
- [Rollback automatique](#rollback-automatique)
- [Versions et rétention](#versions-et-rétention)
- [Sauvegardes : un lieu, un format, deux runtimes](#sauvegardes--un-lieu-un-format-deux-runtimes)
- [Reverse proxy : la route au proxy, l'amont au driver](#reverse-proxy--la-route-au-proxy-lamont-au-driver)

## Les quatre abstractions

Le critère de qualité est écrit dans `CLAUDE.md` : **ajouter un runtime, un proxy,
un scanner ou un fournisseur de code doit se faire en ajoutant une classe**. Ce
qui suit est la conséquence pratique.

| Interface | Fichier | Implémentations |
|---|---|---|
| `DeploymentDriver` | `packages/core/src/drivers/types.ts` | `DockerComposeDriver`, `K3sDriver` |
| `ProxyProvider` | `packages/core/src/proxy/types.ts` | `TraefikProvider` (fichiers ou Ingress), `BunkerWebProvider` (API REST, WAF) |
| `Scanner` | `packages/core/src/scan.ts` | `TrivyScanner`, `GrypeScanner`, `SyftSBOM` |
| `SourceProvider` | `packages/core/src/sources/types.ts` | `GitHubSourceProvider` |

**`DeploymentDriver`** — `preflight` `allocatePort` `render` `upload` `build`
`deploy` `healthcheck` `rollback` `destroy` `logs` `pruneReleases`, plus les
méthodes d'inventaire `listWorkloads` `removeWorkload` `updateWorkload`
`controlWorkload` `workloadLogs` `execInWorkload`, la lecture `runningImages`
(les digests de ce qui tourne, pour les mises à jour d'images), les quatre
méthodes de sauvegarde `exportVolume` `importVolume` `exportFromService`
`importIntoService`, `upstream` — par où un reverse proxy joint l'application —,
plus une fabrique `getDriver(runtime)`.

Le driver **n'importe rien** de `packages/db`, de `apps/web` ni de Redis : il
reçoit tout par `DriverContext`, il exécute, et il émet des lignes via un
callback. C'est l'appelant qui décide de les publier sur Redis, de les écrire en
base, ou de les jeter.

La réservation de ports suit la même règle. Le driver a besoin de la table
`port_allocations`, mais n'a pas le droit de la connaître : le contexte porte une
interface `PortAllocator`, dont l'implémentation Drizzle vit dans `packages/db`.

**`ProxyProvider`** — `detect` `installOptions` `install` `uninstall` `check`
`apply` `probe` `publishAddress`, plus une fabrique `getProxyProvider(kind)`. Voir
[Reverse proxy](#reverse-proxy--la-route-au-proxy-lamont-au-driver).

**Deux méthodes sont optionnelles** — `openFirewall?` et `closeFirewall?`.
`DockerComposeDriver` les implémente, `K3sDriver` ne les déclare pas du tout.
Le pipeline appelle si la méthode existe ; il ne demande jamais quel runtime il
pilote, il demande ce que le driver sait faire.

La règle se vérifie en une commande :

```bash
grep -rn "runtime === '" apps packages --include='*.ts' --include='*.tsx' \
  | grep -v /drivers/ | grep -v /dist/
```

**Un seul résultat**, et il vaut d'être nommé plutôt que balayé :
`packages/db/src/deployments.ts:1506` choisit le mot « namespace » ou « projet
Compose » dans le message d'un déploiement abandonné. Aucun chemin d'exécution
n'en dépend — c'est du vocabulaire, pas une branche — mais la règle serait plus
propre si ce mot venait du driver. À cette ligne près, le seul endroit du dépôt
qui a le droit de savoir sur quel runtime il tourne, c'est un driver.

## Dépôts liés

Une application peut être liée à une branche d'un dépôt GitHub. Le dépôt porte un
`pupitre.json` — l'AppSpec, rien d'autre — à sa racine, ou dans le dossier de
l'application pour un monorepo.

- **Le dépôt dit quoi, le panel dit où et quand.** Cibles, runtime et mode de
  déclenchement vivent dans la liaison, sous RBAC. Le fichier ne porte ni cible,
  ni runtime, ni script : un droit d'écriture sur le dépôt ne devient pas un
  droit d'exécution sur les machines.
- **Polling, jamais de webhook.** Le panel est privé. Le worker demande chaque
  minute le dernier commit de chaque branche liée (`source:poll`, file de
  supervision), avec un ETag : « rien de neuf » répond 304 et ne coûte rien.
- **Où part un commit** (`deploy_to`), réglé par liaison :
  - `none` — **mettre à jour l'application** : elle prend l'AppSpec du commit,
    rien ne se déploie ; on la déploie ensuite où l'on veut ;
  - `running` — **la redéployer là où elle tourne** : les cibles sont celles où
    une version est en service à l'instant du commit ; ailleurs, rien ne
    s'installe ;
  - `targets` — sur les cibles de la liaison, qu'elle y tourne ou non.
- **Trois modes**, pour `running` et `targets` : automatique ; automatique sauf
  changement d'infra (le défaut) ; toujours validé. Ce qui est de l'infra est
  décidé par `classifySpecChange()` : port, exposition, domaine, volumes, secrets,
  variables, ressources, services ajoutés ou retirés.
- **Le commit de l'application.** Chaque liaison retient le commit dont
  l'application porte l'AppSpec (`synced_sha`). Un déploiement lancé à la main —
  tiroir, « Nouvelle application » — emporte ce commit : c'est son code qui se
  construit, où que l'application aille.
- **Créer depuis le dépôt.** « Nouvelle application → Depuis un dépôt GitHub »
  cherche les `pupitre.json` de la branche (`findFiles()`), lit et valide celui
  qu'on choisit au commit en tête, puis crée l'application et sa liaison, sans
  cible : le `name` du fichier devient celui de l'application.
- **Le code voyage en archive, et reste à part.** Le worker télécharge
  l'archive du commit exact et la passe au driver (`DriverContext.sourceArchive`),
  qui la décompresse dans **`source/`** de la release — jamais à côté de ses
  propres fichiers (`compose.yml`, `.env`, `k8s/`). Les contextes de construction
  de l'AppSpec sont relatifs à la racine du dépôt et s'y résolvent
  (`buildContextPath()`), et ils ne peuvent pas en sortir : ni chemin absolu, ni
  `..`. Le build reste sur la cible, sans registry.
- **Compose est toujours désigné.** Chaque appel passe `-p app-{slug}
  -f compose.yml` : rien de ce qui traîne dans le dossier — un
  `compose.override.yml`, un `.env` qui renommerait le projet — n'est lu.
  Côté K3s, le dossier `k8s/` est vidé avant chaque rendu : `kubectl apply`
  n'applique que ce que Pupitre vient d'écrire.
- **Tout est tracé.** Chaque déploiement garde le dépôt, la branche et le commit ;
  son état est renvoyé sur le commit GitHub (`pupitre/{cible}`).

La première vérification d'une liaison enregistre le commit en tête sans
déployer : lier un dépôt ne doit pas redéployer ce qui tourne. « Déployer ce
commit » le fait à la demande.

## AppSpec — la spec neutre

`packages/core/src/spec/app-spec.ts`. **Aucun champ ne peut être rattaché à un
runtime** : pas de `restart_policy`, pas d'`image_pull_policy`, pas de
`namespace`. Ce que la spec ne sait pas dire, le driver le décide — la politique
de redémarrage, le nommage des images, le réseau. Un test le vérifie en
inspectant les clés déclarées du schéma (`neutralité vis-à-vis du runtime`).

Refinements Zod : un seul service `exposed`, noms uniques, `dependsOn` référence
des services existants, pas de cycle (parcours en profondeur), `ingress.targetService`
existe, pas de clé déclarée à la fois en `env` et en `secrets`, pas d'alias de
secret vers un nom inconnu, pas de cycle d'alias.

Trois fixtures dans `packages/core/src/spec/__fixtures__/` : `simple.json`
(une API), `fullstack.json` (front + api + postgres, volumes et `dependsOn`),
`invalid.json` (violations, une par refinement).

**Rendu Compose** — le driver construit un modèle typé, puis le sérialise en
YAML. Jamais de concaténation de chaînes : un test injecte des guillemets, des
sauts de ligne et des pièges YAML dans les variables d'environnement, et vérifie
qu'ils traversent intacts. Les deux fixtures valides sont soumises à
`docker compose config` — c'est Docker lui-même qui valide le rendu.

Isolation : un projet Compose par application (`app-{slug}`), son réseau bridge
(`app-{slug}-net`), ses volumes nommés préfixés. Les secrets ne sont jamais
inscrits dans le `compose.yml` : ils arrivent par un `.env` déposé en 0600.

**Rendu K3s** — un namespace `app-{slug}`, puis des manifests numérotés par ordre
d'application : `0-namespace`, `10-configmap`, `20-secret`, `30-persistentvolumeclaim`,
`40-deployment`, `50-service`. Pas de port hôte ni d'Ingress : l'exposition passe
par le reverse proxy du cluster, qui joint le Service — `allocatePort()` rend
`null` et l'étape est `skipped`, `upstream()` rend le Service.

Pour voir les deux rendus côte à côte sans rien déployer :

```bash
pnpm tsx scripts/render-both.ts packages/core/src/spec/__fixtures__/simple.json
```

## Catalogue — des AppSpec toutes faites

`packages/core/src/catalog/`. Un modèle est une **fonction qui rend une AppSpec**
à partir de quatre paramètres (nom, domaine, TLS, e-mail de la personne qui
installe) — jamais un `compose.yml` recopié d'un README. Il passe par le même
`appSpecSchema` que le reste, se déploie donc sur les deux runtimes, et un test
instancie chaque modèle avec et sans domaine.

Ce que l'AppSpec ne sait pas dire, le catalogue ne le dit pas : une image qui
exige une commande de démarrage (MinIO, Keycloak), une URL de base de données
avec le mot de passe dedans (Umami, Outline) ou la socket Docker (Portainer)
n'y entre pas. Les mots de passe partagés entre une application et sa base
passent par les alias de secrets `{ name, from }`.

Les secrets qui servent à **se connecter** sont saisis à l'installation
(`askedSecrets`) : un secret généré ne se relit jamais, un mot de passe
d'administration généré serait perdu. Les autres sont générés.

Installer (`POST /api/catalog/{id}`) crée l'application, sans la déployer. Le
choix de la cible reste le geste habituel, avec son pipeline et ses scans.
Ajouter un modèle : une entrée dans `templates.ts`, rien d'autre.

**La preuve, sur une vraie cible** — `pnpm test:catalog <cible>` déploie chaque
modèle par le driver (pull compris), attend sa sonde, le requête en HTTP depuis
la cible sur son chemin de santé, puis le détruit et vérifie que rien ne reste.
`--prune-images` vide les images entre deux modèles : réservé à une cible de
test. Une image sans variante pour l'architecture de la cible est rapportée à
part, hors des échecs : c'est un fait sur l'image, pas sur le modèle.

## Import d'un docker-compose.yml

`packages/core/src/compose/` (sous-chemin `@pupitre/core/compose`, pour que
l'analyseur YAML reste hors du navigateur). Le fichier devient une AppSpec
**proposée**, jamais enregistrée d'office : elle part dans l'éditeur de
« Nouvelle application », et c'est la création habituelle qui l'enregistre.

Rien n'est silencieux : chaque clé du fichier est traduite, ou nommée dans un
message, à l'un de trois niveaux.

- **bloquant** — l'application ne fonctionnera probablement pas sans une
  décision humaine : `command`/`entrypoint` (l'AppSpec n'en porte pas), la
  socket Docker, un fichier de l'hôte monté, `privileged`, `network_mode`… Ce
  qui touche à l'isolation n'est jamais traduit « au mieux ».
- **approximation** — un dossier de l'hôte devient un volume nommé vide, un
  port non déclaré est deviné d'après l'image, une variable `${…}` prend sa
  valeur par défaut.
- **ignoré à dessein** — `restart`, `container_name`, les réseaux : Pupitre en
  décide.

Les variables qui ressemblent à des secrets ne sont jamais reprises en clair :
elles deviennent des secrets générés, et deux noms qui partageaient la même
valeur (ou la même variable du shell) deviennent un secret et un alias. Un
seul service est exposé — celui qui publie un port, le mieux nommé s'ils sont
plusieurs — et un domaine se lit dans les labels Traefik. Le YAML est lu avec
une limite d'alias : un fichier piégé ne fait pas exploser la mémoire.

## Pipeline de déploiement

`POST /api/deployments` **crée les onze étapes en base, toutes en `pending`**,
enfile le job, et répond `202` sans rien attendre. L'UI affiche donc le pipeline
complet avant que le worker n'ait commencé.

```
preflight → allocate_port → render → upload → build → scan → backup → deploy → healthcheck → proxy → rollback
```

`backup` sauvegarde les données de l'application juste avant de toucher à ce qui
tourne — `skipped` sans politique « avant chaque déploiement », et au premier
déploiement, où il n'y a rien à sauvegarder. Son échec arrête le pipeline :
mieux vaut un déploiement qui n'a pas lieu qu'une mise à jour sans filet.

`rollback` est déclarée comme les autres, et `skipped` quand tout va bien. Une
étape surgissant en cours de route ferait mentir le compteur « n / total » de
l'UI et obligerait le client SSE à gérer un cas de plus. Un rollback qui n'a pas
eu lieu est une information, pas un trou.

Chaque étape va de `pending` à `running` puis à `success`, `failed` ou `skipped`.
Un échec arrête le pipeline et marque le reste `skipped`.

**Aucun `if (runtime === ...)` dans le worker.** Une étape est `skipped` quand le
driver ou le proxy n'ont rien à faire — `allocatePort()` en K3s, `build()` sans
service à construire, une application sans domaine ou une cible sans reverse
proxy. Le worker enchaîne, il ne décide pas.

**Le job est idempotent.** Relancer un déploiement échoué remet en `pending` ce
qui n'a pas abouti et laisse les `success` intactes : seules les étapes non
réussies sont rejouées.

## Logs en direct

Le worker publie chaque ligne sur Redis (`deploy:{id}`) **et** l'ajoute à
`deployment_steps.log`. Redis porte le direct, la colonne porte la relecture.
Les écritures en base sont regroupées — une ligne de `docker compose pull`
toutes les 30 ms ferait autant d'`UPDATE`.

`GET /api/deployments/:id/logs` diffuse en SSE. L'ordre des opérations est ce
qui garantit l'absence de trou :

1. abonnement à Redis **avant** la lecture de l'historique ;
2. les messages reçus pendant la lecture sont mis de côté ;
3. envoi de l'historique persisté ;
4. vidage de la file, puis direct.

S'abonner après la lecture perdrait ce qui se produit entre les deux. Les deux
chemins appliquent la même déduplication, de sorte qu'un rafraîchissement de page
affiche exactement le même flux. Battement de cœur toutes les 15 s, connexion
Redis dédiée par flux, relâchée à la déconnexion du client.

Le même mécanisme sert ailleurs : `workload:{targetId}` pour la progression des
actions sur les charges d'une cible, et le flux d'état de services de `/apps`.

## Temps réel : présence, discussion, écrans vivants

Un canal Redis unique, `pupitre:realtime`, porte des événements typés et validés
(`@pupitre/core` → `realtime.ts`) : présence, messages de la discussion,
signaux d'écran (`live`), activité du journal. `GET /api/realtime` les relaie en
SSE — **un abonné Redis par processus**, pas par onglet, qui distribue en
mémoire aux flux ouverts.

Côté navigateur, **un seul flux pour tous les onglets** : ils élisent un meneur
(Web Locks) qui ouvre le flux et relaie aux autres (BroadcastChannel). En
HTTP/1.1, un flux par onglet épuiserait les six connexions par origine.

**Les écrans ne reçoivent jamais de données par ce canal.** Un signal dit
« les déploiements ont bougé » ; la page qui l'écoute (`<LiveRefresh>`) se
relit auprès du serveur, avec les permissions de la session. Signaux venus du
worker (début et fin des tâches BullMQ) et du journal d'audit (un observateur
nommé, à côté de celui des notifications). Au plus un rafraîchissement toutes
les 4 s, rien tant que l'onglet est caché. L'activité du journal ne part qu'aux
sessions qui ont `audit:read`.

**Présence** — dans Redis, pas en base : nombre d'onglets ouverts, dernier
signe de vie du flux, dernière interaction, choix de la personne (absent, ne
pas déranger). L'état affiché se déduit (`effectivePresence`) : hors ligne sans
onglet ou après 75 s de silence (processus tué), absent après 5 min sans
interaction. Un balayage toutes les 20 s, sous verrou Redis, annonce ce que le
temps seul fait changer.

**Discussion** — une bulle en bas à droite de chaque écran, qui ouvre le fil
par-dessus la page (couche 55 : sous les tiroirs et dialogues, qui piègent le
focus). Elle vit dans le layout : elle survit à la navigation, et le fil reste
à jour en direct même fermé. La bulle porte les non-lus — en rouge quand l'un
d'eux mentionne la personne ou répond à l'un de ses messages — et un « +1 »
s'en envole à chaque arrivée.

En base : `chat_messages` (avec `reply_to_id`), `chat_reads`, `chat_reactions`
(clé `(message, personne, emoji)` : réagir deux fois retire). Une mention est un
jeton `<@user|target|app:id>` posé par le compositeur, avec son libellé du
moment ; la route ne garde que celles que l'auteur a le droit d'ouvrir. Une
réaction n'est qu'un emoji (`isChatEmoji`), jamais du texte — sinon elle
deviendrait un second canal de messages. Texte brut, jamais de HTML. Un
message effacé garde sa ligne, vidée, et perd ses réactions ; effacer celui
d'un autre demande `user:manage` et passe par `logAudit()`.

## Ports : la base tranche, la cible vérifie

L'anti-collision **entre applications du panel** est la contrainte unique
`port_allocations (target_id, port)`. L'allocation ne fait jamais « SELECT puis
INSERT » : elle insère, et une violation `23505` renvoie le perdant au tirage
suivant. Deux workers simultanés ne peuvent pas obtenir le même port.

Reste ce que la base ne peut pas savoir : un service installé à la main sur la
machine, qui écoute déjà. Le driver le constate après coup (`ss -tlnH`, ou
`netstat -tln` sur les images qui n'ont pas `iproute2`), **abandonne** la
réservation devenue inutile et rejoue en excluant ce port. Une réservation déjà
acquise par l'application n'est jamais remise en cause : le port est occupé, oui,
mais par elle.

**La plage est portée par la cible** — `targets.port_range_start` /
`port_range_end`, défaut 30000-32767, avec une contrainte
`port_range_start <= port_range_end` en base. `DRIVER_PORT_RANGE` reste utile et
dit autre chose : ce que l'environnement du worker peut atteindre. Les deux sont
vraies, on garde **l'intersection** — garder la dernière lue en trahirait une.

**Le port est rendu à la destruction, et à l'échec.** La libération est dans un
`finally`, y compris pour un crash hors pipeline. La condition n'est pas « le
déploiement a échoué » mais « aucune version de cette application ne tourne sur
cette cible » : un échec survenu après un déploiement réussi — ou après un
rollback — laisse une version en service sur ce port, et le relâcher le donnerait
à quelqu'un d'autre.

`GET /api/targets/:id/ports` répond aux deux questions que la table seule ne sait
pas formuler : combien reste-t-il, et qui a quoi.

## UFW : une capacité du driver, pas un `if` dans le worker

```ts
openFirewall?(ctx, port): Promise<void>
closeFirewall?(ctx, port): Promise<void>
```

**La règle est identifiée par son commentaire**, `pupitre:{slug}`, jamais
par son numéro : `ufw status numbered` renumérote à chaque suppression, et une
règle effacée par index efface la voisine dès qu'une autre est partie
entre-temps. Le commentaire dit aussi à l'administrateur de la machine qui a
ouvert ce port et pour quoi.

**Le panel n'active jamais UFW de sa propre initiative.** Activer le pare-feu
d'une machine qu'on pilote en SSH est un excellent moyen de la perdre. S'il est
inactif ou absent, le driver l'écrit dans les logs du déploiement et continue :
le port publié par Docker reste joignable, c'est le filtrage qui n'existe pas.

## Healthcheck : trois issues, pas deux

La sonde respecte `retries`, `intervalSec` et `timeoutSec` de l'AppSpec, avec un
**backoff exponentiel plafonné** à 30 s — sans plafond, la cinquième tentative
attendrait seize fois l'intervalle demandé et le réglage n'aurait plus de sens.

| Issue | Ce qu'elle veut dire |
|---|---|
| `healthy` | le service répond, et il répond bien |
| `unhealthy` | il répond, mais hors 2xx/3xx — il tourne, il est cassé |
| `unreachable` | rien au bout : conteneur absent, port fermé, pod non prêt |

Un service **non exposé** est sondé en TCP, pas en HTTP : une image `postgres`
n'embarque ni `curl` ni `wget`, et lui poser une question HTTP produirait un
faux négatif.

**Le diagnostic est capturé avant que la sonde ne rende la main** — Docker :
`docker compose ps -a` plus les 200 dernières lignes de logs de chaque service ;
K3s : `kubectl get pods`, `describe` et `logs` des pods en cause. L'ordre est ce
qui compte : un rollback automatique redémarre l'ancienne version et effacerait
la scène. Le diagnostic part dans `deployment_steps.error` **et** dans le flux
SSE.

## Rollback automatique

Trois conditions, toutes des données : l'échec porte sur `healthcheck`,
`deployments.auto_rollback` est vrai (case cochée par défaut au formulaire), et
`previous_deployment_id` existe. Un échec ailleurs — un scan bloquant, un
`deploy` qui n'a jamais démarré — ne déclenche rien : il n'y a rien à défaire, la
version précédente n'a jamais cessé de tourner.

Le pipeline appelle `driver.rollback()`, puis **revérifie la santé de la version
restaurée avec sa propre AppSpec** — pas avec celle qui vient d'échouer. C'est
tout l'intérêt de figer l'AppSpec dans chaque déploiement : la v2 a pu déplacer
sa route de santé ou changer de port, et la sonder avec les réglages de la v2
poserait la mauvaise question à la bonne machine.

Le déploiement finit alors en **`rolled_back`**. L'UI le peint en ambre et
non en rouge : quelque chose s'est mal passé, et le filet a fonctionné.

Si le rollback échoue à son tour, le déploiement finit `failed` et l'erreur
nomme les deux échecs. **Jamais de second rollback** : rejouer la même commande
ne réglera pas ce qui vient d'échouer, et enchaîner les tentatives éloignerait la
machine d'un état connu.

## Versions et rétention

Il n'y a pas de table « versions » : **le déploiement *est* la version**, et son
`app_spec` figée est ce qui rend un redéploiement possible des mois plus tard,
même si l'application a changé depuis.

`POST /api/applications/:id/redeploy` n'est pas un rollback. Le rollback remet en
service une release déjà présente sur la cible ; le redéploiement refait un
pipeline complet — nouveau numéro, nouveaux scans — à partir de l'AppSpec de
l'époque. C'est ce qui permet de rejouer une version sur une *autre* cible, ou
après un `destroy`.

**Une release par déploiement.** Sur la cible, chaque déploiement dépose sa
release dans `{racine}/apps/{slug}/{version}-r{numéro}` (`releaseName()`), et les
images qu'il construit portent la même étiquette : `app-{slug}/{service}:1.0.0-r12`.
La version seule ne suffisait pas — un commit de code ne la change pas — : deux
déploiements de `1.0.0` partageaient un répertoire et une étiquette, le second
écrasait le premier, et revenir en arrière relançait le nouveau code. Le numéro
est celui du déploiement, propre à l'application. Une release déposée avant ce
nommage, sous la seule version, se retrouve encore : le rollback et les
opérations courantes (journaux, santé, redémarrage) la cherchent à l'ancien nom
quand le nouveau n'existe pas. Côté K3s, l'étiquette nouvelle change le gabarit
des pods : ils sont remplacés, et `rollout undo` retrouve l'image d'avant.

**Rétention : les cinq derniers répertoires de version**, ménage fait au
déploiement suivant — le seul moment où l'on sait laquelle vient de devenir la
courante. Le tri se fait sur la date de modification et non sur le nom : `1.10.0`
précède `1.9.0` lexicographiquement, et c'est l'ordre de déploiement qui compte.
La release pointée par `current` n'est jamais supprimée, même si elle est
ancienne — ce qui est exactement le cas après un rollback. Elle s'ajoute alors
aux cinq plus récentes : six répertoires au pire, jamais davantage. Les images
construites d'une release effacée partent avec elle (`docker image rm`,
`crictl rmi`) — une étiquette par release, sans ménage, remplirait le disque ;
une image encore employée est refusée, et c'est voulu.

`pruneReleases()` est une **méthode de l'interface** et non un détail interne :
la tâche planifiée `cleanup:versions` en a besoin depuis l'extérieur, et le
chemin des releases est une décision du driver, pas de l'appelant.

## Sauvegardes : un lieu, un format, deux runtimes

Trois pièces, chacune à sa place.

**Le driver sait lire et écrire des données, pas où les ranger.** Ses quatre
méthodes de sauvegarde échangent un **flux d'octets** avec la cible, par
`execPipe` — une commande SSH dont stdin et stdout sont des flux bruts, sans
découpage en lignes :

| Méthode | `DockerComposeDriver` | `K3sDriver` |
|---|---|---|
| `exportVolume` / `importVolume` | un conteneur `busybox` éphémère monte le volume, retrouvé par ses labels Compose, et `tar` | un pod d'aide monte le PVC, `tar` par `kubectl exec`, pod supprimé dans tous les cas |
| `exportFromService` / `importIntoService` | `docker exec` dans le conteneur du service | `kubectl exec` dans le pod du service |

La commande lancée dans le service — `pg_dumpall`, `mariadb-dump`, `mongodump`
et leurs réciproques — vient de `packages/core/src/backup/model.ts`, pas du
driver : quoi exporter est une affaire de moteur de base, pas de runtime. Elle
lit ses identifiants dans l'environnement que l'image a déjà reçu ; le panel ne
les voit jamais.

**`BackupStore` dit où.** `check` `put` `get` `remove` `removePrefix` `list` —
dans `packages/core/src/backup/stores/`, trois implémentations : `S3BackupStore`
(signature SigV4 écrite à la main, envoi en plusieurs parties de 16 Mio),
`SftpBackupStore` (empreinte d'hôte vérifiable), `LocalBackupStore` (un dossier
monté dans le worker). Une destination de plus, c'est une classe, son schéma Zod
dans `destinations.ts` et une ligne dans la table de `openBackupStore`.

**Le format `.pupb` dit comment.** Chaque morceau est chiffré en flux,
AES-256-GCM, sous une clé **dérivée** de `MASTER_KEY` par HKDF avec un sel tiré
au hasard pour chaque fichier. L'en-tête — `PUPB`, version, sel, IV — est
authentifié avec le contenu, l'étiquette GCM ferme le fichier. Un octet changé,
une clé différente : le déchiffrement échoue, il ne rend jamais un contenu faux.
Chaque sauvegarde dépose aussi son `manifest.json.pupb` : la liste de ses
morceaux, leurs tailles et leurs empreintes SHA-256, de quoi relire la
destination **sans** la base du panel — c'est le jour où elle est perdue qu'on
en a besoin.

Le chemin d'une sauvegarde ne touche jamais le disque du worker : cible → SSH →
gzip → chiffrement → destination, en flux, avec contre-pression. La restauration
fait l'inverse **en deux temps** : elle télécharge et vérifie tout (empreinte et
étiquette GCM) dans `BACKUP_TMP_DIR`, et n'applique rien tant qu'un seul morceau
est douteux. Une archive corrompue ne doit pas trouver une application à moitié
effacée.

Conséquence de la neutralité : une sauvegarde ne connaît que des noms de
l'AppSpec — service, volume, moteur. Rien n'y dit Docker ni Kubernetes.

## Reverse proxy : la route au proxy, l'amont au driver

Trois notions, chacune à sa place (`packages/core/src/proxy/model.ts`) :

- **la connexion** — un proxy que le panel pilote, rangé dans `proxies` : son
  genre, sa configuration, et s'il a été installé par Pupitre (`managed`) ou
  seulement trouvé. Au plus un par machine ; une machine sans proxy peut
  passer par celui d'une autre, par une **liaison** (`proxy_links`) — voir
  plus bas ;
- **la route** — un nom de domaine, une application, une cible, rangée dans
  `routes`. **Unique par nom, tenu par la base** : deux applications ne
  réclament pas le même domaine, et le perdant d'une course reçoit une 23505,
  comme pour les ports ;
- **l'amont** — par où le proxy joint l'application. C'est `driver.upstream()`
  qui le dit : le port publié côté Compose, le Service côté K3s. Le driver ne
  pose jamais de route ; le proxy ne sait pas sur quel runtime il route.

**Déclaratif.** `apply()` reçoit l'ensemble des routes d'une application et fait
en sorte que le proxy n'en ait pas d'autres : ajouter, retirer, modifier un
domaine, c'est le même appel, et une liste vide nettoie. Chaque objet posé
porte la marque de Pupitre et le nom de l'application — un proxy partagé avec
des routes faites à la main ne voit jamais celles-ci touchées.

**Traefik, deux façons d'être piloté** — ce sont ses propres fournisseurs :

| Mode | Ce que Pupitre dépose | Amont attendu |
|---|---|---|
| `file` | `{dossier}/{slug}.yml`, relu à chaud par Traefik | un port de la machine |
| `kubernetes` | des `Ingress` (et un `Middleware` de redirection) dans le namespace de l'application | un Service du cluster |

Le mode suit l'installation trouvée sur la machine, pas le runtime des
applications : c'est une propriété du proxy. Un amont que le mode ne sait pas
joindre est refusé, en le disant.

**Ce qu'un proxy dit de lui, sans rien exécuter.** L'écran et l'API ne
nomment jamais un proxy : chacun déclare une fiche (`traefik/config.ts`,
`bunkerweb/config.ts`), réunies dans `catalog.ts` — lire sa configuration, se
décrire, et ses **capacités** : HTTPS, certificats automatiques, WAF (le
champ Domaines propose alors une protection par domaine), et comment il joint
une autre machine (`remoteUpstream` : toute adresse, IPv4 seulement — le
Traefik d'un cluster —, ou pas du tout). Une option d'installation dit quelles
autorités de certification elle accepte ; la sonde reçoit du proxy ses
**signatures** — ce qu'il sert à un nom inconnu (Traefik : 404 et son corps ;
BunkerWeb : sa page par défaut, **en 200**) et le certificat qu'il présente en
attendant le vrai. Sans elles, une route absente passerait pour une route qui
répond.

**BunkerWeb, par son API.** Un service BunkerWeb par domaine, créé, modifié ou
retiré par l'API REST de BunkerWeb, appelée depuis sa machine par SSH. Le
jeton est lu dans le conteneur à chaque appel et passé à `curl` par un
fichier temporaire : il ne quitte jamais la machine. BunkerWeb n'ayant pas
d'étiquette où marquer ce qui est à Pupitre, un **registre** par application
(`{racine}/bunkerweb/routes/*.json`, sur sa machine) dit quels domaines Pupitre
y a posés : `planServices()` en tire ce qu'il faut créer, modifier, retirer —
sans jamais toucher un service fait à la main, ni retirer un domaine qu'une
autre application a repris. Son API relisant et réécrivant la configuration
entière à chaque appel, deux poses sur le même BunkerWeb passent l'une après
l'autre. Son nginx résolvant par DNS et pas par `/etc/hosts`, l'amont est
toujours une adresse IP : la passerelle Docker pour une application de sa
machine — c'est là que le driver la publie (`publishAddress()`), et pas sur
toutes les interfaces — ou l'adresse de la liaison pour le proxy central.
BunkerWeb appliquant en différé et revenant en silence à la configuration
précédente quand nginx refuse la nouvelle, `apply()` attend de voir les
domaines servis et, sinon, rapporte le refus lu dans son journal. Ses sondes
passent sa liste blanche par un en-tête secret (`ProbeSignatures.headerFile`,
lu par `curl -H @fichier`), pas par leur adresse.

**Le port de l'application n'est plus ouvert au monde.** Le pipeline dit au
driver comment la publier — `DriverContext.exposure`, une **intention**, pas un
runtime : `bindAddress` (où écouter), `allowFrom` (qui laisser entrer),
`byPort` (il faut un port). Chaque driver la traduit à sa façon :

| Qui sert l'application | `exposure` | Compose | K3s |
|---|---|---|---|
| un proxy de la machine | `bindAddress: 127.0.0.1` | port sur la boucle locale, pare-feu fermé | rien : le proxy du cluster joint le Service |
| le proxy d'une autre machine | `byPort`, `bindAddress` (l'adresse de la liaison si elle est à la machine), `allowFrom` (l'adresse d'arrivée du proxy) | port sur cette adresse, `ufw allow from` le proxy | `NodePort` sur le point d'entrée, `externalTrafficPolicy: Local`, `NetworkPolicy` qui n'accepte que le proxy |

Sinon, ce port en HTTP clair contournerait le HTTPS du proxy. Côté K3s, le
`NodePort` passe avant le pare-feu de la machine — d'où la `NetworkPolicy`, et
`Local` pour que le pod voie l'adresse d'origine. `apply` ne retirant rien, le
driver supprime la `NetworkPolicy` quand elle n'a plus lieu d'être.

**Le proxy central.** Une liaison (`proxy_links`) relie une machine au proxy
d'une autre, avec l'adresse par laquelle celle-ci la joint. `checkReach()`
(`packages/core/src/proxy/reach.ts`) l'éprouve pour de vrai : un écouteur
éphémère sur la machine servie, dans la plage des applications, et une
connexion depuis la machine du proxy qui doit en rapporter un jeton ; il en
tire l'adresse d'arrivée (NAT compris) et dit si l'adresse est à la machine.
Le test de la liaison et le **préflight** de chaque déploiement à domaines
d'une machine reliée passent par lui — un chemin bloqué arrête le déploiement
avant toute construction. `resolveServingProxy()` répond « qui
sert cette cible » — le sien, sinon celui de sa liaison — et tout le reste
(champ Domaines, pipeline, sonde) passe par lui. Pour le proxy, rien ne change
que l'amont : un port **avec une adresse** (`{ kind: 'port', host, port }`), et
une **portée** (`ProxyRouteSet.scope`) qui met la machine d'origine dans le nom
des objets — la même application peut tourner sur deux machines servies par le
même proxy. Le Traefik en fichier y route directement ; celui d'un cluster
reçoit un `Service` sans sélecteur et une `EndpointSlice` vers l'autre machine,
dans le namespace `pupitre-routes` — ni `ExternalName`, que Traefik refuse par
défaut, ni réglage du proxy. Le worker ouvre une session vers la machine du
proxy le temps de poser ou de sonder ; la tournée `routes:check` regroupe les
domaines par proxy.

**Un proxy hors des cibles : Nginx Proxy Manager.** Il tourne souvent sur une
machine à part, que Pupitre ne pilote pas : il ne la joint que par l'API de
NPM, avec un compte à lui. C'est le placement `remote` du modèle, et un second
contrat, `RemoteProxyProvider` — `check() apply() probe() reach()` —, sans ce
qui suppose une machine (ni détection, ni installation : on s'y connecte).
La fiche du catalogue dit le placement d'un genre ; le worker n'en sait pas
plus : `openProxy()` (`apps/worker/src/proxy/connect.ts`) rend les mêmes gestes
— poser, sonder, tester, éprouver une liaison — par SSH ou par l'API, et tout
le reste (pipeline, « Appliquer », destruction, tournée) passe par lui. La
connexion vit dans `proxies` sans machine hôte ; son mot de passe dans
`encrypted_secrets`, chiffré sous `MASTER_KEY`, déchiffré par le worker seul.
Elle sert des machines **par liaison**, toujours — l'amont est un port avec une
adresse, comme pour le proxy central. Trois choses changent de main :

- **la sonde** part du panel vers l'entrée de NPM (`probeDirect()`), le nom en
  `Host` et en SNI — et plus de la machine du proxy ;
- **le test d'une liaison** ne peut plus lancer `curl` depuis la machine du
  proxy : `checkReach()` reçoit une **origine** (`ReachOrigin`), et celle d'un
  proxy distant pose sur NPM un hôte éphémère vers l'écouteur, l'interroge par
  son entrée, puis le retire. NPM ne dit pas sa table de routage : l'adresse
  d'arrivée n'est relevée que par l'écouteur (python3 ou perl sur la machine
  servie), et le test dit quand elle ne l'est pas ;
- **les certificats** : NPM les demande lui-même à Let's Encrypt, au nom du
  compte ; un certificat déjà présent qui couvre le domaine (un joker obtenu
  par défi DNS) est repris tel quel.

Un domaine est un « proxy host » de NPM, marqué dans son `meta` (`pupitre` :
l'application, la portée, le certificat que Pupitre a demandé pour lui) : seuls
ceux-là sont lus, modifiés, retirés, et seuls leur domaine, leur amont et leur
HTTPS sont tenus — ce qu'on règle dans NPM sur ces hôtes reste. Trois
comportements de NPM sont contournés ici, et pas ailleurs : il recharge nginx
sans attendre qu'il ait pris (le test d'une liaison attend que son site par
défaut cesse de répondre pour le nom) ; pour un hôte déjà en service, il le
retire de nginx le temps d'une demande de certificat et lance certbot aussitôt
(un hôte neuf demande donc son certificat **avant** d'exister ; un hôte déjà là
a droit à un nouvel essai) ; et il refuse un second certbot pendant le premier
(les demandes d'un worker vers une instance passent l'une après l'autre).

**Dans le pipeline**, les domaines sont décidés avant le rendu — ils décident de
la publication du port —, et posés à l'étape `proxy`, après `healthcheck`. Puis
chacun est **éprouvé à travers le proxy**, depuis sa machine, le nom forcé vers
la boucle locale (`probe()`) : HTTP, HTTPS, redirection, et le certificat
présenté. Un domaine qui ne répond pas n'annule pas un déploiement sain — la
nouvelle version tourne — : la route est notée en échec et le journal dit
pourquoi. Seule une configuration que le proxy refuse fait échouer l'étape.

**Ensuite**, la tâche `routes:check` (toutes les dix minutes, file
`supervision`) sonde chaque domaine de la même façon. Deux échecs de suite font
tomber la route et écrivent `route.down` au journal — donc une notification —,
le retour écrit `route.recovered`. Un certificat en cours d'émission est relu à
30 secondes puis à 2 minutes, plutôt qu'à la tournée suivante.

**Avant ce modèle**, le driver K3s rendait lui-même un `Ingress` depuis
l'AppSpec, et le pipeline déposait sous Docker un fichier pour un Traefik
supposé présent. La migration `0027` a déclaré ces deux proxies tels qu'ils
étaient et changé en routes les domaines en service : rien ne casse à la mise à
jour. L'`Ingress` posé par le proxy porte le nom de l'ancien et le remplace.

