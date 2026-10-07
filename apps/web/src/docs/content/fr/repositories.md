# Dépôts et code

Le code d’une application arrive par l’un de deux chemins : un **dépôt lié** que Pupitre suit — GitHub, GitLab, Gitea, Forgejo ou Codeberg —, ou une **archive** que vous téléversez. Ce chapitre couvre les deux, et les règles qui empêchent le code de commander la machine.

## Deux façons d’apporter le code

| | Un dépôt lié | Une archive téléversée |
|---|---|---|
| L’AppSpec vient de | le `pupitre.json` du dépôt | le panel |
| Le code vient de | l’archive du commit exact | la dernière archive téléversée |
| Une nouvelle version est | un nouveau commit, trouvé en interrogeant le dépôt chaque minute | une nouvelle archive, envoyée par un humain ou une CI |
| Se déploie seule | si vous le choisissez | jamais |
| Statut renvoyé | sur le commit, à la forge | — |

## Connecter une forge

**Paramètres → Dépôts de code** (`settings:manage`). Une connexion par forge et par instance.

**GitHub**, par une GitHub App :

1. **Créer la GitHub App** : Pupitre la prépare, vous confirmez sur github.com, et vous revenez au panel ;
2. **installez** l’App sur les dépôts ou l’organisation à suivre ;
3. les installations apparaissent ; leurs dépôts sont proposés au moment de lier.

**GitLab** — gitlab.com ou auto-hébergé —, par un jeton :

1. dans le projet ou le groupe, **Settings → Access tokens** : un jeton de projet ou de groupe, portée **`api`**, rôle **Maintainer** (une branche protégée n’accepte un statut que de quelqu’un qui peut y pousser) ;
2. dans Pupitre, l’adresse de l’instance et le jeton, puis **Tester** : il dit quel compte le jeton ouvre et quand il expire.

**Gitea, Forgejo ou Codeberg**, par un jeton :

1. sur la forge, **Settings → Applications** : un jeton d’un compte — un compte de service, de préférence —, portées `write:repository` et `read:user` ;
2. dans Pupitre, l’adresse de la forge et le jeton, puis **Tester**.

Les jetons et la clé privée de l’App sont chiffrés aussitôt et ne ressortent jamais.

## Le fichier pupitre.json

Le dépôt porte une AppSpec, et rien d’autre : pas de cible, pas de runtime, pas de script. Le dépôt dit *quoi* ; le panel dit *où* et *quand*, sous ses permissions — l’accès en écriture au dépôt ne devient jamais un droit sur les machines.

- À la racine, ou dans le dossier de l’application pour un monorepo — un dépôt peut en porter plusieurs, un par application ;
- seuls les changements sous le dossier du fichier concernent son application ;
- les contextes de construction sont relatifs à la racine **du dépôt**.

```text
dépôt/
├── pupitre.json            ← "context": "."
├── Dockerfile
└── src/
```

## Créer une application depuis un dépôt

**Applications → Nouvelle application → Depuis un dépôt** (`application:create`) :

1. choisissez le dépôt — chacun nomme sa forge — et la branche suivie ;
2. Pupitre cherche les fichiers `pupitre.json` de la branche et vous les propose ;
3. le fichier choisi est lu au commit de tête et validé : l’aperçu montre l’application, ou ce qui ne va pas ;
4. choisissez ce que fait un nouveau commit (ci-dessous) ;
5. **Créer** : l’application existe, sans cible — déployez-la depuis sa fiche. Chaque déploiement construit le code du commit dont l’application porte la version.

Le `name` du fichier nomme l’application **à sa création** ; ensuite, un renommage dans le dépôt est ignoré — ce nom est son projet sur les machines.

## Ce que fait un nouveau commit

| Choix | Effet |
|---|---|
| **Mettre à jour l’application** (`none`) | l’application prend l’AppSpec du commit ; rien ne se déploie — vous la déployez où et quand vous voulez |
| **La redéployer là où elle tourne** (`running`) | le commit part vers les cibles où une version est en service à ce moment, et nulle part ailleurs |
| **La déployer sur des cibles choisies** (`targets`) | le commit part vers les cibles du lien, que l’application y tourne ou non |

Pour les deux derniers, un mode décide si cela se fait seul :

- **automatique** — chaque commit se déploie ;
- **automatique sauf changement d’infra** — par défaut : un commit qui change un port, l’exposition, un domaine, des volumes, des secrets, des variables, des ressources, ou ajoute ou retire un service attend une approbation ;
- **toujours validé** — chaque commit attend.

La première vérification d’un nouveau lien enregistre le commit de tête sans déployer : lier un dépôt ne redéploie jamais ce qui tourne. En mode « mise à jour », **Mettre à jour depuis le dépôt** prend tout de suite le dernier commit de la branche.

## Approuver un commit

Un commit en attente d’approbation apparaît sur la fiche de l’application, avec ce qu’il change. **Déployer** l’envoie (`deployment:create`) ; **Ignorer** le laisse de côté — le commit suivant fait une nouvelle proposition. Par l’API : `POST /api/source-proposals/{id}/approve` ou `/dismiss`.

## Le statut sur le commit

Chaque déploiement renvoie son état au commit — en attente, réussi, échoué —, sous le nom `pupitre/{target}` : sur GitHub et Gitea dans les vérifications du commit, sur GitLab dans son onglet des pipelines. Un déploiement garde le dépôt, la branche, le commit et son lien : l’historique dit toujours quel code a tourné.

## Téléverser une archive

Pour une application **sans dépôt** — créée depuis un JSON, le catalogue, une description ou un fichier Compose — dont un service se construit depuis un Dockerfile, le code arrive en archive. Sur la fiche, onglet **Code**, la carte **Code de l’application** (`application:update`) :

- un `.tar.gz`, `.tar` ou `.zip`, 100 Mio au plus (1 Gio une fois décompressé) ;
- les contextes sont relatifs à la racine de l’archive ; un dossier de tête unique (`mon-app/…`) est retiré si les Dockerfiles ne se trouvent pas autrement ;
- `.git/`, `__MACOSX/`, `.DS_Store` et les fichiers `._*` de macOS sont écartés — gardez `node_modules/` et les sorties de construction hors de l’archive ;
- le worker la lit en quelques secondes : **prête**, avec le Dockerfile trouvé pour chaque service construit, ou **refusée**, avec la raison.

Déployer construit la dernière archive ; les cinq dernières sont gardées, pour qu’une version récente se redéploie avec **son** code. Depuis une CI :

```bash
curl --fail-with-body -X POST {{origin}}/api/applications/$APP_ID/archives \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "x-archive-name: build-$GIT_SHA.tar.gz" \
  --data-binary @build.tar.gz
```

La réponse (`202`) porte l’archive et son `status` ; interrogez `GET /api/applications/{id}/archives/{archiveId}` jusqu’à `ready`, puis déployez.

## Les garde-fous

Le code d’un commit — ou d’une archive — n’est qu’une entrée de construction :

- il est décompressé dans le dossier `source/` de la release, à l’écart des fichiers que Pupitre écrit : le `compose.override.yml`, le `.env` ou le dossier `k8s/` d’un dépôt ne sont jamais lus ;
- Compose est toujours appelé avec son projet et son fichier nommés, et le dossier Kubernetes est vidé avant chaque rendu ;
- un contexte de construction ne sort jamais du code : pas de chemin absolu, pas de `..` ;
- une archive est lue entrée par entrée et reconstruite : chemins absolus, `..`, liens qui sortent du code, périphériques, entrées en double la font refuser en entier ;
- l’image construite tourne durcie : racine en lecture seule, utilisateur sans privilège, aucune capacité.
