# Sécurité

- [Authentification et comptes](#authentification-et-comptes)
- [RBAC — 30 permissions](#rbac--30-permissions)
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

### Mon compte — `/account`

Écran self-service, sans permission RBAC : une session suffit.

**Changer son mot de passe** exige l'ancien. Sans cette exigence, un cookie volé
suffirait à s'emparer définitivement du compte. Le changement révoque **les
autres** sessions et garde celle qui vient de le faire. Ni l'ancien mot de passe,
ni le nouveau, ni leur longueur n'apparaissent au journal.

**Le second facteur est du TOTP**, `issuer: 'Bootstrap TP v2'`, avec des codes de
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

## RBAC — 30 permissions

`packages/core/src/permissions.ts` est le vocabulaire, partagé par le panel, le
worker et le seed. Une permission est une chaîne `ressource:action`.

| Ressource | Permissions |
|---|---|
| `user` | `read` `manage` `reset-2fa` |
| `role` | `read` `manage` |
| `target` | `read` `create` `update` `delete` |
| `application` | `read` `create` `update` `delete` |
| `deployment` | `read` `create` `rollback` `restart` `destroy` `purge` |
| `workload` | `read` `manage` |
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

### Les rôles sont des données, pas du code

`SEEDED_ROLES` — `admin`, `operator`, `viewer` — ne sont que des **valeurs de
départ**. L'autorité à l'exécution est la table `roles`, et un administrateur
peut créer d'autres rôles depuis `/admin/roles`. C'est pourquoi `RoleKey` est
délibérément une `string` et non une union figée : une union obligerait à
recompiler le panel pour créer un rôle.

| Rôle | Permissions |
|---|---|
| `admin` | les 30 — **verrouillé**, ni renommable, ni vidable, ni supprimable |
| `operator` | déploie et exploite : cibles (sauf suppression), applications, déploiements, rollback, restart, scans et `scan:configure` |
| `viewer` | les 11 permissions en `:read` |

`admin` est le garde-fou qui empêche de se verrouiller hors de son propre panel.
Le seed est idempotent et rejoué à chaque démarrage, mais **il ne réécrit pas une
personnalisation** — `verify-roles.sh` le vérifie explicitement.

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

## Chiffrement

`packages/core/src/crypto.ts` — **AES-256-GCM**, clé dérivée de `MASTER_KEY` par
HKDF-SHA256, format `version:iv:authTag:ciphertext` avec la version passée en
**AAD** (pas de downgrade v2 → v1). Le panel et le worker refusent de démarrer si
`MASTER_KEY` est absente ou fait moins de 32 octets.

Cinq choses sont chiffrées par la même primitive, chacune dans sa colonne :

| Quoi | Colonne | Seul point de déchiffrement |
|---|---|---|
| Credential SSH d'une cible | `targets.encrypted_credential` | le worker, à l'ouverture de session |
| Valeur d'un secret d'application | `application_secrets.encrypted_value` | le worker, au rendu |
| Clé d'API de l'IA | `app_settings.ai_api_key_encrypted` | le panel, à l'appel du fournisseur |
| Secrets d'un canal de notification | `notification_channels.encrypted_secrets` | le worker, à l'envoi |
| URL de webhook d'une sonde | `monitors.webhook_url_encrypted` | le worker, à l'alerte |

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

Ils **avertissent** sans refuser de démarrer, volontairement : la base contient
déjà des valeurs chiffrées sous cette clé, et une instance qui ne démarre plus
est une instance dont on ne peut plus extraire les identifiants pour les
rechiffrer. La rotation reste une décision de l'exploitant, et elle se fait dans
cet ordre :

```bash
openssl rand -hex 32          # la nouvelle clé
```

1. Relever, **avec l'ancienne clé encore en place**, tout ce qui est chiffré :
   credentials de cibles, secrets d'applications, clé d'API de l'IA, secrets de
   canaux, URL de webhook des sondes — les cinq colonnes du tableau ci-dessus.
2. Remplacer `MASTER_KEY` dans `.env`, puis redémarrer panel et worker.
3. Ressaisir chaque valeur par l'API ou par l'écran qui la porte. Rien ne se
   rechiffre tout seul : les anciennes valeurs deviennent illisibles, pas
   invalides.

Inverser 1 et 2 perd les identifiants sans recours — c'est la garantie même du
chiffrement.

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
cible. Dix minutes de délai maximum par scanner. **Le premier scan sur une cible
neuve télécharge les bases de vulnérabilités : comptez quelques minutes, une
seule fois.**

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

`verify-jalon6.sh` compare les deux sorties **CVE par CVE, paquet par paquet,
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
