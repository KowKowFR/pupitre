# Reverse proxy et domaines

Comment les visiteurs rejoignent vos applications par leur nom : le reverse proxy de chaque machine, les domaines, les certificats, le pare-feu applicatif, un proxy partagé par plusieurs machines, et Nginx Proxy Manager.

## Pourquoi un reverse proxy

Une machine a un seul port 80 et un seul port 443, et plusieurs applications. Le **reverse proxy** y écoute et mène chaque visiteur à la bonne application selon le domaine demandé. Pupitre le pilote : dès qu’une machine a un proxy, déployer une application avec un domaine suffit — la route et le certificat suivent.

Une machine sans proxy reste utilisable : ses applications se joignent par leur port publié, sans nom de domaine.

## Les trois proxys

| Proxy | Où il tourne | Ce qu’il apporte |
|---|---|---|
| **Traefik** — par défaut | un conteneur sur une machine Docker, un binaire, ou celui que livre un cluster K3s | routes et certificats ; Pupitre écrit un fichier par application, ou des objets `Ingress` dans un cluster |
| **BunkerWeb** | un conteneur sur une machine Docker, piloté par son API | tout ce que fait Traefik, plus un pare-feu applicatif, domaine par domaine |
| **Nginx Proxy Manager** | hors des cibles, sur une machine que Pupitre ne pilote pas | son API suffit : Pupitre crée ses « proxy hosts » et leurs certificats |

## Reprendre ou installer un proxy

Sur la fiche de la cible, onglet **Reverse proxy** (`target:update`) :

1. **Regarder la machine** — Pupitre liste ce qui s’y trouve, sans rien toucher : un conteneur Traefik dont le fournisseur `file` surveille un dossier monté depuis la machine, un binaire Traefik, le Traefik d’un cluster K3s, un BunkerWeb dont l’API est activée ;
2. un proxy utilisable est trouvé ? **Utiliser celui-ci**. Ses réglages (points d’entrée, dossier surveillé, résolveur de certificats) sont lus ; ce qui manque devient un avertissement. Pupitre ne désinstallera jamais un proxy qu’il n’a pas posé ;
3. rien d’utilisable ? Choisissez une installation :
   - **Traefik en conteneur** — `traefik:v3.7`, réseau de l’hôte, ports 80 et 443, sans socket Docker, sans tableau de bord, certificats dans un volume ;
   - **le Traefik de K3s** — il n’est pas remplacé : configuré avec un résolveur ACME et un volume pour ses certificats ;
   - **BunkerWeb en conteneur** — l’image tout-en-un (environ 2,1 Go, 650 Mo de mémoire au repos), son API activée, son interface web non ;
4. choisissez l’autorité de certification : **Let’s Encrypt**, **Let’s Encrypt (staging)** pour essayer sans limite de volume, **ZeroSSL** (BunkerWeb), ou **un autre serveur ACME** (Traefik : step-ca, Smallstep…) ;
5. attendez que la connexion passe **ok**, puis **Tester**.

Une installation est refusée si les ports 80 ou 443 sont déjà pris par un autre serveur, ou si le disque ne peut pas accueillir l’image.

## Tester et retirer

**Tester** vérifie que les ports 80 et 443 répondent, et que le proxy lit vraiment ce qu’on lui donne : une route d’essai vers un port fermé est posée — lue, elle donne 502 ; ignorée, 404 — puis retirée. Le dernier test reste visible, point par point.

**Retirer** est refusé tant que des domaines passent par le proxy. Un proxy installé par Pupitre peut être désinstallé en même temps : conteneur et dossier supprimés, ou configuration de K3s rétablie.

## Définir les domaines d’une application

Au déploiement — dans le tiroir de l’application comme dans **Nouvelle application** —, un champ **Domaines** apparaît dès que la cible a un proxy : un nom par ligne, HTTPS coché par défaut (HTTP redirige alors vers HTTPS).

- Chaque nom est confronté au DNS — « pointe vers cette machine », « pointe ailleurs », « ne se résout pas encore » — pour **prévenir, jamais refuser** : derrière un CDN ou un NAT, l’adresse publique n’est pas celle qu’emploie le panel.
- Un domaine est **unique sur toute l’instance** : le revendiquer pour une deuxième application est refusé, en nommant la première.
- Le `ingress.host` de l’AppSpec n’est qu’une valeur par défaut, retenue au premier déploiement sur une cible ; ensuite, la liste de la cible fait foi.

Plus tard, la carte **Domaines** de l’application montre, cible par cible, chaque domaine, s’il répond par le proxy, et jusqu’à quand court son certificat. **Modifier** change la liste ; si l’application tourne, elle est appliquée au proxy aussitôt, sans redéployer (`deployment:create`).

Par l’API, la liste complète pour une cible :

```bash
curl --fail-with-body -X PUT {{origin}}/api/applications/$APP_ID/routes \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"targetId":"'"$TARGET_ID"'","routes":[
        {"hostname":"shop.example.com","tls":true,"redirectHttps":true},
        {"hostname":"www.shop.example.com","tls":true,"redirectHttps":true}]}'
```

## Les certificats

Les certificats sont obtenus par le proxy avec le défi **HTTP-01**. Pour qu’il réussisse :

- le DNS du domaine pointe vers la machine qui reçoit les visiteurs (celle du proxy) ;
- le port 80 de cette machine est joignable depuis Internet ;
- les limites de l’autorité ne sont pas épuisées — utilisez **staging** pour essayer.

En attendant, le proxy sert son certificat par défaut et la carte Domaines indique **en attente**. Let’s Encrypt renouvelle à trente jours de l’échéance ; un certificat qui entre dans ses quatorze derniers jours écrit `route.certificate.expiring`, une fois par certificat, et son renouvellement `route.certificate.renewed`.

> [!NOTE]
> Les certificats wildcard (`*.example.com`) demandent le défi DNS-01, que Pupitre ne met pas en place. Un wildcard déjà présent dans un Nginx Proxy Manager est réutilisé tel quel.

## Protéger un domaine avec BunkerWeb

Derrière BunkerWeb, chaque domaine a sa protection, choisie dans le champ **Domaines** et modifiable depuis la page de l’application :

| Protection | Ce que fait BunkerWeb |
|---|---|
| **Protection** (par défaut) | ModSecurity bloquant avec les règles OWASP CRS ; 100 requêtes par seconde et 100 connexions par adresse ; une adresse qui cumule trente erreurs en une minute est bannie une heure |
| **Détection seule** | les mêmes contrôles, journalisés dans BunkerWeb, rien de bloqué — pour vérifier qu’une application n’est pas gênée avant de passer en Protection |
| **Sans WAF** | ni inspection ni limite : BunkerWeb relaie |

Ce que vous ajoutez à la main dans BunkerWeb sur les services de Pupitre reste d’un déploiement à l’autre ; un domaine que BunkerWeb sert déjà à la main est refusé, en le disant. Les sondes de Pupitre passent le WAF avec un en-tête secret généré sur la machine.

## Un proxy pour plusieurs machines

Une machine n’a pas besoin de son propre proxy : elle peut passer par celui d’une autre — le **proxy central**. Sur sa fiche, onglet **Reverse proxy**, sans proxy à elle :

1. **Ou passer par le reverse proxy d’une autre machine** — choisissez le proxy ;
2. donnez **l’adresse de cette machine vue depuis celle du proxy** — une adresse privée (réseau local, VLAN, WireGuard) garde le trafic chez vous ; une adresse publique l’envoie en clair sur Internet, et la carte le dit ;
3. **Relier** : Pupitre éprouve aussitôt le vrai chemin — un écouteur éphémère sur cette machine, dans la plage de ports des applications, que la machine du proxy doit joindre et qui doit répondre avec un jeton tiré pour l’occasion.

Le résultat nomme ce qui bloque : « pas de réponse en 5 s » (un pare-feu qui ignore), « refuse la connexion » (un pare-feu qui rejette, ou une autre machine), « ce n’est pas cette machine » (un NAT). Le même test passe **avant chaque déploiement** avec des domaines sur la machine : un chemin bloqué fait échouer le préflight, avant toute construction.

| Runtime | Comment l’application est publiée | Restreinte au proxy par |
|---|---|---|
| Docker Compose | un port, sur l’adresse donnée | l’adresse de publication, et `ufw` ouvert à la seule adresse du proxy |
| K3s | un `NodePort` (30000-32767) | une `NetworkPolicy` qui n’accepte que l’adresse du proxy |

## Nginx Proxy Manager

Un Nginx Proxy Manager (2.x) tourne souvent sur une machine à part qui sert tout un réseau. Pupitre parle à son **API** avec un compte à lui, et ne touche qu’aux hôtes qu’il a créés.

1. Dans NPM, *Users* → un compte pour Pupitre, **sans authentification à deux facteurs**, avec **Manage** sur *Proxy Hosts* et *SSL Certificates*, et la visibilité **Created Items** ;
2. sur la fiche d’une cible, onglet **Reverse proxy** : **Connecter un Nginx Proxy Manager** :

| Champ | Ce qu’il faut donner |
|---|---|
| Adresse de l’interface | l’administration de NPM, qui porte son API — souvent `http://machine:81` ; en HTTP, un réseau privé seulement |
| E-mail, mot de passe | ceux du compte de Pupitre ; le mot de passe est chiffré aussitôt |
| Où il reçoit les visiteurs | facultatif : où le panel sonde les domaines ; vide, la machine de l’interface sur 80 et 443 |

3. **Connecter** éprouve l’API, le compte et ses droits ; une connexion qui n’entre pas n’est pas gardée ;
4. reliez-lui chaque machine que NPM sert, avec **son adresse vue depuis NPM**, comme pour le proxy central.

NPM demande lui-même ses certificats à Let’s Encrypt ; un certificat qu’il détient déjà pour le domaine est réutilisé.

## La page Domaines et l’inspection

**Domaines** (`application:read`) rassemble tous les domaines de l’instance : leur application et leur machine, le proxy qui les sert, leur état, la dernière sonde, et leur certificat avec les jours restants. **À surveiller** garde ceux qui ne répondent pas ou dont le certificat passe sous quatorze jours. Rien ne s’y modifie : un domaine se règle sur son application.

Un clic ouvre son tiroir ; quelques secondes plus tard arrive l’**inspection**, faite sur le moment par le worker : enregistrements DNS et s’ils mènent à la machine du proxy, adresses et noms inverses, l’enregistrement du domaine (RDAP), la zone (NS, MX, CAA) et le certificat présenté.

## Ce qui déclenche une alerte

Toutes les dix minutes, chaque domaine est sondé à travers son proxy. Deux échecs d’affilée écrivent `route.down` — avec la raison : proxy éteint, route absente, application muette — ; le retour écrit `route.recovered`. Avec les deux évènements de certificat, ce sont les quatre évènements de domaine que vos canaux de notification peuvent suivre — voyez [Exploitation](/docs/operations#les-notifications).
