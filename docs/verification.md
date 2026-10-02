# Vérifier

Vingt-six scripts `./scripts/verify-*.sh`. Ils ne sont pas des tests unitaires :
ils empruntent **exactement les mêmes routes que l'UI**, contre une pile qui
tourne, avec `curl` + `jq`, et vérifient souvent l'effet réel sur la machine
cible ou en SQL.

Ils partagent leurs conventions :

```bash
./scripts/verify-secrets.sh
BASE_URL=http://localhost:3200 ./scripts/verify-secrets.sh
TARGET_NAME=ma-vm ./scripts/verify-purge.sh
```

- Chacun sort en code non nul au premier point en échec, et se relance.
- Chacun crée **sa propre matière** et la démonte à la fin, par un `trap`.
  Plusieurs comparent l'inventaire des applications avant et après pour prouver
  qu'ils n'ont touché à rien d'autre.
- `jq` est requis. La plupart ont besoin d'une cible Docker déployable —
  `./scripts/setup-test-target.sh` en provisionne une.
- Quand un script ne *peut pas* vérifier quelque chose, il le dit et saute, sans
  fabriquer de faux succès. C'est le cas de tout ce qui dépend d'un fournisseur
  d'IA sur cette instance.

## Ce que chacun prouve

### Socle

| Script | Ce qu'il établit |
|---|---|
| `verify-rbac-audit.sh` | un viewer se prend un `403` sur `POST /api/deployments`, et le refus apparaît dans les logs d'activité avec l'acteur **et l'IP derrière le reverse proxy** |
| `verify-targets-preflight.sh` | une cible est ajoutée avec une clé SSH, le preflight rapporte « Docker ✓ / K3s ✗ » sans recharger la page, le credential est illisible en base, et l'API ne le renvoie jamais — vérifié à toute profondeur du JSON |
| `verify-roles.sh` | les rôles sont des données : on en crée un, on modifie ses permissions, `admin` refuse d'être touché, un rôle porté refuse d'être supprimé, et **le seed ne réécrit pas une personnalisation** au redémarrage |
| `verify-account.sh` | mot de passe (l'ancien exigé, l'ancien meurt, les *autres* sessions tombent), TOTP en deux temps avec de vrais codes RFC 6238, un code de secours qui ne sert qu'une fois, et le secret absent de la base comme des logs |
| `verify-2fa-reset.sh` | la porte de sortie de qui a perdu son téléphone : `403` sans `user:reset-2fa`, la ligne **et** le drapeau effacés dans le même geste, sessions fermées, anciens codes de secours morts, un admin qui se réinitialise garde sa session, et rien de secret dans l'audit |
| `verify-onboarding.sh` | l'assistant redirige sur un état vierge et **ne cède pas au second passage**, la coquille est nue (aucun lien de navigation), quitter passe par une modale (cherchée jusque dans les chunks JS), une étape franchie survit à une reconnexion, passer ≠ terminer, et **une cible créée par l'assistant est identique en SQL à une cible créée par `/targets/new`** |
| `verify-settings.sh` | défauts complets sur base vierge, fuseau inventé refusé, **un PATCH partiel ne réinitialise aucune autre section** (au bit près, par empreinte), la clé d'API absente de toutes les pages, et un viewer voit les sections sans pouvoir les modifier |

### Déploiement

| Script | Ce qu'il établit |
|---|---|
| `verify-deploy-logs.sh` | une application créée depuis `simple.json` se déploie, les étapes s'enchaînent, les logs défilent en direct, l'URL répond — et **se rebrancher en cours de déploiement retrouve les logs déjà passés** |
| `verify-scanners.sh` | quatre déploiements de la même image volontairement vulnérable, en ne changeant que la politique de scan : blocage par Trivy, blocage par Grype seul, passage en `failOn: NONE`, SBOM téléchargeable. Le point clé est la comparaison **CVE par CVE** entre les deux scanners |
| `verify-ports-rollback.sh` | deux applications sur la même cible → deux ports distincts et deux règles UFW nommées par commentaire ; un destroy libère l'un sans toucher l'autre ; une v2 au healthcheck cassé → **rollback automatique**, statut `rolled_back` distinct de `failed`, diagnostic capturé, et l'URL sert de nouveau la v1 |
| `verify-appspec-generation.sh` | le prompt système est bien chargé depuis l'image (taille comprise, pas seulement un `ok`), la chaîne de génération sous modèle simulé, le rendu vers les deux runtimes, et une tâche `scan:periodic` qui tourne, survit à un redémarrage du worker, puis se désactive |
| `verify-secrets.sh` | le magasin de secrets, en 23 étapes : valeur générée non vide **acceptée par le moteur de base**, `.env` en 0600, empreinte identique après redéploiement, une seule ligne en base, invisible partout, rendu qui échoue **en nommant** le secret manquant tout en acceptant une valeur vide. Puis les alias : référence inconnue et cycle refusés à la validation, une ligne pour deux noms, **WordPress qui s'authentifie réellement sur MariaDB**, et la même carte de secrets côté Compose et côté Kubernetes |
| `verify-export.sh` | l'export des logs d'un déploiement en texte et en JSONL, avec les bons en-têtes, **autant de lignes qu'en base** (ce qui prouve que la pagination ne tronque pas), 404/422 sur identifiant fautif, et l'export tracé |

### Cycle de vie

| Script | Ce qu'il établit |
|---|---|
| `verify-force-delete.sh` | la garde, la cascade et le forçage. Le cas central : la cible est débranchée, le forçage exige le slug retapé, l'enregistrement part — puis **la cible est rebranchée, les conteneurs tournent toujours, et le script nettoie la machine avec la commande lue dans le journal d'activité**. Si le journal ne suffisait pas, le test échouerait |
| `verify-purge.sh` | purger n'est pas détruire : décompte exact en prévisualisation, une application en marche refuse (`409`), les entrées d'audit du run purgé sont toujours là, une réservation orpheline est rendue — et le trou corrigé, une version en service dont la dernière mise à jour a échoué refuse toujours la purge |
| `verify-workloads.sh` | l'inventaire distingue les charges du panel des autres, une charge du panel **refuse** d'être supprimée (`409`), une charge étrangère se met à jour et se supprime par la file en publiant sa progression en SSE, et les applications du panel tournent toujours à la fin |

### Supervision

| Script | Ce qu'il établit |
|---|---|
| `verify-supervision.sh` | la liste ne montre que ce qui tourne, le flux SSE remonte l'état des services et des logs attribués au bon service, **il tient dans la durée** (le piège des gardes de timeout SSH), le redémarrage passe par la file, et une application dont la dernière mise à jour a échoué reste listée avec un état qui le dit |
| `verify-server-supervision.sh` | les métriques sont **recoupées avec la machine elle-même** (`nproc`, `/proc/loadavg`, `/proc/meminfo`) ; puis `nproc` est temporairement caché pour prouver qu'une métrique manquante rend `null` **et pas zéro**, sans emporter le reste ; une cible injoignable garde ses applications à l'écran ; le dépliant est un vrai bouton accessible au clavier ; et le relevé passe bien par la file — vérifié en cherchant `ssh2` dans le bundle du panel, où il ne doit pas être |
| `verify-monitors.sh` | la SSRF (métadonnées, hors-liste, `localhost`, `file://`, identifiants dans l'URL, **et l'URL de webhook**), la cadence minimale par type, un rebond isolé qui ne crée aucun incident, la panne confirmée au seuil avec **une seule** alerte, la fermeture au rétablissement, le taux de disponibilité comparé à un historique fabriqué, la rétention qui supprime vraiment, et une sonde TLS pour prouver que l'abstraction accueille autre chose que HTTP |
| `verify-notifications.sh` | le catalogue est une donnée (et **aucun `schema` Zod ne fuit dans le JSON**, ce qui donnerait un formulaire vide sans erreur), les quatre canaux se configurent et s'essaient contre de vrais serveurs, chaque canal rend dans **sa** forme (MarkdownV2 échappé, embed Discord, en-têtes du webhook), un canal injoignable ne casse pas l'action notifiée, et un événement déclenche **un** envoi et un seul |
| `verify-schedules.sh` | la saisie simple écrit le cron attendu **en base**, la relecture rend le mode simple, une expression exotique bascule en mode expert, le fuseau est réellement appliqué (« 3 h à Paris » tombe à 01:00 ou 02:00 UTC selon la saison, jamais 03:00), changer le fuseau **reprogramme** l'occurrence dans BullMQ, et les tâches antérieures à `0009` n'ont pas bougé |
| `verify-ai.sh` | les trois fournisseurs sont configurables et le modèle par défaut suit le fournisseur, un `501` qui nomme ce qui manque, et surtout : la clé n'apparaît **nulle part**, y compris après un appel réel à chacun des trois fournisseurs avec une clé bidon — le script cherche aussi le **préfixe**, parce qu'OpenAI répond littéralement `Incorrect API key provided: sk-senti***…***0000` |
| `verify-monitor-notifications.sh` | une sonde qui oscille ne produit **aucun** message (l'hystérésis est en amont de l'audit, donc un rebond n'écrit rien), une panne confirmée part sur les canaux abonnés en quelques secondes, douze sites tombés produisent **deux** messages et non douze — une alerte immédiate et un résumé qui nomme les onze autres —, et le secret d'une sonde ne fuit ni dans l'API, ni dans le HTML, ni dans l'audit, ni dans les logs |
| `verify-host-history.sh` | un relevé écrit exactement une ligne, la courbe sur 24 h se reconstruit à la lecture, les trois couches de seuils se résolvent dans le bon ordre, un second seuil global est refusé **par la base** et non par un `if`, un dépassement confirmé écrit **une** entrée d'audit et pas une par relevé, la purge supprime les relevés au-delà de 30 jours sans emporter les dépassements, et le balayage tourne sans que personne le demande |
| `verify-stuck-deployment.sh` | un déploiement lent n'est **pas** un fantôme — le détecteur n'est pas une minuterie —, une tâche abandonnée par BullMQ est constatée par le worker qui arrête le déploiement à `failed` sans rejeu, le message enregistré nomme le projet Compose, la cible et le port encore réservé, et le déblocage manuel exige `deployment:purge` et non `deployment:destroy` |
| `verify-invitations.sh` | sans canal SMTP le parcours n'est pas proposé et aucun compte orphelin n'est créé, un compte invité n'a **littéralement aucune** ligne `credential`, le lien vaut une fois et une seule, une réinitialisation coupe les sessions en cours, une adresse inconnue ne se distingue pas d'une adresse connue — ni par le corps, ni par le temps de réponse —, et aucun jeton n'apparaît dans l'audit, les logs, ni les clés BullMQ de Redis |

## Les autres outils

| Commande | Ce qu'elle fait |
|---|---|
| `pnpm test` | 263 tests unitaires de `@pupitre/core` : crypto, AppSpec et ses refinements, alias de secrets, rendu Compose et K8s, normalisation des scans, génération IA sous modèle simulé, machine à états des sondes |
| `pnpm typecheck` | TypeScript strict sur les quatre projets **et** sur `scripts/` |
| `pnpm tsx scripts/render-both.ts <spec>` | rend une AppSpec vers les deux runtimes sans rien déployer, et **re-parse chaque manifest sérialisé** — un rendu qui ne repasse pas par son propre analyseur n'a rien prouvé |
| `pnpm test:driver <cible>` | un déploiement de bout en bout, en pilotant le driver en direct |
| `pnpm test:parity <docker> <k3s>` | le test de vérité — voir ci-dessous |
| `pnpm test:schedule` | traduction et calcul des expressions cron, hors ligne |
| `pnpm test:ai` | configuration multi-fournisseur, hors ligne |

## `pnpm test:parity` — le test de vérité

Une seule AppSpec, deux runtimes, jamais un champ modifié entre les deux. Il
pilote les drivers **en direct**, sans passer par le worker ni la file, et rend
un tableau à deux colonnes.

```bash
pnpm test:parity cible-docker-locale cible-k3s-locale
pnpm test:parity cible-docker-locale cible-k3s-locale --spec ma-spec.json --keep
```

Il enchaîne, pour chaque côté : `preflight` → `allocatePort` → `render` →
`upload` → `build` → `deploy` → `healthcheck` → **route posée sur le proxy de
la cible** et sondée à travers lui depuis la cible (à défaut de proxy, par le
port publié), puis `rollback` + resonde, puis `destroy` + contrôle des résidus.
Il sort en code 1 si **une seule** vérification échoue.

Il rend **32/32 au vert** au dernier passage, avec un Traefik sur chaque cible. Le tableau et son analyse sont
dans le [README](../README.md#limites-connues) : c'est le document qui porte
l'état daté du projet.

Prérequis : les deux cibles doivent être enregistrées et joignables **depuis le
poste** (`cible-docker-locale`, `cible-k3s-locale`) —
[`demarrage.md`](demarrage.md#la-cible-k3s-de-test) explique comment monter la
seconde, qui n'a pas de script.

## `pnpm test:proxy` — le reverse proxy, de bout en bout

Le pendant de la parité pour les domaines : sur chaque cible, avec le même code,
il installe Traefik par Pupitre (conteneur sous Docker, Traefik de K3s réglé),
le teste, le retrouve par la détection, déploie une petite application par son
driver, lui pose deux domaines — l'un en HTTPS avec redirection, l'autre en HTTP —,
vérifie qu'ils répondent **à travers le proxy**, que le certificat est émis, qu'un
domaine retiré ne répond plus.

Avant toute installation, une **phase 0** : les deux machines se joignent-elles,
dans les deux sens ? Par l'épreuve même du produit (`checkReach()`, celle du
test d'une liaison et du préflight) : une connexion ouverte de l'une vers un
écouteur éphémère de l'autre, sur un port de la plage des applications. Une
adresse injoignable doit être signalée telle, sans rien laisser derrière. Si
les machines ne se joignent pas, le proxy central n'est pas exercé — et c'est
compté en échec.

Puis le **proxy central**, dans les deux sens : le Traefik de la machine Docker
sert l'application déployée sur la machine K3s, et celui de K3s l'application
de la machine Docker. L'adresse d'arrivée du proxy est relevée comme le fait le
test d'une liaison ; l'application est publiée pour lui seul — `NodePort`
réservé par une `NetworkPolicy` côté K3s, port publié sur l'adresse privée côté
Docker (la boucle locale ne répond plus) ; côté K3s, un premier déploiement
réservé à une autre adresse vérifie que le proxy s'y voit **refusé**. Ses deux
domaines répondent à travers le proxy de l'autre machine, certificat émis, puis
tout est retiré et rien ne doit rester chez le proxy. Enfin, tout est détruit et
Traefik désinstallé.

Avec **`--proxy=bunkerweb`**, le même déroulé éprouve BunkerWeb : installé en
conteneur sur la machine Docker — sur la machine K3s, l'option doit se dire
indisponible et renvoyer vers la liaison —, testé, détecté, deux domaines,
puis son **WAF éprouvé depuis l'autre machine**, une adresse qu'aucune liste
blanche ne couvre : une injection SQL refusée (403) en « Protection », vingt
requêtes simultanées toutes servies, la même injection qui passe en «
Détection seule ». BunkerWeb n'acceptant que Let's Encrypt, ses certificats
viennent de Pebble par le relais `acme-front` (Caddy), dont le script fait
connaître les noms et l'autorité **au seul conteneur de test** — rien de cela
dans le code du produit. Le proxy central : le BunkerWeb de la machine Docker
sert l'application K3s, NetworkPolicy comprise.

```bash
docker compose --profile test up -d pebble pebble-dns acme-front
pnpm test:proxy cible-docker-locale k3s-locale
pnpm test:proxy cible-docker-locale k3s-locale --proxy=bunkerweb
```

Les certificats viennent de **Pebble**, le serveur ACME de test de l'équipe Let's
Encrypt : il valide réellement le défi HTTP-01 sur le port 80 de la cible, et
`pebble-dns` résout les domaines de test vers elle. Sans eux (`--no-acme`), tout
le reste est vérifié, sauf l'émission. Côté Docker, il vérifie aussi que le port
de l'application n'est publié que sur la boucle locale. **45/45** au dernier
passage pour Traefik, **30/30** pour BunkerWeb (`--proxy=bunkerweb`).

## `pnpm test:npm` — Nginx Proxy Manager, un proxy distant

Contre une vraie instance (2.16, service `npm-proxy` du profil `test`, ses
certificats émis par Pebble) et les deux cibles de test. Son administrateur
crée le compte de Pupitre aux droits conseillés — *Manage* sur les hôtes et
les certificats, visibilité *Created Items* —, puis : « Tester » passe, un
mauvais mot de passe est refusé en le disant ; la liaison est éprouvée
**à travers NPM** vers chaque cible (l'arrivée relevée sur Docker ; sur l'Alpine
de K3s, l'écouteur `nc` ne la note pas, et le résultat doit le dire), une
adresse qui ne mène nulle part est dite telle, aucun hôte de test ne reste ;
sur chaque runtime, un domaine posé — HTTP renvoie vers HTTPS, certificat de
Pebble, sondé depuis le panel ; deux certificats demandés en même temps sont
obtenus tous deux ; le domaine d'un autre compte est refusé sans gêner les
autres ; un joker déjà dans NPM est repris ; au retrait, les hôtes et les
certificats de Pupitre partent, le joker et l'hôte de l'autre compte restent,
et une machine ne touche pas aux domaines de l'autre. **15/15** au dernier
passage.

```bash
docker compose --profile test up -d pebble pebble-dns npm-proxy
pnpm test:npm cible-docker-locale k3s-locale
```

Le même parcours a été fait par le panel et son worker : connexion (refusée
puis acceptée), liaison des deux cibles, déploiement à domaine sur chaque
runtime par le pipeline, « Appliquer » qui redemande un certificat, sonde
périodique, destruction qui retire hôtes et certificats de NPM.

## `pnpm test:rollback` — revenir en arrière retrouve le bon code

Un commit de code ne change pas la version de l'AppSpec. Sur chaque runtime,
une application construite depuis son code : la release A, puis la release B
**de la même version** — chacune son répertoire et son image —, puis le retour
en arrière, qui doit servir A de nouveau. Côté Docker, une release d'avant le
nommage `{version}-r{numéro}` se retrouve encore, et une application déployée
avant la mise à jour reste pilotable. Enfin, assez de déploiements pour que le
ménage passe : les cinq releases les plus récentes restent, les autres partent
avec leurs images construites ; et la destruction ne laisse aucune image
construite derrière elle. **12/12** au dernier passage.

```bash
pnpm test:rollback cible-docker-locale k3s-locale
```

## `pnpm test:source-isolation` — un dépôt piégé ne passe pas

Sur chaque runtime, une application construite depuis l'archive d'un « dépôt »
qui porte, en plus de son code, un `compose.override.yml` (conteneur privilégié,
disque de la machine monté), un `docker-compose.yml` et un `.env` qui détournent
le nom du projet, et un dossier `k8s/` à appliquer. Le script vérifie que le
code est déposé dans `source/`, que l'application s'y construit et démarre
saine, et qu'aucun piège n'a pris : conteneur non privilégié et sans montage,
ni projet détourné ni service intrus, aucun objet du dossier `k8s/` dans le
cluster. **7/7** au dernier passage.

```bash
pnpm test:source-isolation cible-docker-locale k3s-locale
```

## Ce qui n'est pas vérifié

- **Aucun vrai modèle d'IA n'a répondu sur cette instance.** Voir
  [`ia.md`](ia.md#sans-clé).
- **Un vrai certificat Let's Encrypt par BunkerWeb.** `test:proxy
  --proxy=bunkerweb` obtient de vrais certificats, mais de Pebble, que le
  relais `acme-front` fait passer pour Let's Encrypt dans le conteneur de test.
  Un certificat de la vraie autorité demande un domaine public pointé sur une
  machine ouverte à Internet.
- **Le déploiement d'un service construit depuis un Dockerfile, par le panel.**
  Les deux drivers savent le faire, et `pnpm test:parity` le prouve — mais en
  pilotant les drivers en direct, avec un contexte de build qu'il fabrique
  lui-même. Ni `apps/web` ni `apps/worker` ne remplissent
  `DriverContext.additionalFiles` : par le panel, seules les applications en
  `source.type: "image"` se déploient. Voir
  [`feuille-de-route.md`](feuille-de-route.md).
- **Les sauvegardes n'ont pas de script de bout en bout.** `pnpm test` couvre
  le format chiffré (aller-retour, falsification, mauvaise clé), la signature
  SigV4 contre le vecteur d'AWS, le plan, la rétention, les destinations et le
  dossier local. Le reste a été joué à la main sur les cibles de test — export
  et restauration PostgreSQL, MariaDB et MongoDB, arrêt bref, restauration
  d'une sauvegarde Docker sur K3s, base du panel par la ligne de commande —
  vers un SFTP et un S3 compatible (CloudServer), **jamais vers AWS, Scaleway
  ou Backblaze réels**.
- Le point 9 de `verify-ports-rollback.sh` se contente d'un `pnpm typecheck` sur
  `test-parity.ts` au lieu de le jouer : il n'a qu'une cible Docker sous la main.
  La parité elle-même se joue par `pnpm test:parity`, séparément.
