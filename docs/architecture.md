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

## Les quatre abstractions

Le critère de qualité est écrit dans `CLAUDE.md` : **ajouter un runtime, un proxy,
un scanner ou un fournisseur de code doit se faire en ajoutant une classe**. Ce
qui suit est la conséquence pratique.

| Interface | Fichier | Implémentations |
|---|---|---|
| `DeploymentDriver` | `packages/core/src/drivers/types.ts` | `DockerComposeDriver`, `K3sDriver` |
| `ProxyProvider` | `packages/core/src/proxy/` | `TraefikProvider` — `BunkerWebProvider` n'existe pas |
| `Scanner` | `packages/core/src/scan.ts` | `TrivyScanner`, `GrypeScanner`, `SyftSBOM` |
| `SourceProvider` | `packages/core/src/sources/types.ts` | `GitHubSourceProvider` |

**`DeploymentDriver`** — `preflight` `allocatePort` `render` `upload` `build`
`deploy` `healthcheck` `rollback` `destroy` `logs` `pruneReleases`, plus les
méthodes d'inventaire `listWorkloads` `removeWorkload` `updateWorkload`, plus une
fabrique `getDriver(runtime)`.

Le driver **n'importe rien** de `packages/db`, de `apps/web` ni de Redis : il
reçoit tout par `DriverContext`, il exécute, et il émet des lignes via un
callback. C'est l'appelant qui décide de les publier sur Redis, de les écrire en
base, ou de les jeter.

La réservation de ports suit la même règle. Le driver a besoin de la table
`port_allocations`, mais n'a pas le droit de la connaître : le contexte porte une
interface `PortAllocator`, dont l'implémentation Drizzle vit dans `packages/db`.

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
`packages/db/src/deployments.ts:1329` choisit le mot « namespace » ou « projet
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
- **Trois modes.** Automatique ; automatique sauf changement d'infra (le
  défaut) ; toujours validé. Ce qui est de l'infra est décidé par
  `classifySpecChange()` : port, exposition, domaine, volumes, secrets, variables,
  ressources, services ajoutés ou retirés.
- **Le code voyage en archive.** Le worker télécharge l'archive du commit exact
  et la passe au driver (`DriverContext.sourceArchive`), qui la décompresse à la
  racine de la release. Le build reste sur la cible, sans registry.
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
`40-deployment`, `50-service`, `60-ingress`. Pas de port hôte : l'exposition passe
par l'Ingress, donc `allocatePort()` rend `null` et l'étape est `skipped`.

Pour voir les deux rendus côte à côte sans rien déployer :

```bash
pnpm tsx scripts/render-both.ts packages/core/src/spec/__fixtures__/simple.json
```

## Pipeline de déploiement

`POST /api/deployments` **crée les dix étapes en base, toutes en `pending`**,
enfile le job, et répond `202` sans rien attendre. L'UI affiche donc le pipeline
complet avant que le worker n'ait commencé.

```
preflight → allocate_port → render → upload → build → scan → deploy → healthcheck → proxy → rollback
```

`rollback` est déclarée comme les autres, et `skipped` quand tout va bien. Une
étape surgissant en cours de route ferait mentir le compteur « n / total » de
l'UI et obligerait le client SSE à gérer un cas de plus. Un rollback qui n'a pas
eu lieu est une information, pas un trou.

Chaque étape va de `pending` à `running` puis à `success`, `failed` ou `skipped`.
Un échec arrête le pipeline et marque le reste `skipped`.

**Aucun `if (runtime === ...)` dans le worker.** Une étape est `skipped` quand le
driver ou le provider renvoie `null` — `allocatePort()` en K3s, `build()` sans
service à construire, `register()` sans `ingress.host`. Le worker enchaîne, il
ne décide pas.

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

**Rétention : les cinq derniers répertoires de version**, ménage fait au
déploiement suivant — le seul moment où l'on sait laquelle vient de devenir la
courante. Le tri se fait sur la date de modification et non sur le nom : `1.10.0`
précède `1.9.0` lexicographiquement, et c'est l'ordre de déploiement qui compte.
La release pointée par `current` n'est jamais supprimée, même si elle est
ancienne — ce qui est exactement le cas après un rollback. Elle s'ajoute alors
aux cinq plus récentes : six répertoires au pire, jamais davantage.

`pruneReleases()` est une **méthode de l'interface** et non un détail interne :
la tâche planifiée `cleanup:versions` en a besoin depuis l'extérieur, et le
chemin des releases est une décision du driver, pas de l'appelant.
