# Pupitre — Plan par jalons

Durée : 10 jours ouvrés. Chaque jalon a un **critère de sortie vérifiable**.
Règle absolue : on ne passe pas au jalon suivant tant que le critère de sortie n'est pas atteint.
Si un jalon prend du retard, on coupe dans le P1/P2, jamais dans le P0.

---

## J0 — Décisions figées (avant d'écrire du code)

| Question | Décision |
|---|---|
| Front | Next.js 15 App Router (bascule Fastify + Vite si personne ne connaît React) |
| Build des images | Sur la machine cible via SSH (pas de registry pour le v2) |
| Proxy par défaut | Traefik sur les deux runtimes. BunkerWeb = P1 |
| Scheduler | BullMQ repeatable jobs. Pas de cron Linux |
| Server Actions | Interdites pour les opérations de déploiement. Route Handlers REST uniquement |

---

## Jalon 1 — Socle qui tourne (J1)

**Objectif :** les 4 conteneurs se parlent. Aucune feature.

- Monorepo pnpm : `apps/web`, `apps/worker`, `packages/db`, `packages/core`
- `docker-compose.yml` : panel, worker, postgres, redis
- Dockerfile multi-stage, `output: 'standalone'`, une image / deux commandes
- Schéma Drizzle **complet** (toutes les tables, même celles non utilisées avant J8)
- Première migration appliquée au démarrage
- Un job BullMQ de test : la route `/api/ping` enfile, le worker log, retour visible

**Critère de sortie :** `docker compose up` sur une machine vierge → `/api/health` répond, le worker consomme un job.

---

## Jalon 2 — Identité et traçabilité (J2)

- Better Auth + plugin admin, sessions en base
- Rôles seedés : `admin`, `operator`, `viewer`
- Permissions en chaînes : `target:*`, `deployment:create`, `user:manage`, `scan:read`...
- Helper `requirePermission()` utilisé par **toutes** les routes protégées
- Audit log écrit par un point d'entrée unique (`logAudit()`), jamais dispersé
- Chiffrement des secrets en base avec `MASTER_KEY` (node:crypto, AES-256-GCM)

**Critère de sortie :** un `viewer` reçoit 403 sur `POST /api/deployments`, et la tentative apparaît dans `audit_logs`.

---

## Jalon 3 — Machines cibles (J3)

- CRUD `targets` (host, port, user, auth_method, clé ou mot de passe chiffré)
- Job `target:preflight` : connexion SSH, sudo, `docker info`, `kubectl get nodes`
- Stockage du résultat : runtimes disponibles, version, date du dernier check
- UI : liste des cibles avec badge de statut, bouton "Tester la connexion"

**Critère de sortie :** ajouter une VM depuis l'UI, voir "Docker ✓ / K3s ✗" apparaître sans rechargement manuel.

---

## Jalon 4 — Driver Docker de bout en bout (J4–J5)

**C'est le jalon le plus important du projet.**

- `AppSpec` (Zod) — spec neutre, ne connaît ni Docker ni K8s
- Interface `DeploymentDriver`
- `DockerComposeDriver` : render compose → scp → `compose up -d`
- Machine à états : `deployments` + `deployment_steps` (pending/running/success/failed)
- Worker publie ses logs sur Redis `deploy:{id}`
- Route SSE `/api/deployments/[id]/logs` qui s'abonne au canal
- UI progression : steps à gauche, logs live à droite (reprendre le design du v1)

**Critère de sortie :** déployer une app depuis l'UI sur une cible Docker, suivre les logs en direct, obtenir une URL qui répond.

---

## Jalon 5 — Driver K3s (J6)

- `K3sDriver` : render manifests → `kubectl apply` → `rollout status`
- Réutilisation de `gen_manifests.sh` du v1 comme template
- Namespace par app : `app-{slug}`
- `allocatePort()` retourne `null` (l'exposition passe par l'Ingress)

**Critère de sortie — LE TEST DE VÉRITÉ :**
déployer **la même `AppSpec`** sur une cible Docker et une cible K3s, obtenir deux URLs qui répondent.
Si du code spécifique au runtime a dû fuiter hors des drivers, on corrige immédiatement.

---

## Jalon 6 — Sécurité (J7)

- Interface `Scanner` + `ScanReport` normalisé
- `TrivyScanner`, `GrypeScanner`, `SyftSBOM`
- Exécution en parallèle, sélection par cases à cocher dans le formulaire
- Gate : `fail_on: CRITICAL | HIGH | none` stocké en donnée
- Affichage : quel scanner a tourné, findings par sévérité, SBOM téléchargeable

**Critère de sortie :** une image volontairement vulnérable bloque le déploiement ; décocher Trivy et garder Grype donne le même verdict.

---

## Jalon 7 — Cycle de vie (J8) · P1

- `port_allocations` avec contrainte unique `(target_id, port)`
- UFW : ouverture à l'allocation, fermeture au destroy
- Healthcheck post-deploy
- Rollback automatique si le healthcheck échoue
- Historique des versions/images déployées

**Critère de sortie :** déployer une v2 cassée → rollback auto vers la v1 → l'URL répond toujours.

---

## Jalon 8 — IA et automatisation (J9) · P1

- Intégration OpenRouter via Vercel AI SDK
- Prompt pré-câblé → **JSON validé par Zod** (jamais de shell généré)
- Jobs planifiés BullMQ : scans périodiques, healthchecks
- BunkerWeb `ProxyProvider` si le temps le permet

**Critère de sortie :** "déploie-moi un blog Node avec Postgres" → AppSpec valide → déploiement réussi.

---

## Jalon 9 — Livraison (J10)

- Dashboard : historique déploiements + scans, filtres, gestion users
- README + schéma d'archi
- Jeu de données de démo
- **Répétition de la démo en conditions réelles, deux fois**

**Critère de sortie :** un `docker compose up` sur une machine neuve, suivi du scénario de démo complet, sans intervention manuelle.

---

## Parallélisation (si ≥ 2 personnes)

| Piste A — Plateforme | Piste B — Exécution |
|---|---|
| J1 socle (ensemble) | J1 socle (ensemble) |
| J2 auth + RBAC + audit | J2 SSH + preflight |
| J3 CRUD targets + UI | J3 AppSpec + interface Driver |
| J4–5 UI progression + SSE | J4–5 DockerComposeDriver |
| J6 dashboard historique | J6 K3sDriver |
| J7 UI scanners + findings | J7 Scanners + gate |

Point de synchro obligatoire en fin de J1, J5 et J7.

---

## Ce qu'on coupe sans discussion si on prend du retard

1. BunkerWeb (Traefik seul)
2. Mises à jour Docker automatiques
3. Vérification de certificats
4. Nettoyage automatique
5. Multi-apps déployées simultanément

Aucune de ces coupes ne change la démo. Un pipeline qui échoue en live, si.
