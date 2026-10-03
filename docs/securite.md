# Sécurité

- [Authentification et comptes](#authentification-et-comptes)
- [Ce qui vient d'ailleurs que le panel](#ce-qui-vient-dailleurs-que-le-panel)
- [RBAC — 34 permissions](#rbac--34-permissions)
- [Journal d'activité](#journal-dactivité)
- [Chiffrement](#chiffrement)
- [Magasin de secrets d'application](#magasin-de-secrets-dapplication)
- [Scanners de sécurité](#scanners-de-sécurité)

## Authentification et comptes

**Better Auth**, e-mail + mot de passe, sessions en base, plugins `admin` et
`twoFactor`. Le tout premier compte créé reçoit le rôle `admin`.

**Le middleware ne vérifie rien.** Il tourne en Edge, sans accès à la base : il
ne fait qu'un filtrage optimiste sur la *présence* du cookie de session.
L'autorisation réelle est faite côté serveur, dans les routes et dans les pages.

**Les routes d'administration de Better Auth sont fermées.** Son plugin `admin`
expose `/api/auth/admin/*` : lister, créer, bannir, supprimer des comptes,
changer un mot de passe, **se faire passer pour quelqu'un**. Pupitre a sa propre
API d'administration (`/api/admin/*`), qui passe par `requirePermission()`,
tient ses garde-fous et écrit au journal — ces routes-là ne feraient rien de
tout cela : une usurpation n'y laisserait aucune trace, et ce que l'usurpateur
ferait ensuite serait attribué à sa victime. Elles répondent 404, et chaque
tentative est notée (`auth.admin_route.refused`). Le serveur garde l'usage du
plugin (`getAuth().api.createUser`…), qui ne passe pas par HTTP ; le client ne
charge plus `adminClient()`.

Même chose pour **les routes du plugin `twoFactor`** (`/api/auth/two-factor/*`)
hors des deux vérifications de la connexion (`verify-totp`,
`verify-backup-code`) : activer, désactiver, régénérer les codes passe par
`/api/account/two-factor/*`, qui écrit au journal et refuse de retirer un second
facteur que le rôle exige. Ouvertes, elles contourneraient l'un et l'autre :
404, et `auth.two_factor_route.refused` au journal.

### Connexion unique (OpenID Connect)

Keycloak, Authentik, Google, Microsoft Entra : tout fournisseur qui publie une
découverte OpenID Connect, réglé depuis **Paramètres → Connexion unique**
(`settings:manage`). Le mot de passe reste possible pour qui en a un.

- **Le jeton d'identité est vérifié** contre les clés publiées par le fournisseur
  (`requireIdTokenVerification`), avec PKCE et un `nonce` : les groupes, donc
  les rôles, ne viennent que d'un jeton signé. L'émetteur annoncé par la
  découverte doit être celui qu'on a saisi — « Tester » le vérifie avant
  d'enregistrer, derrière la garde de sortie.
- **Le secret du client est chiffré** (`app_settings.sso_client_secret_encrypted`,
  sous `MASTER_KEY`), comme la clé d'IA : il ne ressort jamais de l'API, et le
  journal ne garde qu'un marqueur (`(défini)`).
- **Un compte local n'est lié que si le fournisseur déclare l'e-mail vérifié.**
  Le fournisseur n'est pas marqué « de confiance » : sans `email_verified`, la
  liaison est refusée (`account_not_linked`) — sans quoi quiconque peut se créer
  chez lui une adresse qu'il ne possède pas prendrait le compte Pupitre qui la
  porte. Côté Pupitre, la vérification locale n'est pas exigée : un compte créé
  par un administrateur n'a jamais cliqué de lien, et il est le bon.
- **Les rôles viennent des groupes**, par une liste ordonnée « groupe → rôle »
  (la première qui correspond l'emporte) et un rôle par défaut — « Sans accès »
  par défaut. Un compte naît directement avec le rôle de ses groupes. Si « le
  fournisseur fait foi », le rôle est recalculé à chaque connexion ; un
  changement s'écrit `user.role.changed` avec `source: 'sso'`, donc notifié
  comme tout changement de rôle. **Le dernier administrateur n'est jamais
  rétrogradé** par là (`auth.sso.role.kept`, `reason: 'last_admin'`).
- **Un compte désactivé dans Pupitre n'entre pas** par le fournisseur
  (`BANNED_USER`). Le second facteur de Pupitre ne s'applique pas à une
  connexion unique : c'est au fournisseur d'exiger le sien.
- **Tout est tracé** : `auth.sso.login.succeeded` (avec les groupes reçus),
  `auth.sso.login.failed` (avec le code d'erreur), `user.created` avec
  `origin: 'sso'`.

Better Auth fige ses fournisseurs à sa construction : `getAuth()` reconstruit
son instance quand la configuration effective change (`lib/sso.ts`). Les
sessions vivent en base et leurs cookies sont signés par `BETTER_AUTH_SECRET` :
une reconstruction ne déconnecte personne.

### Mon compte — `/account`

Écran self-service, sans permission RBAC : une session suffit.

**Changer son mot de passe** exige l'ancien. Sans cette exigence, un cookie volé
suffirait à s'emparer définitivement du compte. Le changement révoque **les
autres** sessions et garde celle qui vient de le faire. Ni l'ancien mot de passe,
ni le nouveau, ni leur longueur n'apparaissent au journal.

**Le second facteur est du TOTP**, `issuer: 'Pupitre'`, avec des codes de
secours. L'armement se fait en deux temps :

1. `POST /api/account/two-factor/setup` génère le secret, **sans l'activer**, et
   rend l'URI TOTP et les codes de secours. C'est la seule réponse du panel qui
   les porte : ils ne repassent ni par le journal d'audit, ni par les logs.
2. `POST /api/account/two-factor/activate` vérifie un premier code réel et arme
   le facteur.

Sans cette seconde étape, un utilisateur dont l'application d'authentification
est mal réglée se retrouverait enfermé dehors à la connexion suivante. Désactiver
le second facteur exige, là aussi, le mot de passe.

### Réinitialiser le second facteur de quelqu'un d'autre

`DELETE /api/admin/users/:id/two-factor`, permission **`user:reset-2fa`**. Elle
est distincte de `user:manage`, et le commentaire des permissions l'argumente :
le geste lève une protection sur un compte, il ne se donne pas en même temps que
le droit de changer un rôle.

Effet exact, dans une seule transaction : la ligne `two_factors` est supprimée,
`users.two_factor_enabled` repasse à `false`, **les appareils de confiance sont
révoqués** (un appareil de confiance saute le 2FA pendant trente jours — le
laisser vivre rendrait le nouveau facteur inopérant sur le navigateur qui avait
mémorisé l'ancien), et **toutes les sessions sont fermées**. La demande arrive
quand un appareil a été perdu ou volé ; laisser vivre la session ouverte sur cet
appareil viderait l'opération de son sens.

Un administrateur peut se réinitialiser lui-même : sa propre session est alors
préservée. Il ne gagne aucun accès qu'il n'ait déjà, et il évite d'ouvrir un
client SQL. Réinitialiser un compte qui n'a pas de second facteur rend un `409`.

L'action `user.2fa.reset` déclenche aussi une notification `security.two_factor_reset`.

### Le second facteur exigé

**Paramètres → Comptes et sessions** (`settings:manage`) règle qui doit en
porter un :

- **non** (le défaut) — chacun l'active, ou non, depuis « Mon compte » ;
- **pour les droits sensibles** — tout rôle qui porte au moins une permission
  de `SENSITIVE_PERMISSIONS` (`packages/core/src/permissions.ts`) : administrer
  comptes et rôles, régler l'instance, créer ou modifier une cible, piloter ses
  charges, créer une application ou la déployer, détruire, purger, restaurer.
  L'administrateur l'est toujours ; l'auditeur et l'observateur, qui ne font que
  lire, ne le sont pas ;
- **pour tous les comptes**.

Un compte tenu qui ne l'a pas encore **n'a accès qu'à l'écran qui l'active**
(`/two-factor-setup`), où toutes les pages le renvoient : chaque route protégée
répond `403 two_factor_required` (`permission.denied`, raison
`two_factor_required`), `can()` répond non à tout, la discussion et la présence
lui sont fermées — et **un jeton d'API de ce compte ne vaut pas mieux que lui**.
Seules les routes de son compte restent ouvertes. Cet écran vit hors du groupe
de routes `(app)`, comme l'assistant de démarrage : une redirection posée par
le layout `(app)` vers une page qu'il enveloppe ferait boucler le routeur
client de Next.
Une fois armé, il ne se désactive plus (`409 two_factor_locked`) : un appareil
perdu se règle par la réinitialisation ci-dessus, et le compte le réactive à la
connexion suivante.

**Un compte sans mot de passe**, qui n'entre que par la connexion unique, n'y
est pas tenu : il ne pourrait pas l'activer (Better Auth le demande avec le mot
de passe), et son second facteur est l'affaire du fournisseur d'identité.

L'écran dit, avant d'enregistrer, quels rôles la politique toucherait et combien
de comptes elle tiendrait à l'écart. Elle refuse d'exiger de son auteur un
second facteur qu'il n'a pas (`409 two_factor_self`) : l'enregistrement lui
fermerait aussitôt le panel.

### La durée des sessions

Même écran : une session se ferme **après une durée sans activité** — une heure,
huit heures, un jour, sept jours (le défaut) ou trente — et, si on le veut,
**après une durée absolue**, même active : un, sept ou trente jours, comptés
depuis la connexion.

La première est celle de Better Auth (`session.expiresIn`), qui prolonge une
session utilisée ; `getAuth()` reconstruit son instance quand elle change
(`lib/session-policy.ts`). La raccourcir vaut aussi pour les sessions déjà
ouvertes : leur échéance est ramenée à « maintenant plus la nouvelle durée ».
Le plafond absolu est tenu par `requireSession()`, qui retire la session de la
base et écrit `auth.session.expired` (raison `max_age`).

## RBAC — 34 permissions

`packages/core/src/permissions.ts` est le vocabulaire, partagé par le panel, le
worker et le seed. Une permission est une chaîne `ressource:action`.

| Ressource | Permissions |
|---|---|
| `user` | `read` `manage` `reset-2fa` |
| `role` | `read` `manage` |
| `target` | `read` `create` `update` `delete` |
| `application` | `read` `create` `update` `delete` |
| `deployment` | `read` `create` `rollback` `restart` `destroy` `purge` |
| `backup` | `read` `manage` `restore` |
| `workload` | `read` `manage` `exec` |
| `scan` | `read` `configure` |
| `job` | `read` `manage` |
| `monitor` | `read` `manage` |
| `audit` | `read` |
| `settings` | `read` `manage` |

Trois distinctions valent d'être comprises, parce qu'elles ne sont pas
cosmétiques :

- **`deployment:destroy` vs `deployment:purge`** — détruire retire l'application
  de la machine ; purger efface la trace en base. Deux gestes différents.
- **`user:manage` vs `user:reset-2fa`** — gérer les comptes au quotidien ne doit
  pas donner le pouvoir de lever le second facteur de quelqu'un.
- **`workload`, pas `container`** — sur une cible K3s ce sont des pods. Le mot
  Docker n'a pas sa place dans un vocabulaire partagé.
- **`backup:manage` vs `backup:restore`** — sauvegarder ne remplace rien ;
  restaurer écrase les données en service. L'opérateur a la première, pas la
  seconde.

### Les rôles sont des données, pas du code

`SEEDED_ROLES` — `admin`, `operator`, `auditor`, `viewer`, `no-access` — ne sont que des **valeurs de
départ**. L'autorité à l'exécution est la table `roles`, et un administrateur
peut créer d'autres rôles depuis `/admin/roles`. C'est pourquoi `RoleKey` est
délibérément une `string` et non une union figée : une union obligerait à
recompiler le panel pour créer un rôle.

| Rôle | Permissions |
|---|---|
| `admin` | les 34 — **verrouillé**, ni renommable, ni vidable, ni supprimable |
| `operator` | déploie et exploite : cibles (sauf suppression), applications, déploiements, rollback, restart, scans et `scan:configure`, sauvegardes sans restauration |
| `auditor` | les 12 permissions en `:read` — journal d'activité, comptes, rôles et paramètres compris |
| `viewer` | les 8 lectures de l'**exploitation** : cibles, applications, déploiements, sauvegardes, charges, scans, tâches, supervision. Ni `audit:read` (le journal porte des adresses IP et des e-mails), ni `user:read`, ni `role:read`, ni `settings:read` |
| `no-access` | aucune — le rôle d'une **inscription publique** (`SIGNUP_ROLE`) |

`admin` est le garde-fou qui empêche de se verrouiller hors de son propre panel.
Le seed est idempotent et rejoué à chaque démarrage, mais **il ne réécrit pas une
personnalisation** — `verify-roles.sh` le vérifie explicitement. La migration
`0034` suit la même règle sur une base existante : elle crée `auditor` et
`no-access` si leur clé est libre, et ne resserre `viewer` que s'il porte encore
exactement ses permissions d'origine.

**Une inscription publique n'ouvre rien.** Elle ne dit rien de qui s'inscrit :
avec `ALLOW_SIGNUP=true`, lui donner l'observateur ouvrait la lecture du parc à
n'importe qui. Le compte naît `no-access` et l'événement
`security.signup_pending` prévient les administrateurs. Sans aucune permission,
il n'est pas non plus **membre de l'équipe** (`requireTeamMember()`) : la
discussion et la présence, qui ne demandent aucune permission, lui répondent
`403`, et le flux temps réel ne lui porte que les signaux d'écran. Un rôle donné
ou retiré referme le flux à la relecture de session suivante (≈ 100 s).

### Un seul point de contrôle

```ts
const auth = await requirePermission(request, 'deployment:create');
```

→ le contexte si autorisé · `401` sans session · `403` sans la permission · et
**un `audit_log` écrit systématiquement sur refus**. Le wrapper `apiRoute()`
traduit ces erreurs typées en réponses HTTP ; aucune route ne fabrique de
401/403 à la main. Les pages ont leur pendant, `requirePagePermission()`, qui
redirige vers `/forbidden?permission=…` — un écran qui *nomme* ce qui manque.

Garde-fous métier : impossible de retirer le rôle admin au dernier
administrateur actif, de le désactiver, de le supprimer, ni d'agir sur son propre
compte.

### Jetons d'API

Une CI ne tient pas de session : elle présente un **jeton d'API**,
`Authorization: Bearer pup_…`, créé depuis « Mon compte ». `requirePermission()`
l'accepte à la place d'une session ; c'est toujours le même point de contrôle,
et le même audit.

- **Il agit au nom de son auteur, jamais au-delà.** Ses permissions sont prises
  parmi celles de l'auteur à la création (en demander une qu'on n'a pas est
  refusé, pas réduit en silence), puis **intersectées à chaque appel** avec ce
  que l'auteur peut aujourd'hui : un rôle retiré le réduit, un compte désactivé
  le coupe, un compte supprimé l'emporte (`on delete cascade`).
- **Il n'est gardé qu'en empreinte.** SHA-256 du jeton, rien d'autre : il porte
  256 bits d'aléa, il n'y a rien à deviner, donc rien à ralentir. Il n'est montré
  qu'une fois, à sa création. Son préfixe `pup_` le rend reconnaissable dans un
  dépôt ou un journal de CI.
- **Il ouvre l'API, pas le panel.** Les pages retirent l'en-tête `Authorization`
  avant de lire la session. Les routes qui ne demandent qu'une session — son
  compte, son mot de passe, la discussion, la présence, **ses jetons** — le
  refusent (`403 token_refused`) : un jeton ne fabrique pas d'autres jetons.
- **Limité à des applications, il échoue fermé.** Il n'est accepté que par les
  routes qui se déclarent `applicationScoped` et vérifient ensuite l'application
  visée (`requireApplicationScope()`) : déployer, suivre un déploiement et ses
  journaux, revenir en arrière, lire l'application, redéployer une version.
  Toute autre route le refuse, même sur sa propre application. Une route qui
  oublierait de vérifier ne peut pas le laisser passer — elle ne l'accepte pas.
  Un test (`apps/web/test/api-tokens.test.mjs`) fige la liste de ces routes et
  vérifie que chacune contrôle l'application.
- **Le journal dit quel jeton a agi.** `audit_logs.api_token_id` est renseigné
  par le contexte de la requête, comme le navigateur : aucun appel à
  `logAudit()` n'a à y penser. Le journal affiche « par le jeton « CI GitHub » ».
  Créer un jeton écrit `api_token.created` (son préfixe, jamais le jeton) et
  prévient par `security.api_token_created` ; le révoquer écrit
  `api_token.revoked`.
- **Échéance par défaut : 90 jours.** 30 jours, un an, ou sans échéance au choix.
  Un administrateur voit tous les jetons de l'instance sur « Utilisateurs » et
  peut en révoquer un (`user:manage`).

Un jeton ne passe pas le second facteur : c'est la nature d'un accès sans
navigateur. C'est pour cela qu'il se crée depuis une session — qui, elle, l'a
passé —, qu'il est limité dans le temps par défaut, et que sa création prévient.
Et quand l'instance exige un second facteur d'un compte qui ne l'a pas, ses
jetons sont refusés comme lui (`403 two_factor_required`).

## Ce qui vient d'ailleurs que le panel

### Une écriture vient du panel, ou elle est refusée

Le cookie de session est `SameSite=Lax` : un navigateur ne l'envoie pas avec un
formulaire posté depuis un autre **site**. Mais un site, c'est un domaine
enregistrable entier — `blog.exemple.fr` et `pupitre.exemple.fr` en sont un
seul —, et Pupitre déploie justement des sites, souvent sur des sous-domaines
voisins du panel. Une page piégée là-bas, ouverte par un administrateur
connecté, lui ferait poster ce qu'elle veut : `readJsonBody()` lit un corps
JSON même envoyé en `text/plain`, ce qu'un formulaire HTML sait faire.

`apiRoute()` refuse donc, avant toute chose, une requête d'écriture (tout sauf
`GET`, `HEAD`, `OPTIONS`) qu'un navigateur enverrait d'ailleurs
(`apps/web/src/lib/same-origin.ts`) :

- l'en-tête `Origin` doit être celui de `BETTER_AUTH_URL` — `null` compris
  parmi les refus ;
- à défaut d'`Origin`, `Sec-Fetch-Site` doit valoir `same-origin` ;
- une requête qui ne porte ni l'un ni l'autre ne vient pas d'un navigateur
  (`curl`, un script, le worker) et n'a pas de cookie à détourner : elle passe.

Le refus est un `403 cross_site_request`, tracé (`request.cross_site.refused`)
avec la raison. Conséquence pratique : le panel doit être ouvert à l'adresse de
`BETTER_AUTH_URL`, la même que Better Auth exige déjà pour la connexion.

Le `Content-Type` n'est pas exigé en plus : tout navigateur envoie `Origin` sur
une écriture venue d'un autre site, et un appel de l'écran qui oublierait
l'en-tête JSON casserait sans rien protéger de plus.

### Les en-têtes de protection

Sur toutes les réponses (`apps/web/next.config.ts`) : le panel ne s'affiche dans
aucune iframe (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) — une page
tierce ne peut pas le recouvrir pour faire cliquer à l'insu de quelqu'un —, plus
`nosniff`, `Referrer-Policy`, une `Permissions-Policy` fermée et HSTS (sans
effet en HTTP, sans `includeSubDomains`). `X-Powered-By` n'est plus envoyé. La
CSP s'arrête volontairement à ces directives : `script-src` demanderait des
nonces sur les scripts de Next, et `form-action 'self'` casserait la création
de l'App GitHub, qui poste un vrai formulaire vers github.com.

### La clé d'hôte des cibles

Sans vérification de la clé d'hôte, n'importe quelle machine intercalée sur le
réseau entre le worker et une cible pourrait se faire passer pour elle, recevoir
le mot de passe SSH ou sudo, voir et modifier les commandes. Le client SSH
(`connect()`, `packages/core/src/ssh/client.ts`) reçoit donc une politique de
clé (`SshTarget.hostKey`), et le worker la donne toujours : une seule fonction,
`sshTargetOf()` (`apps/worker/src/deploy/ssh-target.ts`), fabrique la connexion
d'une cible.

- **Confiance au premier contact** : une cible jamais jointe voit sa clé retenue
  (`targets.host_key_fingerprint`, `target.host_key.recorded` au journal).
- Ensuite, **une autre clé fait refuser la connexion**, sans nouvel essai
  (`SshHostKeyError`) : ce n'est pas un incident réseau. La clé présentée est
  notée en attente (`targets.host_key_pending`), et le journal le dit une fois
  par clé (`target.host_key.mismatch`), ce qui alimente l'événement de
  notification `security.host_key_changed` — pas à chaque relevé refusé.
- **Seul un humain tranche**, sur la page de la cible (`target:update`) :
  accepter la nouvelle clé ou garder l'ancienne, tracé
  (`target.host_key.accepted` / `.dismissed`, avec les deux empreintes).
- Changer l'adresse ou le port d'une cible oublie sa clé : c'est une autre
  machine.

Les outils de test (`scripts/test-*.ts`) ne donnent pas de politique : ils visent
des machines jetables, dont la clé change à chaque recréation.

### Les adresses que le worker appelle pour vous

L'API d'un Nginx Proxy Manager, un webhook de notification, un stockage S3, une
forge Gitea : le worker appelle une adresse saisie dans le panel. La supervision exige une
adresse publique ; ici, on ne le peut pas — ces destinations vivent souvent sur
un réseau privé, et c'est légitime. Mais aucune n'a de raison de viser une
adresse **lien-local** (`169.254.0.0/16`, `fe80::/10`) : c'est là que les clouds
servent les métadonnées de la machine, identifiants compris.
`assertEgressAllowed()` (`packages/core/src/egress.ts`) résout le nom et refuse
toute adresse lien-local, non spécifiée ou de multidiffusion, avant l'appel.

## Journal d'activité

Écrit **exclusivement** par `logAudit()` (`packages/db/src/audit.ts`), le point
d'entrée unique. Cette fonction ne lève jamais : un audit indisponible dégrade la
traçabilité, il ne casse pas la requête. L'IP est lue derrière un reverse proxy
(`x-forwarded-for`, premier élément).

L'écran s'appelle **Logs**, à `/admin/logs` (`audit:read`). Il s'appelait « Audit »,
et le vocabulaire RBAC a gardé `audit:read` — la permission n'a pas suivi le
renommage de l'écran, volontairement : renommer une permission casse les rôles
personnalisés en base.

`logAudit()` porte aussi la couche de notifications : un observateur global y est
branché, et **un événement qui n'est pas audité n'est pas notifiable**. C'est une
contrainte assumée, et c'est ce qui garantit qu'on ne peut pas notifier quelque
chose qui n'aurait laissé aucune trace.

## Un dépôt lié ne commande pas la machine

Pousser sur un dépôt lié ne doit pas valoir un accès aux machines. Le
`pupitre.json` dit **quoi** déployer ; les cibles, le runtime et le moment
restent au panel, sous RBAC. Le code du commit n'est qu'une entrée du build :

- il est décompressé dans `source/` de la release, à part des fichiers de
  pilotage. À la racine, un `compose.override.yml` du dépôt aurait été fusionné
  par Compose — conteneur privilégié, disque de la machine monté —, un `.env`
  aurait renommé le projet (un `down -v` visant une autre application), un
  dossier `k8s/` aurait été appliqué sur le cluster avec les droits de Pupitre ;
- Compose est toujours appelé avec `-p app-{slug} -f compose.yml`, et le dossier
  `k8s/` est vidé avant chaque rendu ;
- un contexte de construction ne sort pas du code envoyé : ni chemin absolu, ni
  `..` — sans quoi une image pourrait embarquer les `.env` des autres
  applications de la machine ;
- l'image construite tourne avec le durcissement de toute image « maison » :
  racine en lecture seule, utilisateur non privilégié, capacités retirées.

`pnpm test:source-isolation` le vérifie sur les deux runtimes avec un dépôt piégé.

### Une archive téléversée

Le code téléversé suit les mêmes règles — il finit dans `source/`, par le même
chemin —, et une de plus : **l'archive envoyée ne part jamais telle quelle sur
une machine.** Le worker la relit entrée par entrée, en écrivant lui-même chaque
fichier, et la refuse entière au premier de ces pièges :

- un chemin absolu, ou qui remonte (`..`) ;
- un lien symbolique qui pointe hors du code — y compris **une fois le dossier
  de tête retiré** : dans `mon-app/`, `lien → ../compose.yml` reste dans
  l'archive mais viserait les fichiers de pilotage de la release ;
- une entrée écrite à travers un lien de l'archive (`cache → …` puis
  `cache/piege`) ;
- un lien dur, un périphérique, un tube nommé, une entrée chiffrée ;
- deux entrées au même chemin, un fichier qui servirait de dossier ;
- plus de 50 000 entrées, ou plus de 1 Gio une fois décompressée — une archive
  qui gonfle s'arrête là, pendant la lecture.

Les droits sont ramenés à `0644` ou `0755` : le bit d'exécution survit, `setuid`
et `setgid` non. Les liens symboliques ne sont créés qu'une fois tout le reste
écrit. L'archive rendue, refaite par le worker, est la seule qui serve ensuite ;
les octets reçus sont effacés, refusés ou non.

Le format se lit dans les octets (jamais dans le nom ni dans l'en-tête), le nom
n'est qu'une étiquette — rien ne s'écrit sous ce nom —, l'envoi est borné à
100 Mio pendant le transfert, et `application:update` est exigé : téléverser du
code, c'est changer ce qui s'exécutera. Les tests unitaires
(`packages/core/test/source-upload.test.ts`) fabriquent ces archives piégées
octet par octet ; `scripts/verify-source-archive.sh` en envoie une par l'API.

## Chiffrement

`packages/core/src/crypto.ts` — **AES-256-GCM**, clé dérivée de `MASTER_KEY` par
HKDF-SHA256, format `version:iv:authTag:ciphertext` avec la version passée en
**AAD** (pas de downgrade v2 → v1). Le panel et le worker refusent de démarrer si
`MASTER_KEY` est absente ou fait moins de 32 octets.

Sept choses sont chiffrées par la même primitive, chacune dans sa colonne :

| Quoi | Colonne | Seul point de déchiffrement |
|---|---|---|
| Credential SSH d'une cible | `targets.encrypted_credential` | le worker, à l'ouverture de session |
| Valeur d'un secret d'application | `application_secrets.encrypted_value` | le worker, au rendu |
| Clé d'API de l'IA | `app_settings.ai_api_key_encrypted` | le panel, à l'appel du fournisseur |
| Secrets d'un canal de notification | `notification_channels.encrypted_secrets` | le worker, à l'envoi |
| URL de webhook d'une sonde | `monitors.webhook_url_encrypted` | le worker, à l'alerte |
| Clé privée de l'App GitHub | `source_connections.private_key_encrypted` | le panel et le worker, à l'appel de l'API GitHub |
| Jeton d'accès de la forge Gitea / Forgejo | `source_connections.token_encrypted` | le panel et le worker, à l'appel de l'API de la forge |
| Clés d'une destination de sauvegarde | `backup_destinations.encrypted_secrets` | le worker, à l'ouverture de la destination |
| Mot de passe d'un proxy distant (Nginx Proxy Manager) | `proxies.encrypted_secrets` | le worker, à l'appel de son API |

Les **fichiers de sauvegarde** sont chiffrés eux aussi, mais en flux et sous une
clé à part pour chaque fichier : HKDF de `MASTER_KEY` avec un sel tiré au
hasard, AES-256-GCM, en-tête authentifié — voir
[`architecture.md`](architecture.md#sauvegardes--un-lieu-un-format-deux-runtimes).
Une destination compromise ne livre que des octets illisibles ; une sauvegarde
modifiée est refusée, jamais restaurée.

**Le credential ne sort jamais du panel** : `getTarget()` et `listTargets()` ne
sélectionnent pas la colonne, donc la réponse HTTP ne peut pas la contenir, même
par oubli de filtrage. C'est une garantie structurelle, pas un `delete` en fin de
handler.

La clé d'API de l'IA est **hors du JSONB des paramètres**, et c'est ce qui permet
de sérialiser le JSONB entier dans une réponse ou une entrée d'audit sans risque.
À la lecture, l'API ne rend que `aiApiKeyConfigured: boolean` et
`aiApiKeyLast4: string | null`.

**Les messages d'erreur sont expurgés.** Pas seulement de la valeur exacte : aussi
des formes reconnaissables — `sk-`/`pk-`/`xai-`/`gsk-…`, un jeton bot Telegram
(`\d{6,12}:[A-Za-z0-9_-]{20,}`), la queue d'une URL de webhook Discord, un
`Bearer …`. Motif : OpenAI renvoie littéralement `Incorrect API key provided:
sk-senti***…***0000`, donc le fournisseur fuit lui-même un fragment de la clé.

Si `MASTER_KEY` change, le déchiffrement échoue en silence à l'affichage (la clé
reste « configurée », son `last4` devient `null`) et explicitement à l'usage. La
liste ne casse pas.

### Une clé valide n'est pas une clé sérieuse

La garde de démarrage ne vérifie qu'une **longueur**. Soixante-quatre zéros font
trente-deux octets tout comme une vraie clé — et c'est précisément la valeur que
livre `.env.example`. Une instance montée en recopiant l'exemple démarre,
chiffre, déchiffre, et passe tous les tests : le défaut est invisible par
construction, alors qu'il rend lisibles par quiconque tient une sauvegarde de la
base **les identifiants SSH de toutes les cibles**.

`masterKeyWeakness()` reconnaît donc les clés devinables à leur **forme** — un
ou deux caractères distincts, ou un motif court répété — et le panel comme le
worker l'écrivent dans leurs journaux au démarrage. Aucune clé tirée au sort ne
tombe dans ce filet ; c'est vérifié dans `packages/core/test/crypto.test.ts`.

Le panel juge de même `BETTER_AUTH_SECRET` (`secretWeakness()`), dont le
`.env.example` livre une phrase répétée. Better Auth s'en sert pour signer ses
cookies, et pour chiffrer le secret TOTP et les codes de secours de chaque
compte : le changer déconnecte tout le monde et rend illisible le second
facteur déjà armé, qu'il faut alors réinitialiser. Là encore, on avertit.

Ils **avertissent** sans refuser de démarrer, volontairement : la base contient
déjà des valeurs chiffrées sous cette clé, et une instance qui ne démarre plus
est une instance dont on ne peut plus extraire les identifiants pour les
rechiffrer. La rotation reste une décision de l'exploitant, et elle se fait dans
cet ordre :

```bash
openssl rand -hex 32          # la nouvelle clé
```

1. Relever, **avec l'ancienne clé encore en place**, tout ce qui est chiffré —
   les huit colonnes du tableau ci-dessus.
2. Remplacer `MASTER_KEY` dans `.env`, puis redémarrer panel et worker.
3. Ressaisir chaque valeur par l'API ou par l'écran qui la porte. Rien ne se
   rechiffre tout seul : les anciennes valeurs deviennent illisibles, pas
   invalides.

Inverser 1 et 2 perd les identifiants sans recours — c'est la garantie même du
chiffrement. Et les sauvegardes faites sous l'ancienne clé ne se relisent
qu'avec elle : gardez-la tant qu'elles comptent, ou refaites-en sous la
nouvelle.

## Magasin de secrets d'application

Le problème : un `compose.yml` versionné ne peut pas porter un mot de passe, et
personne ne veut saisir à la main le mot de passe d'un PostgreSQL qui n'existera
qu'au premier déploiement.

**L'AppSpec ne porte que des noms, jamais des valeurs.** Un service déclare
`secrets: ["POSTGRES_PASSWORD"]`, et c'est tout. Le panel génère la valeur,
la chiffre, l'attache à l'**application** — pas au déploiement — et la réutilise
telle quelle à chaque redéploiement.

```ts
const secretAliasSchema = z.object({
  name: envNameSchema,
  from: envNameSchema,   // nom du secret dont la valeur est reprise
});
const secretDeclarationSchema = z.union([envNameSchema, secretAliasSchema]);
```

Valeur générée : 24 octets aléatoires en base64url, soit 32 caractères sur
`A-Za-z0-9-_`. L'alphabet est choisi pour traverser sans échappement un fichier
`.env`, une ligne de commande, un `stringData` Kubernetes et une URL
`postgres://`.

Un secret **saisi** (`origin: provided`) est possible pour ce qui vient de
l'extérieur — un jeton d'API tiers. Une valeur **vide** est acceptée ; une valeur
**absente** ne l'est pas, et fait échouer le rendu avec un message qui nomme le
secret manquant. Les deux cas sont distincts et le code teste la présence de la
clé, pas sa vérité.

### Les alias, ou deux images qui veulent le même mot de passe

`mariadb:11` lit `MARIADB_PASSWORD`. `wordpress` lit `WORDPRESS_DB_PASSWORD`.
C'est le même mot de passe. Sans mécanisme dédié, le magasin tirait une valeur
aléatoire *par nom* — deux mots de passe différents, panne garantie.

```json
{ "name": "WORDPRESS_DB_PASSWORD", "from": "MARIADB_PASSWORD" }
```

L'alias **ne crée aucune ligne en base** : seules les racines sont stockées, et
la résolution a lieu dans du code neutre (`packages/core/src/drivers/secrets.ts`),
**avant** le rendu. Il le faut : Compose sait interpoler `${…}` depuis un `.env`,
Kubernetes non — résoudre dans les drivers aurait donné deux implémentations.

Deux validations, à la création de l'application et non au déploiement :

- un `from` qui ne désigne aucun secret déclaré → `422`, en le nommant ;
- un cycle d'alias → `422`, avec le chemin (`A → B → A`).

Plus les cas de bon sens : un alias vers lui-même, deux alias contradictoires
pour un même nom, un nom déclaré nu ici et aliasé ailleurs.

### Où les valeurs arrivent

| Runtime | Comment |
|---|---|
| Docker | un fichier `.env` déposé en **0600** à côté du `compose.yml`, et `env_file: ['./.env']` sur le service. **Jamais** dans le `compose.yml`, jamais d'interpolation |
| K3s | un `Secret` Kubernetes par service, `${service}-secrets`, en `stringData`, monté par `envFrom.secretRef`. Manifest écrit en 0600, appliqué avant les Deployments |

La carte livrée est **identique des deux côtés**, alias résolus compris —
`verify-secrets.sh` le prouve en comparant les empreintes SHA-256 des deux cartes.

### Ce que l'API rend, et ce qu'elle ne rend pas

`GET /api/applications/:id/secrets` (`application:read`) rend `name`, `origin`,
`isSet`, `declared`, `services`, `aliasOf`, `readAs`, `updatedAt`.
**Jamais la valeur** — la colonne chiffrée n'est même pas sélectionnée.
`PUT /api/applications/:id/secrets/:name` (`application:update`) pose une valeur
ou en régénère une ; poser une valeur sur un alias rend un `409` qui renvoie vers
la racine.

Il n'existe **aucun moyen de relire un secret**, ni par l'API, ni dans l'UI. On
peut le remplacer, pas le consulter. Il n'y a pas non plus de permission
`secret:*` : le vocabulaire RBAC est fermé, et lire les secrets d'une application
c'est lire l'application.

Un secret retiré de l'AppSpec n'est **jamais** supprimé automatiquement. Un
volume PostgreSQL survit à son déploiement et porte le mot de passe de son
premier démarrage : effacer la ligne rendrait la base inaccessible.

## Scanners de sécurité

**Une interface, trois implémentations, une fabrique** — la même règle que pour
les drivers. Ajouter un quatrième outil, c'est ajouter une classe et une entrée
dans `getScanner()`.

```ts
interface Scanner {
  readonly key: 'trivy' | 'grype' | 'syft'
  readonly kind: 'vulnerability' | 'sbom'
  ensureInstalled(session): Promise<string>
  run(ctx, onLog): Promise<ScanReport>
}
```

| Outil | `kind` | Commande | Version épinglée |
|---|---|---|---|
| `TrivyScanner` | `vulnerability` | `trivy image --format json --scanners vuln` | 0.74.0 |
| `GrypeScanner` | `vulnerability` | `grype <image> -o json` | 0.118.0 |
| `SyftSBOM` | `sbom` | `syft scan <image> -o cyclonedx-json` | 1.51.1 |

Les versions sont **épinglées** : un scanner qui change de version sous les pieds
rendrait deux déploiements incomparables.

**Les scanners tournent sur la machine cible, par SSH**, comme les drivers, et
sur l'image locale. Pas de registry, pas de rapatriement d'image, pas de client
embarqué dans le panel. `ensureInstalled()` détecte le binaire par son
`--version` et ne le télécharge que s'il est absent ou périmé ; l'architecture
vient de `uname -m`. Binaires et caches vivent dans `~/.bootstrap-tp` sur la
cible — ce nom est un héritage de la première version du projet, et il est
figé dans `packages/core/src/scanners/install.ts` : le changer laisserait des
caches orphelins sur toutes les cibles existantes. Dix minutes de délai maximum
par scanner. **Le premier scan sur une cible neuve télécharge les bases de
vulnérabilités : comptez quelques minutes, une seule fois.**

### La normalisation est le point clé

Trivy et Grype décrivent la même CVE avec deux vocabulaires. Chacun ramène le
sien sur une échelle commune (`CRITICAL HIGH MEDIUM LOW UNKNOWN`), dans sa propre
classe, et rien en aval ne sait plus qui a parlé :

| | Trivy | Grype | `Finding` |
|---|---|---|---|
| identifiant | `VulnerabilityID` | `vulnerability.id` | `cveId` |
| sévérité | `Severity` | `vulnerability.severity` (`Negligible` → `LOW`) | `severity` |
| paquet | `PkgName` | `artifact.name` | `package` |
| version | `InstalledVersion` | `artifact.version` | `installedVersion` |
| correctif | `FixedVersion` | `fix.versions[0]` | `fixedVersion` |
| avis | `PrimaryURL` | `dataSource` | `primaryUrl` |

`verify-scanners.sh` compare les deux sorties **CVE par CVE, paquet par paquet,
sévérité par sévérité** sur une image réelle. C'est le vrai test de la
normalisation : deux scanners qui décrivent la même vulnérabilité doivent
produire le même `Finding`.

### La politique de blocage vit dans les paramètres

Elle a quitté l'écran de déploiement : *une politique de sécurité qui se choisit
au coup par coup, déploiement par déploiement, n'est pas une politique.* Elle est
maintenant dans `/admin/settings/securite` (`settings:manage`) :

| Champ | Effet |
|---|---|
| `scanningEnabled` | interrupteur général — à `false`, plus aucun scan, sur aucun déploiement |
| `disabledScanners` | scanners écartés un par un, même quand l'analyse reste active |
| `failOn` | `CRITICAL` · `HIGH` · `NONE` — **défaut `NONE`** |

Le défaut `NONE` surprend et il est réfléchi. `nginx:1.29-alpine` porte 26
findings CRITICAL, `httpd:2.4-alpine` en porte 40. Un seuil bloquant par défaut
refuse donc toute image publique dès la première mise en ligne, l'opérateur coupe
l'analyse entière pour avancer — et se retrouve sans scan du tout. **Informer par
défaut, bloquer sur décision.**

L'API peut toujours fournir un `scanConfig` explicite (ce qui exige
`scan:configure`), mais la politique d'instance ne peut que **restreindre** :
`applySecuritySettings()` filtre les scanners écartés et force `scanners: []`,
`failOn: 'NONE'` si l'interrupteur est coupé. Un déploiement ne peut jamais
rallumer un scanner désactivé. Le champ `disabledBy: 'settings'` distingue
« personne n'a demandé de scan » de « l'instance a désactivé l'analyse », et
l'intention initiale reste consignée dans l'audit.

La politique est **gelée sur le déploiement** au moment de l'enfilement : la
`scan_config` en base décrit ce qui va réellement tourner, jamais ce qui a été
demandé. Conséquence assumée : rallumer l'analyse ne rétroagit pas sur ce qui est
déjà en file. Un redéploiement rejoue la politique de la version source, puis lui
réapplique celle de l'instance — *une analyse désactivée ne doit pas revenir par
la porte d'un redéploiement.*

### Le verdict

L'étape `scan` s'intercale entre `build` et `deploy`. Elle lance les scanners
sélectionnés **en parallèle** (`Promise.allSettled`) : un outil qui plante est
marqué en erreur — verdict `unknown`, ni bloquant ni dédouanant — et n'empêche
pas les autres de conclure.

Si un scanner de `kind: vulnerability` rapporte au moins un finding de sévérité
`>= failOn`, l'étape passe `failed`, le pipeline s'arrête et **le déploiement n'a
pas lieu**. Avec `failOn: NONE`, le verdict est informatif et les findings sont
enregistrés quand même. Sans scanner sélectionné, l'étape est `skipped`. **Un
SBOM ne bloque jamais** : c'est son `kind` qui le dit, pas son nom.

Verdict et findings passent par `logAudit()` — `deployment.scan.blocked` ou
`deployment.scan.passed`, avec les scanners, le seuil, les compteurs par sévérité
et les CVE responsables.

**Aucun `if (scanner === 'trivy')` hors des implémentations.** Ce qui reste
partagé est une table de données, `SCANNERS` dans `packages/core/src/scan.ts` :
libellé, `kind`, format de SBOM. L'UI y lit ses libellés, la route SBOM y lit son
type MIME.

Le SBOM n'a pas de colonne dédiée : il *est* la sortie brute de l'outil qui le
produit, donc il vit dans `scan_runs.raw`. Une colonne supplémentaire le
dupliquerait octet pour octet, et il faudrait décider laquelle fait foi.
