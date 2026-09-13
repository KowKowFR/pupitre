# Rejouer la CI sur son poste

Deux workflows, deux natures.

| Workflow | Déclenchement | Durée mesurée | Ce qu'il lui faut |
| --- | --- | --- | --- |
| `ci.yml` | chaque poussée, chaque PR | **25 s** depuis un dépôt vierge | rien d'autre que Node et pnpm |
| `e2e.yml` | manuel, et 03:00 UTC en semaine | ~6 min ici, ~12 min sur un runner | Docker, la stack complète |

---

## `ci.yml` — le socle

### L'ordre n'est pas décoratif

`@pupitre/core` et `@pupitre/db` sont consommés **par leur `dist`** : le champ `exports` de
leurs `package.json` pointe vers `./dist/*.js` et `./dist/*.d.ts`, jamais vers
`src`. Sur une copie neuve, `dist/` n'existe pas.

Conséquence, mesurée et non supposée : lancer `pnpm -r typecheck` en premier
donne **35 erreurs** de la forme

```
src/schema/infra.ts(1,66): error TS2307: Cannot find module '@pupitre/core'
```

sur des symboles qui existent pourtant dans les sources. `pnpm -r` respecte bien
l'ordre topologique, mais cela ne suffit pas : le `typecheck` de `@pupitre/core` est
en `--noEmit`, il ne produit donc pas le `dist` dont `@pupitre/db` a besoin. Il faut
une vraie construction.

**`pnpm build:packages` d'abord. Toujours.**

### Le socle, dans l'ordre exact du workflow

Depuis un dépôt propre — sans `node_modules`, sans `dist` :

```bash
pnpm install --frozen-lockfile              #  3,5 s
pnpm build:packages                         #  3,3 s   ← prérequis des deux typecheck
pnpm -r typecheck                           #  6,6 s
pnpm exec tsc --noEmit -p scripts/tsconfig.json   #  0,9 s
pnpm --filter @pupitre/web lint                  #  5,0 s
pnpm --filter @pupitre/core test                 #  1,2 s   (205 tests, 2 ignorés)
pnpm test:schedule                          #  0,5 s
pnpm test:ai                                #  3,7 s   (hors ligne, aucune clé)
```

Durées relevées sur un Mac M-series. Compter deux à trois fois plus sur un
runner GitHub à 2 vCPU.

`pnpm typecheck` à la racine enchaîne déjà les trois premières lignes ; le
workflow les sépare pour que la ligne rouge nomme le contrôle fautif.

En CI, les six contrôles qui suivent la construction sont indépendants et
s'exécutent **tous**, même si l'un d'eux tombe : un seul passage donne l'ampleur
réelle des dégâts. Le tableau récapitulatif est en bas de la page du run.

### Versions

Ni Node ni pnpm ne sont choisis au hasard, et aucun n'est « le dernier » :

- **pnpm** — jamais écrit dans le workflow. `pnpm/action-setup` lit
  `packageManager` dans le `package.json` racine (`pnpm@10.32.1`).
- **Node 24** — `NODE_VERSION` en tête de `ci.yml`. Doit suivre l'`ARG
  NODE_VERSION` du `Dockerfile` (`24-alpine`) et `engines.node` (`>=24`).
  Il n'y a pas de `.nvmrc` ; s'il en apparaît un, il faudra les accorder.

---

## Les deux gardes

Elles tournent dans leur propre job, en parallèle du socle : un checkout, aucune
dépendance, quelques secondes.

### Garde 1 — aucun secret dans le dépôt

Cinq contrôles, écrits à la main plutôt qu'empruntés à un détecteur générique :

1. ni `.env` ni `.test-target-key*` dans l'index (à n'importe quelle profondeur) ;
2. `.gitignore` les couvre toujours — la protection d'origine n'a pas sauté ;
3. aucune valeur de `MASTER_KEY` ni de `BETTER_AUTH_SECRET` qui ait **la forme
   d'un secret** : ≥ 32 caractères, alphabet hex/base64 seulement. Le critère est
   la forme, pas une liste : `z.string().min(32)` et `${MASTER_KEY}` passent sans
   bruit, un vrai secret ne passe pas ;
4. aucune clé d'API à la forme réelle de son fournisseur (`sk-or-v1-` + hex,
   `sk-ant-`, `sk-proj-`, `ghp_`, `AKIA`) ;
5. aucune clé privée **complète**. L'en-tête PEM seul ne suffit pas à accuser :
   l'écran d'ajout de cible l'affiche comme exemple. C'est le corps — de longues
   lignes de base64 dans le même fichier — qui trahit une vraie clé.

Rejouer sur son poste :

```bash
# extrait le bloc `run:` du workflow et l'exécute tel quel
python3 - <<'PY' > /tmp/garde-secrets.sh
import yaml
wf = yaml.safe_load(open('.github/workflows/ci.yml'))
print(next(s['run'] for s in wf['jobs']['gardes']['steps'] if s.get('id') == 'secrets'))
PY
bash /tmp/garde-secrets.sh
```

### Garde 2 — les migrations sont immuables

`CLAUDE.md` : « jamais éditer une migration appliquée, toujours en créer une
nouvelle ». Une migration déjà passée sur une instance ne sera jamais rejouée :
la modifier ne change rien là-bas et tout ailleurs.

La garde refuse toute **modification**, **suppression** ou **renommage** d'un
`packages/db/migrations/*.sql` déjà présent sur la branche par défaut. Un ajout
reste évidemment permis.

La base de comparaison est **toujours** l'état de la branche par défaut, jamais
la poussée précédente — sans quoi une migration ajoutée puis retouchée avant la
fusion serait refusée à tort, alors qu'elle n'a jamais été appliquée nulle part.
Seule exception : la poussée sur la branche par défaut elle-même, où la base est
bien `github.event.before`.

```bash
python3 - <<'PY' > /tmp/garde-migrations.sh
import yaml
wf = yaml.safe_load(open('.github/workflows/ci.yml'))
print(next(s['run'] for s in wf['jobs']['gardes']['steps'] if s.get('id') == 'migrations'))
PY
GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/travail BRANCHE_DEFAUT=main AVANT='' \
  bash /tmp/garde-migrations.sh
```

---

## `e2e.yml` — les scripts de bout en bout

Neuf des vingt-six `verify-*.sh` y tournent : ceux qui se contentent de
`postgres`, `redis`, `panel`, `worker` et `mailpit`. Le workflow tire lui-même
`MASTER_KEY`, `BETTER_AUTH_SECRET` et le mot de passe Postgres au sort — **aucun
secret GitHub n'est nécessaire**.

Les dix-sept autres exigent une cible SSH docker-in-docker privilégiée, un vrai
cluster K3s, ou n'ont pas encore été éprouvés sur un runner. Le raisonnement
complet, chiffres à l'appui, est en tête de `.github/workflows/e2e.yml`.

Sur son poste, ces neuf scripts se lancent contre la stack habituelle :

```bash
docker compose up -d --wait
docker compose --profile test up -d mailpit
for s in rbac-audit onboarding roles account 2fa-reset settings schedules notifications monitors; do
  ./scripts/verify-$s.sh || echo "ÉCHEC : verify-$s.sh"
done
```

Durées mesurées : `roles` 2 s, `rbac-audit` 1 s, `settings` 4 s, `schedules` 5 s,
`notifications` 17 s, `onboarding` 23 s, `2fa-reset` 37 s, `account` 48 s,
`monitors` 2 min 24 (il attend de vrais cycles de sonde) — **281 s** en tout.

---

## Valider un changement de workflow sans pousser

```bash
# syntaxe YAML + schéma GitHub Actions + shellcheck des blocs `run:`
actionlint .github/workflows/*.yml
```

`actionlint` n'est pas une dépendance du projet : binaire autonome, à récupérer
sur la page des versions de `rhysd/actionlint`.
