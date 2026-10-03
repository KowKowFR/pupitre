# Feuille de route

Ce document ne promet **aucune date**. Il liste ce qui manque, avec, pour chaque
entrée, l'endroit précis du code concerné et ce qu'il faudrait pour la lever.
Une entrée est ici parce qu'elle a été constatée — pas parce qu'elle serait
« bien à avoir ».

Les limites qui sont *déjà* observables par un utilisateur sont décrites, avec
leurs mesures, dans la section « Limites connues » du [README](../README.md). Ce
document en est la contrepartie : ce qu'on ferait pour les faire disparaître.

## Ce qui bloque un usage réel

### Rotation de `MASTER_KEY`

Le format de chiffrement est `version:iv:authTag:ciphertext` : le champ
`version` existe **pour permettre** une rotation. Le code de rotation, lui,
n'est pas écrit. Aujourd'hui, changer `MASTER_KEY` rend illisibles les
credentials SSH, les valeurs de secrets, la clé d'API d'IA, les secrets des
canaux de notification, les URL de webhook des sondes, la clé de l'App GitHub,
les clés de la destination de sauvegarde — et **toutes les sauvegardes déjà
faites**, dont le format (`PUPB`, version 1) n'a pas de place pour une seconde
clé.

## Trous de couverture

### Les rôles de Keycloak ne passent pas tels quels

La connexion unique lit les groupes dans le **jeton d'identité**, par un seul
champ (`sso.groupsClaim`, lu par `claimValues()` dans
`packages/core/src/sso.ts`). Or Keycloak ne met ses rôles de realm
(`realm_access.roles`) et de client (`resource_access.<client>.roles`) que dans
le **jeton d'accès** : ni le jeton d'identité ni `userinfo` ne les portent par
défaut. Aujourd'hui, il faut donc passer par des groupes (mappeur « Group
Membership ») — ou cocher « Add to ID token » sur le mappeur des rôles.

Ce qu'il faudrait : lire aussi le jeton d'accès (vérifié contre les mêmes
clés), accepter plusieurs champs à la fois (groupes **et** rôles), et proposer
`realm_access.roles` comme un choix de l'écran plutôt qu'un chemin à saisir.

### Le constructeur BuildKit reste en place

C'est délibéré — son cache de couches vit dedans — mais rien ne le supprime
automatiquement. C'est un pod privilégié qui attend sur le cluster,
volontairement dépourvu d'étiquette `managed-by` pour rester supprimable depuis
l'écran des charges, et la commande pour s'en défaire est journalisée à chaque
build. Une politique d'expiration serait mieux qu'une commande dans un journal.

## Abstractions déclarées mais à une seule implémentation

### BunkerWeb dans un cluster, et un BunkerWeb trouvé

`BunkerWebProvider` pilote un BunkerWeb en conteneur Docker (série 1.6), par
son API — installé par Pupitre ou trouvé avec son API activée. Restent : son
contrôleur d'ingress pour K3s (aujourd'hui, une machine K3s se relie au
BunkerWeb d'une machine Docker), un BunkerWeb installé en paquet système, et
le réglage des certificats d'un BunkerWeb trouvé — Pupitre ne lui demande pas
de certificats tant qu'aucun e-mail n'est réglé pour lui.

### Nginx Proxy Manager, au-delà de la connexion

Pupitre se connecte à un Nginx Proxy Manager qui tourne, hors des cibles, et
lui confie des hôtes par son API. Restent : l'installer lui-même sur une
machine, lui faire demander un joker par défi DNS (aujourd'hui, un joker déjà
présent dans NPM est repris), et relever l'adresse d'arrivée de NPM sur une
machine sans python3 ni perl.

### Pas de certificat joker

Un `*.exemple.fr` demande le défi DNS-01, donc un accès à l'API du DNS du
domaine. Aujourd'hui, seul HTTP-01 est réglé par Pupitre.

## Ce qui n'est pas prévu, et pourquoi

- **Un registry d'images.** Décision figée dans [`CLAUDE.md`](../CLAUDE.md) : le
  build a lieu sur la machine cible. Rouvrir cette décision changerait la forme
  des deux drivers.
- **Ansible, ou du cron Linux.** Même document, mêmes raisons : l'exécution
  distante passe par `node-ssh`, la planification par les repeatable jobs de
  BullMQ.
- **Un catalogue d'applications prêtes à l'emploi.** L'AppSpec est le format
  d'entrée ; un catalogue serait une collection de fichiers JSON, pas une
  capacité du moteur.

## Interface bilingue

Le français est la langue du projet et de son code. L'interface, elle, est
bilingue : chaque écran tire ses textes de `apps/web/src/i18n/messages/`, en
français et en anglais, et la langue se règle pour l'instance
(Paramètres → Régionalisation). Une garde des tests refuse un texte français écrit
en dur dans le code du panel. Les messages du worker et des drivers — journaux de
déploiement, erreurs remontées par la machine — restent en français.
