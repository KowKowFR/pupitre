# Politique de sécurité

Pupitre détient les clés SSH de vos machines, chiffre les secrets de vos
applications et exécute des commandes privilégiées à distance. Une faille ici ne
compromet pas un site web : elle compromet une infrastructure. Les signalements
sont pris au sérieux.

## Signaler une faille

**N'ouvrez pas d'issue publique.**

Utilisez le signalement privé de GitHub :
[Security → Report a vulnerability](https://github.com/KowKowFR/pupitre/security/advisories/new)
sur le dépôt. Il crée un fil privé entre vous et le mainteneur, et permet de
publier un avis une fois le correctif disponible.

Si ce canal ne vous est pas accessible, écrivez au mainteneur,
[@KowKowFR](https://github.com/KowKowFR), à l'adresse indiquée sur son profil.

Ce qui aide, dans l'ordre d'utilité :

1. la version — commit, ou sortie de `git rev-parse HEAD` ;
2. le chemin d'attaque, étape par étape, et le privilège de départ (anonyme ?
   `viewer` ? `operator` ?) ;
3. l'impact concret : lecture d'un secret, exécution sur une cible, élévation de
   privilège, déni de service ;
4. une preuve reproductible — une requête `curl`, un script, une fixture.

**Ne testez que vos propres machines.** Le dépôt fournit de quoi monter une cible
jetable en conteneur (`./scripts/setup-test-target.sh`).

## Délais

Le projet est maintenu par une personne, sur son temps. Ce qui est promis :

| Étape | Délai visé |
|---|---|
| Accusé de réception | 7 jours |
| Première évaluation (confirmé / rejeté / besoin d'info) | 14 jours |
| Correctif ou plan de correction annoncé | 90 jours |

Aucune prime n'est offerte. Le crédit vous revient dans l'avis publié, sauf si
vous préférez l'anonymat.

## Versions supportées

Il n'existe **aucune version publiée** : pas de tag, pas de release, pas d'image
distribuée. La seule chose maintenue est la branche `main`. Un correctif y est
appliqué et rien n'est rétroporté nulle part.

Cela signifie aussi que si vous exploitez Pupitre, vous exploitez un commit :
notez lequel.

## Dans le périmètre

- Contournement du RBAC : obtenir un effet sans détenir la permission
  correspondante, sur n'importe laquelle des routes de
  [`docs/api.md`](docs/api.md).
- Fuite d'une valeur chiffrée — credential SSH, secret d'application, clé d'API
  d'IA, secret de canal de notification, URL de webhook de sonde — par l'API, par
  le HTML rendu, par le journal d'activité, par les logs, ou par les clés Redis.
- Injection de commande sur une machine cible : faire exécuter par le driver ou
  par le worker une commande qui n'était pas prévue, via un champ d'AppSpec, un
  nom d'application, un nom de secret ou un paramètre de route.
- Évasion de l'isolation entre applications déployées : atteindre, depuis
  l'application `a`, le réseau, les volumes ou les secrets de l'application `b`.
- Contournement des protections SSRF des sondes de supervision — services de
  métadonnées cloud, `localhost`, `file://`, plages non routables, identifiants
  dans l'URL, URL de webhook.
- Failles d'authentification : reprise de session, contournement du TOTP,
  réutilisation d'un code de secours, jeton d'invitation valable deux fois,
  distinction observable entre une adresse connue et une adresse inconnue.
- Cross-site scripting, CSRF, ou fixation de session dans le panel.
- Élévation de privilège vers `admin` par n'importe quel chemin.
- Un secret committé dans le dépôt, ou publié dans une image.

## Hors périmètre

- **Les applications que vous déployez.** Pupitre les orchestre ; leur contenu et
  leurs vulnérabilités vous appartiennent. Les scanners intégrés
  (Trivy, Grype, Syft) sont un garde-fou, pas une garantie.
- **La sécurité de vos machines cibles.** Le panel s'y connecte avec les
  identifiants que vous lui donnez et exécute des commandes en `sudo`. Une cible
  compromise l'était avant Pupitre, ou l'est devenue par ce que vous y avez
  déployé.
- **Une instance exposée sans reverse proxy ni TLS.** La pile compose publie sur
  `127.0.0.1` par défaut ; l'exposer publiquement en clair est une décision
  d'exploitation.
- **Les limites déjà documentées.** Elles ne sont pas des découvertes : la
  section « Limites connues » du [README](README.md) et
  [`docs/feuille-de-route.md`](docs/feuille-de-route.md) les décrivent, avec ce
  qu'il faudrait pour les lever. En particulier, la limitation de débit de
  l'authentification est en mémoire de processus — donc par réplique — et la
  rotation de `MASTER_KEY` n'est pas implémentée.
- **Le pod constructeur BuildKit sur K3s est privilégié**, et c'est écrit. Ce
  n'est pas un rapport de faille ; une manière de construire sans ce privilège en
  serait une bonne contribution.
- Rapports de scanner automatisé sans chemin d'exploitation démontré.
- Absence d'en-têtes de durcissement, faiblesses de suites TLS, versions de
  dépendances signalées par un outil mais sans exploitabilité ici.
- Attaques exigeant un accès physique, un accès `root` préalable au panel, ou la
  possession de `MASTER_KEY`.

## Ce que le projet garantit déjà

Ces propriétés sont vérifiées à chaque passage des scripts de
[`docs/verification.md`](docs/verification.md). Une contribution qui les casse
est un bug de sécurité, même sans exploitation démontrée.

- Aucun credential ne sort de l'API, à quelque profondeur du JSON que ce soit.
- Aucun secret n'apparaît dans le journal d'activité, dans les logs, dans le HTML
  ni dans les clés BullMQ de Redis — y compris les **préfixes** de clé d'API, que
  certains fournisseurs renvoient dans leurs messages d'erreur.
- Un refus de permission est tracé, avec l'acteur et l'IP réelle derrière le
  reverse proxy.
- Deux gardes de CI : aucun secret dans le dépôt, et les migrations appliquées
  sont immuables.
