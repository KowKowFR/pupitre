# Dépannage

Du symptôme à la cause. Chaque section dit ce que vous voyez, pourquoi cela arrive, et quoi faire. Quand rien ici ne correspond, la dernière section dit où regarder.

## Une cible est injoignable

**Constaté** : la cible est **injoignable**, son préflight échoue à `ssh`, `target.unreachable` dans le journal d’activité.

| Cause | Que faire |
|---|---|
| La machine est éteinte, ou son adresse a changé | démarrez-la ; corrigez l’hôte sur la fiche — la clé d’hôte est alors réenregistrée |
| Un pare-feu ignore le SSH du worker | autorisez la machine du panel sur le port SSH |
| Authentification refusée | vérifiez le compte et la clé sur la machine (`authorized_keys`, droits 600) ; modifiez la cible pour recoller la clé |
| La clé d’hôte a changé | voyez ci-dessous |

Pupitre ne réessaie pas un échec d’authentification : une clé invalide ne deviendra pas valide, et certaines machines bannissent l’adresse.

## La clé d’hôte a changé

**Constaté** : un bandeau sur la fiche de la cible, avec deux empreintes ; toute connexion refusée.

Vérifiez sur la machine elle-même — `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` — que la nouvelle empreinte est celle affichée. Machine réinstallée et empreinte qui correspond : **Accepter la nouvelle clé**. Tout autre cas : **Garder l’ancienne**, et cherchez qui répond à cette adresse. Voyez [Cibles](/docs/targets#la-cle-d-hote).

## Un déploiement échoue

Ouvrez le tiroir du run : l’étape en échec est rouge, et son journal finit par la raison.

| Étape | Causes fréquentes | Que faire |
|---|---|---|
| `preflight` | le runtime est indisponible ; le disque est plein ; le proxy central ne joint pas la machine | lancez le préflight de la cible ; libérez de l’espace ; **Tester le lien** dans l’onglet **Reverse proxy** |
| `allocate_port` | la plage de la cible est épuisée | élargissez la plage sur la cible, ou détruisez ce qui ne sert plus |
| `upload` | plus d’espace, ou `sudo` refusé | libérez de l’espace ; vérifiez la méthode sudo de la cible |
| `build` | le Dockerfile échoue ; pas de code — pas d’archive, une archive refusée, un Dockerfile absent | lisez le journal de construction ; téléversez une archive ; confrontez les contextes au code |
| `scan` | une vulnérabilité au-dessus du seuil | corrigez l’image, acceptez la vulnérabilité avec une raison, ou ajustez la politique — voyez [Analyses de sécurité](/docs/security-scans) |
| `backup` | la destination ne répond pas | **Tester** la destination dans **Paramètres → Sauvegardes** |
| `deploy` | l’image ne se tire pas (privée, mauvais tag) ; un port déjà pris sur la machine | `docker login` sur la machine pour un registre privé ; vérifiez le tag |
| `healthcheck` | l’application ne répond pas sur son port ou son chemin | voyez ci-dessous |
| `proxy` | le proxy refuse la configuration | lisez le message — BunkerWeb donne celui de nginx ; **Tester** le proxy |

## La vérification de santé échoue

**Constaté** : `healthcheck` en échec, le déploiement est `rolled_back` (ou `failed` à un premier déploiement). Le journal garde l’état des conteneurs ou des pods et leurs dernières lignes, capturés avant le retour en arrière.

- **injoignable** — rien ne répond : le processus a planté au démarrage (lisez ses lignes de journal), ou il écoute sur un autre port que le `port` de l’AppSpec ;
- **malade** — il répond, hors 2xx et 3xx : mauvais `healthcheck.path`, une variable ou un secret manquant, la base pas encore prête ;
- **trop lent** — augmentez `retries` et `intervalSec` ; une application qui migre sa base au démarrage a besoin de temps.

Une image construite tourne avec une racine en lecture seule, sous un utilisateur sans privilège : elle doit écouter au-dessus de 1024 et n’écrire que dans `/tmp` et ses volumes.

## Le domaine ne répond pas

| Constaté sur la carte Domaines | Cause | Que faire |
|---|---|---|
| ne se résout pas | pas encore d’enregistrement DNS | créez l’enregistrement A ou AAAA vers la machine du proxy |
| pointe ailleurs | le DNS mène à une autre machine | corrigez l’enregistrement — ou ignorez derrière un CDN |
| certificat en attente | le défi HTTP-01 ne réussit pas | port 80 ouvert depuis Internet, DNS vers le proxy, les limites de l’autorité — essayez **staging** |
| route injoignable | le proxy est éteint, la route absente, ou l’application muette | **Tester** le proxy ; **Appliquer** les domaines ; vérifiez l’application dans **Supervision** |

## Un jeton est refusé

| Réponse | Cause | Que faire |
|---|---|---|
| `401 token_invalid` | l’en-tête est mal formé, ou le jeton inconnu | envoyez `Authorization: Bearer pup_…`, le jeton entier |
| `401 token_revoked`, `token_expired` | révoqué, ou passé son échéance | créez un nouveau jeton |
| `403 forbidden` | la permission nommée dans `details` manque — au jeton, ou à vous désormais | donnez-la au jeton, ou demandez-la |
| `403 token_scope` | un jeton limité à des applications, sur une route qui ne l’accepte pas | utilisez un jeton valable sur toutes les applications pour cette route |
| `403 token_refused` | une route qui se fait depuis le panel seulement | faites-le depuis le panel |
| `403 two_factor_required` | l’instance exige un second facteur que votre compte n’a pas | activez-le dans [Mon compte](/account) |

`GET /api/me` avec le jeton dit ce qu’il détient vraiment.

## Les notifications n’arrivent pas

1. **Envoyer un test** sur le canal : la vérification et l’envoi réel sont rapportés séparément ;
2. vérifiez que le canal est abonné à l’évènement ;
3. une fenêtre de maintenance retient peut-être les alertes de surveillance de ce sujet ;
4. la dernière erreur du canal s’affiche sur sa ligne — une connexion SMTP refusée, un bot Telegram révoqué.

## Une page ou une action est refusée

L’écran de refus nomme la permission manquante. Un écran que vous ne voyez pas dans la navigation est un écran que votre rôle n’ouvre pas. Demandez la permission à un administrateur — **Rôles** montre quel rôle la porte.

## Où regarder

- **Le journal du run** — chaque étape, chaque commande qui a modifié la machine, les verdicts d’analyse.
- **Le journal d’activité** — qui a fait quoi, chaque refus et sa raison, les échecs des tâches du panel lui-même.
- **Les journaux des conteneurs** du panel lui-même :

  ```bash
  docker compose logs --tail=200 panel worker
  curl -s {{origin}}/api/health
  ```

- **La machine** — ce que Pupitre a déposé vit dans le dossier du compte de déploiement, sous `apps/{name}/`, une release par déploiement.
