# Cibles

Une cible est une machine sur laquelle Pupitre déploie, jointe par SSH. Ce chapitre couvre sa déclaration, ce que le panel y vérifie, sa clé d’hôte, ses relevés, ses ports, ce qui y tourne, et comment la retirer.

## Ce qu’il faut à une cible

| Prérequis | Détail |
|---|---|
| Linux, joignable en SSH depuis le worker | authentification par clé ou par mot de passe ; port 22 ou un autre |
| Un compte qui peut utiliser `sudo` | sans mot de passe (`NOPASSWD`), ou avec le mot de passe du compte |
| Un runtime | Docker Engine avec son extension `compose`, ou K3s (avec `kubectl` qui lit `/etc/rancher/k3s/k3s.yaml`) |
| Des outils courants | `curl` ; `ufw` est utilisé s’il est présent et actif, jamais activé par Pupitre |
| De l’espace disque | images, constructions et bases des analyseurs (plusieurs Gio la première fois) |

> [!NOTE]
> L’accès que vous saisissez est chiffré aussitôt (AES-256-GCM, sous `MASTER_KEY`) et ne ressort jamais de l’API — pas même vers l’écran qui modifie la cible. Seul le worker le déchiffre, pour ouvrir une session.

## Déclarer une cible

Depuis l’écran, **Cibles → Nouvelle cible** (`target:create`) :

1. **Nom** — la façon dont le panel et les journaux l’appelleront (`prod-1`) ;
2. **Hôte** et **port** — une adresse que le worker peut joindre ;
3. **Compte** et **méthode** — `key` avec le contenu de la clé privée, ou `password` ;
4. **Méthode sudo** — `nopasswd` ou `password` ;
5. **Plage de ports** — où les applications Docker pourront être publiées ; la valeur par défaut 30000-32767 est inutilisée sur une machine standard ;
6. **Étiquettes** — des paires `clé=valeur` facultatives pour trier votre parc ;
7. **Créer la cible** : un préflight démarre aussitôt.

La même chose par l’API, la clé lue dans un fichier :

```bash
jq -n --arg key "$(cat pupitre-target)" '{
  name: "prod-1", host: "203.0.113.10", port: 22,
  sshUser: "deploy", authMethod: "key", credential: $key,
  sudoMethod: "nopasswd"
}' | curl --fail-with-body -X POST {{origin}}/api/targets \
  -H "Authorization: Bearer $PUPITRE_TOKEN" \
  -H "Content-Type: application/json" --data @-
```

## Le préflight

Le préflight vérifie la machine, un contrôle à la fois, et aucun ne bloque les autres : un `kubectl` absent marque seulement K3s indisponible. Seule une session SSH impossible est fatale. Relancez-le depuis la fiche (onglet **Preflight**) ou par `POST /api/targets/{id}/preflight` (`target:update`).

| Contrôle | Ce qu’il lit |
|---|---|
| `ssh` | la connexion et sa latence |
| `os` | `uname -a` et `/etc/os-release` |
| `sudo` | si `sudo -n true` fonctionne |
| `tools` | `ufw`, `curl`, `git`, `docker`, `kubectl` |
| `docker` | `docker info` et `docker compose version` |
| `k3s` | les nœuds du cluster, ceux qui sont prêts, la version |
| `disk` | l’espace libre sur `/` |
| `memory` | `free -m` |

L’issue fixe le statut de la cible :

- **ok** — au moins un runtime est utilisable ;
- **dégradée** — la machine répond, mais rien ne peut y être déployé ;
- **injoignable** — aucune session SSH n’a pu s’ouvrir.

## La clé d’hôte

Pupitre vérifie la clé d’hôte SSH de la machine comme `ssh` le fait avec son `known_hosts`. Au premier contact, son empreinte (`SHA256:…`) est enregistrée — l’onglet **Configuration** la montre. Ensuite, une machine qui présente une autre clé est **refusée** : plus de déploiement, plus de préflight, plus de relevé, jusqu’à ce qu’un humain décide.

Quand cela arrive, la fiche le dit en haut, avec les deux empreintes :

1. vérifiez sur la machine elle-même que la nouvelle empreinte est la bonne :

   ```bash
   for key in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$key"; done
   ```

2. la machine a été réinstallée et l’empreinte correspond ? **Accepter la nouvelle clé** ;
3. vous ne la reconnaissez pas ? **Garder l’ancienne** : les connexions restent refusées, et l’alerte revient si la machine continue de la présenter.

L’évènement `security.host_key_changed` peut alerter vos canaux de notification. Changer l’hôte ou le port d’une cible oublie sa clé : c’est une autre machine.

## Relevés et seuils

Toutes les cinq minutes, le worker relève chaque machine — charge, nombre de cœurs, mémoire disponible, disque, durée de fonctionnement, système — et garde trente jours de relevés. La fiche montre le dernier ; un bouton en demande un nouveau (`GET /api/targets/{id}/metrics`).

| Seuil | Par défaut | Relevés pour l’ouvrir |
|---|---|---|
| Disque utilisé | 85 % | 1 |
| Mémoire utilisée | 90 % | 2 |
| Charge par cœur | 100 % | 3 |

Les seuils se règlent par machine et fonctionnent avec hystérésis : il faut autant de relevés en dessous pour refermer l’épisode. L’ouverture écrit `target.threshold.breached`, la fermeture `target.threshold.cleared` — une entrée par épisode, pas par relevé. Deux relevés manqués d’affilée marquent la machine **injoignable** (`target.unreachable`, avec la raison) ; le premier relevé qui réussit referme l’épisode (`target.reachable`).

## Les ports

L’onglet **Ports** (`GET /api/targets/{id}/ports`) dit, pour la plage de la cible, quels ports sont alloués, à quelle application, et combien il en reste. Un port est tiré au déploiement, vérifié libre sur la machine, et libéré quand plus aucune version de l’application n’y tourne. Sur K3s, aucun port n’est réservé.

## Les charges

L’onglet **Charges** liste **tout** ce qui tourne sur la machine — ce que Pupitre a déployé, marqué comme tel, et le reste (`workload:read`). Chaque ligne propose ce que son driver permet dans son état :

| Action | Docker | K3s | Permission |
|---|---|---|---|
| Journal | `docker logs` | `kubectl logs` de chaque pod du contrôleur | `workload:manage` |
| Démarrer, arrêter | `docker start` / `stop` | réplicas à zéro, puis rétablis | `workload:manage` |
| Redémarrer | `docker restart` | `kubectl rollout restart` | `workload:manage` |
| Mettre à jour | `docker pull`, recréation à l’identique | `kubectl rollout restart` | `workload:manage` |
| Supprimer | `docker rm -f`, volumes gardés | `kubectl delete`, PVC gardés | `workload:manage` |
| Console | `docker exec … sh -c` | `kubectl exec … sh -c` | `workload:exec` |

La **console** exécute une commande à la fois dans la charge — jamais sur l’hôte —, deux minutes et deux mille lignes au plus, trente commandes par minute. Chaque commande est consignée dans le journal d’activité avec son code de sortie ; sa sortie, jamais.

> [!IMPORTANT]
> Une charge que Pupitre a déployée ne se supprime pas d’ici : détruisez plutôt son déploiement (`deployment:destroy`), pour que le panel libère son port, son domaine et son enregistrement. L’arrêter et la redémarrer se fait depuis **Supervision**, qui garde son état.

## Le pare-feu

Si `ufw` est actif, le driver Docker ouvre le port de l’application quand il le faut — restreint à l’adresse du proxy quand c’est le proxy d’une autre machine qui la sert — et le referme à la destruction. Chaque règle porte le commentaire `pupitre:{application}`, pour la reconnaître et la retirer par son nom. Si `ufw` est absent ou inactif, le journal le dit et rien n’est filtré : Pupitre n’active jamais un pare-feu sur une machine qu’il pilote par SSH — le plus sûr moyen de la perdre.

## Supprimer une cible

`DELETE /api/targets/{id}` (`target:delete`), ou **Supprimer** sur la fiche. C’est un refus, jamais une cascade : une cible qui porte encore un déploiement en attente, en cours ou en service répond `409`, avec leur nombre. Détruisez d’abord ces déploiements.

Une cible qui ne porte que de l’historique (échoué, revenu en arrière, détruit) peut encore être retenue par lui. Purgez d’abord cet historique :

```bash
curl --fail-with-body -X POST {{origin}}/api/deployments/purge \
  -H "Authorization: Bearer $PUPITRE_TOKEN" -H "Content-Type: application/json" \
  -d '{"targetId":"<target id>","dryRun":true}'
```

Relancez-le avec `"dryRun": false` une fois l’aperçu correct (`deployment:purge`).
