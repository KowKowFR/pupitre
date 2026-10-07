# Applications

Une application est une AppSpec enregistrée dans le panel, avec tout ce qui lui appartient dans la durée : ses secrets, ses domaines, ses versions, son code, ses sauvegardes. Ce chapitre couvre les cinq façons d’en créer une, sa fiche, ses secrets, sa modification et sa suppression.

## Cinq façons de créer une application

| Façon | Où | Quand la choisir |
|---|---|---|
| Le catalogue | **Catalogue** | une application connue — Grafana, WordPress, Vaultwarden… — en quelques clics |
| Une AppSpec JSON | **Nouvelle application → Depuis un JSON** | vous écrivez l’AppSpec, ou elle vient d’ailleurs |
| Une description | **Nouvelle application → Depuis une description** | l’IA de l’instance écrit une première AppSpec pour vous |
| Un `docker-compose.yml` | **Nouvelle application → Depuis un docker-compose** | vous avez déjà un fichier Compose |
| Un dépôt | **Nouvelle application → Depuis un dépôt** | le code et son `pupitre.json` vivent sur GitHub, GitLab ou Gitea |

Toutes demandent `application:create`, et aucune ne déploie : créer et déployer sont deux gestes. L’application est créée sans cible ; vous la déployez ensuite, où vous voulez.

## Depuis le catalogue

Le **Catalogue** propose vingt-huit applications toutes prêtes — Uptime Kuma, Grafana, Gotify, Metabase, Matomo, WordPress, Directus, Wiki.js, n8n, Open WebUI, Gitea, code-server, pgAdmin, Adminer, IT Tools, Nextcloud, Paperless-ngx, linkding, Memos, Actual, Stirling-PDF, Excalidraw, draw.io, FreshRSS, Jellyfin, Navidrome, Vaultwarden, et un hello world.

1. choisissez un modèle ;
2. donnez un nom, éventuellement un domaine et HTTPS, et l’e-mail de la personne qui l’installe ;
3. renseignez les **secrets qui servent à se connecter** qu’il demande — un mot de passe d’administration, par exemple ; les autres sont générés ;
4. **Installer** : l’application est créée ; déployez-la depuis sa fiche.

Chaque modèle est une AppSpec comme une autre : il se déploie sur Docker et sur K3s, et son AppSpec se modifie ensuite.

## Depuis un JSON

**Nouvelle application → Depuis un JSON** : collez une AppSpec dans l’éditeur. Elle est validée à la frappe ; **Enregistrer** est proposé dès qu’elle passe. La [Référence de l’AppSpec](/docs/appspec) décrit chaque champ, avec des exemples complets.

Par l’API, avec des valeurs pour certains des secrets déclarés :

```bash
curl --fail-with-body -X POST {{origin}}/api/applications \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "description": "Notre blog",
  "appSpec": {
    "name": "blog",
    "version": "1.0.0",
    "services": [
      {
        "name": "web",
        "source": { "type": "image", "ref": "ghcr.io/acme/blog:1.0.0" },
        "port": 8080,
        "exposed": true,
        "secrets": ["SMTP_PASSWORD"]
      }
    ]
  },
  "secrets": { "SMTP_PASSWORD": "la-valeur-de-votre-fournisseur-mail" }
}
JSON
```

## Depuis une description, avec l’IA

**Nouvelle application → Depuis une description** : décrivez l’application en une phrase ou un paragraphe — ce qu’elle est, ce dont elle a besoin (« une API Node avec PostgreSQL et Redis, servie sur api.example.com »). Le fournisseur d’IA de l’instance (OpenRouter, OpenAI ou Anthropic, réglé dans **Paramètres → Intelligence artificielle**) écrit une AppSpec ; Pupitre la valide et, si le modèle s’est trompé, la lui redemande avec les objections.

Le résultat est une **proposition** : rien n’est enregistré avant que vous la relisiez, la corrigiez dans l’éditeur et cliquiez **Enregistrer**. L’IA produit du JSON, jamais une commande : c’est Pupitre qui exécute, et seulement ce qui a passé la validation.

Sans fournisseur configuré, l’onglet le dit et l’API répond `501`.

## Depuis un docker-compose.yml

**Nouvelle application → Depuis un docker-compose** : collez un `docker-compose.yml`. Pupitre le traduit en une AppSpec proposée et nomme, clé par clé, ce qu’il en a fait :

- **bloquant** — ce qui demande une décision humaine : `command` ou `entrypoint`, le socket Docker, un fichier de l’hôte monté, `privileged`, `network_mode` ;
- **approximation** — un dossier de l’hôte devient un volume nommé vide, un port non déclaré est deviné, une variable `${…}` prend sa valeur par défaut ;
- **ignoré** — `restart`, `container_name`, les réseaux : Pupitre les décide.

Les variables qui ressemblent à des secrets deviennent des secrets générés, jamais des valeurs en clair.

## Depuis un dépôt

L’application suit une branche : son `pupitre.json` la décrit, chaque commit la met à jour ou la redéploie. La procédure, les forges et les options sont dans [Dépôts et code](/docs/repositories).

## La fiche de l’application

**Applications**, puis une ligne : la fiche s’ouvre dans un tiroir, avec ses onglets.

| Onglet | Ce qu’il contient |
|---|---|
| Aperçu | où elle tourne, le dernier déploiement, son URL, le bouton **Déployer** |
| Versions | les versions déployées, de la plus récente à la plus ancienne, chacune rejouable |
| Code | le dépôt lié, ou les archives téléversées |
| Domaines | les domaines par cible, leur état et leur certificat |
| Secrets | les noms des secrets, leur origine, quand ils ont changé — jamais une valeur |
| Sauvegardes | la politique de sauvegarde, l’historique, la restauration (`backup:read`) |
| Images | les mises à jour d’images trouvées par cible |
| Sécurité | la politique d’analyse de l’application et les vulnérabilités acceptées |

## Les secrets

L’AppSpec déclare des **noms** de secrets ; les valeurs vivent dans le panel, chiffrées.

- **Généré** — 32 caractères aléatoires, tirés au premier déploiement, réutilisés tels quels ensuite ;
- **Fourni** — une valeur que vous saisissez : une clé d’API tierce, un mot de passe déjà en service ailleurs ;
- **Alias** — un nom qui lit la valeur d’un autre, pour une application et sa base qui attendent le même mot de passe sous deux noms.

Dans l’onglet **Secrets**, **Remplacer** une valeur ou **Régénérer** (`application:update`). Aucun moyen de relire un secret, ni par l’API ni à l’écran : on le remplace. Un secret changé s’applique au prochain déploiement.

```bash
# Définir une valeur
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/secrets/SMTP_PASSWORD \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"value":"nouvelle-valeur"}'

# En tirer une nouvelle au hasard
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/secrets/SESSION_KEY \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"generate":true}'
```

> [!CAUTION]
> Un secret retiré de l’AppSpec n’est jamais supprimé de lui-même : le volume d’une base garde le mot de passe de son premier démarrage, et supprimer la valeur vous en fermerait l’accès.

## Modifier une application

Modifiez l’AppSpec depuis la fiche (**Modifier**, `application:update`), ou par `PATCH /api/applications/{id}`. Les déploiements en service ne sont pas touchés : redéployez pour appliquer le changement.

- Une application liée à un dépôt refuse qu’on modifie son AppSpec : changez `pupitre.json` dans le dépôt.
- Le `name` d’une application est son nom sur les machines (`app-{name}`). Le renommer est refusé tant qu’un déploiement le tient : détruisez d’abord ses déploiements, ou gardez le nom.

## Mises à jour d’images

Toutes les six heures — et à la demande avec **Vérifier maintenant** dans l’onglet **Images** —, le worker compare chaque image déployée depuis un registre avec ce que ce registre annonce aujourd’hui : le même tag republié, ou un tag plus récent de la même série (`16.4-alpine` ne se compare qu’à `x.y-alpine`). Une nouvelle trouvaille écrit `image.update.available`, que vos canaux de notification peuvent suivre. **Mettre à jour** redéploie la version en service avec le nouveau contenu de l’image.

Les images construites sur la cible, épinglées par empreinte ou privées ne sont pas vérifiées — l’onglet dit pourquoi.

## Supprimer une application

Deux chemins, volontairement :

- **Supprimer** (`application:delete`) — refusé en `409` tant qu’un déploiement la fait tourner, en nommant les déploiements et les cibles ;
- **Détruire et supprimer** (la cascade) — détruit ses déploiements sur les machines, purge son historique, puis la supprime. Elle demande la réunion de `deployment:destroy`, `deployment:purge` et `application:delete`, et commence par un aperçu qui nomme chaque déploiement, hôte, projet ou namespace et port.

Si une machine ne répond pas, rien n’est supprimé sauf si vous **forcez**, en tapant le nom de l’application : les conteneurs laissés sur cette machine continuent de tourner, et le journal d’activité garde les commandes pour la nettoyer à la main.
