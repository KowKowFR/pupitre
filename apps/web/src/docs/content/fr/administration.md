# Administration

Les comptes, les rôles et les permissions, la connexion unique, le second facteur, le journal d’activité, les paramètres de l’instance et la clé maîtresse. La plupart de ce chapitre demande les permissions d’un administrateur.

## Les utilisateurs

**Utilisateurs** (`user:manage`, lecture `user:read`) :

- **Créer** un compte, ou **inviter** quelqu’un — la personne choisit elle-même son mot de passe depuis le lien d’invitation ;
- choisir son **rôle** ; le désactiver ou le réactiver — un compte désactivé ne peut plus se connecter, et ses jetons d’API cessent aussitôt de fonctionner ;
- **Réinitialiser le second facteur** de quelqu’un qui a perdu son appareil (`user:reset-2fa`, une permission à part) : son facteur, ses appareils de confiance et toutes ses sessions partent ;
- voir et révoquer les jetons d’API de l’instance, avec leur auteur.

Garde-fous : on n’agit pas sur son propre compte depuis ici, et le dernier administrateur actif ne peut être ni rétrogradé, ni désactivé, ni supprimé.

L’inscription publique ne sert qu’à créer le premier compte — l’administrateur —, puis se ferme pour de bon : aucun réglage ne la rouvre. Tous les autres sont créés ou invités ici, ou arrivent par la connexion unique. Un compte qui arrive sans rôle naît **Aucun accès** : il ne voit rien tant qu’un administrateur ne lui a pas choisi de rôle, et l’évènement `security.signup_pending` prévient.

## Rôles et permissions

**Rôles** montre une matrice : une colonne par rôle, une ligne par famille de permissions. Il y a 38 permissions, écrites `ressource:action` :

| Ressource | Actions |
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
| `maintenance` | `read` `manage` |
| `status_page` | `manage` `announce` |
| `audit` | `read` |
| `settings` | `read` `manage` |

Les rôles de départ sont des données, modifiables — sauf `admin` :

| Rôle | Ce qu’il peut faire |
|---|---|
| `admin` | tout — verrouillé : il ne se renomme pas, ne se vide pas et ne se supprime pas |
| `operator` | déployer et exploiter : cibles (sans les supprimer), applications, déploiements, retour en arrière, redémarrage, analyses, sauvegardes sans restauration, fenêtres de maintenance, annonces des pages de statut |
| `auditor` | toutes les permissions `:read`, journal d’activité, comptes, rôles et paramètres compris |
| `viewer` | les lectures d’exploitation : cibles, applications, déploiements, sauvegardes, charges, analyses, tâches, sondes, maintenances |
| `no-access` | rien — le rôle d’une inscription publique |

Quelques distinctions comptent : **détruire** retire de la machine, **purger** efface de la base ; **sauvegarder** ne remplace rien, **restaurer** écrase ; **gérer** les comptes ne donne pas le pouvoir de lever le second facteur de quelqu’un. Créez vos propres rôles depuis la matrice : une nouvelle permission ajoutée par une mise à jour ne va qu’à `admin` — les autres rôles la reçoivent de vous.

## La connexion unique

**Paramètres → Connexion unique** (`settings:manage`) : se connecter par n’importe quel fournisseur OpenID Connect — Keycloak, Authentik, Google, Microsoft Entra. Avec Keycloak :

1. dans le realm, un client OpenID Connect `pupitre`, **Client authentication** activé, flux standard ;
2. **Valid redirect URIs** : l’URL de retour que donne l’écran des paramètres, `{{origin}}/api/auth/callback/oidc` ;
3. un mapper **Group Membership**, nom de champ `groups`, « Full group path » décoché, ajouté à l’ID token ;
4. dans Pupitre : l’émetteur (`https://auth.example.com/realms/my-realm`) — **Tester** le vérifie —, l’identifiant et le secret du client ;
5. les correspondances **groupe → rôle**, du plus puissant au moins puissant, et le rôle par défaut ;
6. si **le fournisseur fait foi** : coché, le rôle suit les groupes à chaque connexion.

L’écran de connexion propose alors de se connecter par le fournisseur. Un compte local n’est lié que si le fournisseur déclare l’e-mail vérifié.

> [!NOTE]
> Keycloak met ses rôles dans le jeton d’accès, pas dans l’ID token : passez par les **groupes**, ou cochez « Add to ID token » sur le mapper des rôles.

## Second facteur et sessions

**Paramètres → Comptes et sessions** (`settings:manage`) :

- **Second facteur exigé** — de personne (par défaut), des rôles qui portent une permission **sensible** (administrer, créer ou modifier des cibles, piloter des charges, déployer, détruire, purger, restaurer), ou de chaque compte. Un compte concerné qui n’en a pas n’atteint que l’écran qui l’active, et ses jetons d’API sont refusés comme lui ;
- **Durée des sessions** — fermées après une heure, huit heures, un jour, sept jours (par défaut) ou trente jours sans activité, et en option après une durée absolue.

Chacun active son propre facteur dans [Mon compte](/account) — TOTP, avec des codes de secours —, et y change son mot de passe.

## Le journal d’activité

**Journal** (`audit:read`) : chaque action et chaque refus — qui, quand, depuis quelle adresse, avec quel navigateur, et **par quel jeton d’API**. Chaque entrée porte une sévérité :

| Sévérité | Ce qu’elle désigne |
|---|---|
| `CRITICAL` | à traiter maintenant : une clé d’hôte qui change, un retour en arrière ou une restauration échoués |
| `HIGH` | une panne, un refus qui ressemble à une tentative, un geste sur les accès : un rôle changé, un jeton créé, une commande de console |
| `MEDIUM` | un changement d’état ou de configuration, un échec ou un refus ordinaire |
| `LOW` | la routine : connexions, succès, retours à la normale |

Filtrez par sévérité, action, ressource, auteur, période, ou cherchez librement ; exportez en JSONL (`GET /api/audit-logs/export`), une entrée par ligne. Par l’API :

```bash
curl -s "{{origin}}/api/audit-logs?severity=high,critical&from=2026-10-01" \
  -H "Authorization: Bearer $PUPITRE_TOKEN" | jq '.items[] | {createdAt, action, severity}'
```

## Les paramètres de l’instance

**Paramètres** (`settings:read`, écriture `settings:manage`), en quatre groupes :

| Section | Ce qui s’y règle |
|---|---|
| Identité | le nom et la devise de l’instance |
| Régionalisation | fuseau horaire, locale — donc la langue du panel —, format des dates |
| Analyse de sécurité | analyseurs et seuil de blocage — voyez [Analyses de sécurité](/docs/security-scans) |
| Connexion unique | le fournisseur OpenID Connect |
| Comptes et sessions | second facteur exigé, durée des sessions |
| Notifications | les canaux — voyez [Exploitation](/docs/operations#les-notifications) |
| Intelligence artificielle | fournisseur, modèle et clé pour la génération d’AppSpec |
| Dépôts de code | GitHub, GitLab, Gitea — voyez [Dépôts et code](/docs/repositories) |
| Sauvegardes | destination, la base du panel |
| Assistant de démarrage | relancer l’assistant |

Certains réglages sont des variables d’environnement, pas des écrans : `MONITOR_ALLOWED_CIDRS` (adresses privées des sondes), `BETTER_AUTH_URL` (l’adresse du panel), `WEB_PORT` (où le panel écoute).

## MASTER_KEY et sa rotation

`MASTER_KEY` chiffre les accès SSH, les secrets des applications, les clés de l’IA et de la connexion unique, les secrets des canaux, des forges et des destinations de sauvegarde — et chaque sauvegarde. Le panel prévient au démarrage si elle semble devinable. La changer ne demande de ressaisir aucun secret :

1. générez une nouvelle clé : `openssl rand -hex 32` ;
2. dans `.env`, déplacez la clé actuelle dans `MASTER_KEY_PREVIOUS` (séparées par des virgules s’il y en a plusieurs) et mettez la nouvelle dans `MASTER_KEY` ; redémarrez panel et worker — tout reste lisible, tout ce qui s’écrit désormais utilise la nouvelle clé ;
3. rechiffrez ce qui reste :

   ```bash
   docker compose run --rm worker crypto rotate --yes
   docker compose run --rm worker crypto status
   ```

4. `crypto status` dit quand `MASTER_KEY_PREVIOUS` peut partir : les sauvegardes faites avant la rotation ne restent lisibles que tant que leur clé y figure.

> [!CAUTION]
> Perdre une clé dont une valeur ou une sauvegarde gardée a encore besoin, c’est perdre cette valeur. Gardez `MASTER_KEY` et `BETTER_AUTH_SECRET` dans un gestionnaire de mots de passe, hors de la machine du panel.

## L’assistant de démarrage

À la première connexion d’une instance vide, l’assistant de démarrage parcourt huit étapes — bienvenue, identité et langue, première cible, reverse proxy, un rôle, un utilisateur, sécurité et IA, fin. Une étape que votre rôle ne peut pas faire est absente ; l’assistant ne crée rien de lui-même — chaque étape appelle les mêmes routes que les écrans habituels. Relancez-le depuis **Paramètres → Assistant de démarrage**.
