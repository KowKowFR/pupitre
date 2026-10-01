# Feuille de route

Ce document ne promet **aucune date**. Il liste ce qui manque, avec, pour chaque
entrée, l'endroit précis du code concerné et ce qu'il faudrait pour la lever.
Une entrée est ici parce qu'elle a été constatée — pas parce qu'elle serait
« bien à avoir ».

Les limites qui sont *déjà* observables par un utilisateur sont décrites, avec
leurs mesures, dans la section « Limites connues » du [README](../README.md). Ce
document en est la contrepartie : ce qu'on ferait pour les faire disparaître.

## Ce qui bloque un usage réel

### Fournir un contexte de build depuis le panel

`AppSpec` accepte `source.type: "dockerfile"`, les deux drivers savent construire
depuis un contexte, et le contexte leur arrive par `DriverContext.additionalFiles`.
Or **rien dans `apps/web` ni dans `apps/worker` ne remplit ce champ** :

```bash
grep -rn "additionalFiles" apps packages scripts --include='*.ts' --include='*.tsx' | grep -v dist
```

Seul `scripts/test-parity.ts` en fabrique un, et il pilote les drivers en direct.
Conséquence : **par le panel, seules les applications en `source.type: "image"`
se déploient.** Un service `dockerfile` échoue à l'étape `build`, avec le message
« Le contexte de build doit être fourni via `additionalFiles` ».

Ce qu'il faut : une voie d'entrée pour le code source — dépôt Git cloné sur la
cible, archive téléversée, ou montage — puis le remplissage du champ dans
`apps/worker/src/deploy/context.ts`. C'est le chantier qui rendrait le mot
« déployer » vrai au sens où l'entendent Coolify ou Dokploy.

### Un panel derrière un répartiteur

Le compteur de limitation de débit **de Better Auth** est stocké en mémoire de
processus, sur la clé (IP, chemin) — voir le bloc `rateLimit` dans
`apps/web/src/lib/auth.ts`, où la dette est déjà écrite noir sur blanc. Correct
pour un panel mono-conteneur, ce qui est le déploiement décrit partout ici ;
faux dès qu'on en met deux derrière un répartiteur, chaque réplique comptant
pour elle.

À ne pas confondre avec la limitation de débit **du panel**
(`apps/web/src/lib/rate-limit.ts`), qui protège la route de génération d'AppSpec
et vit déjà dans Redis. Corriger celle de Better Auth demande soit une table
`rateLimit` (donc une migration), soit un `secondaryStorage` Redis — qui
déplacerait aussi les sessions.

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

### Trivy ne voit pas les images construites sur K3s

Il cherche containerd sur `/run/containerd/containerd.sock`, namespace
`default` ; k3s écoute sur `/run/k3s/containerd/containerd.sock`, namespace
`k8s.io`. L'étape de scan rend donc `unknown` — non bloquant, mais silencieusement
inutile. Deux variables d'environnement dans
`packages/core/src/scanners/trivy.ts` suffiraient.

### Aucune alerte sur « machine injoignable »

Les relevés de métriques en échec sont enregistrés avec leur raison, mais ne
franchissent aucun seuil : une machine éteinte ne déclenche rien. La supervision
de **sites** a bien son hystérésis et ses alertes ; la supervision de
**serveurs** n'a que ses seuils de charge, de mémoire et de disque, qui exigent
un relevé réussi pour se prononcer.

### Un mot de runtime hors d'un driver

`packages/db/src/deployments.ts:1329` choisit « namespace » ou « projet Compose »
dans le message d'un déploiement abandonné. Aucun chemin d'exécution n'en dépend,
mais c'est la seule ligne du dépôt qui fait sortir du vocabulaire de runtime d'un
driver. Le driver devrait exposer ce mot ; le message se contenterait de le lire.

### `destroy()` ne nettoie pas containerd

Le driver K3s ne retire pas de containerd les images qu'il a fait construire.
Symétrique du driver Docker, mais ça s'accumule sur le nœud.

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

### Nginx Proxy Manager, un proxy hors des cibles

Le proxy central existe : une machine passe par le proxy d'une autre
(`proxy_links`), et chaque driver publie l'application pour lui seul. Mais ce
proxy tourne sur une cible que Pupitre pilote en SSH. Pour Nginx Proxy Manager,
souvent ailleurs, il faudra le placement `remote` que le modèle porte déjà :
une connexion par instance, son API et ses identifiants chiffrés, et une sonde
des domaines qui ne passe plus par SSH.

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

Le français est la langue du projet et de son code. Un système FR/EN est prévu
pour l'interface ; il n'existe pas encore, et rien dans `apps/web` n'est
externalisé aujourd'hui.
