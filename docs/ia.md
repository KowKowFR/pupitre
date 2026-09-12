# Génération d'AppSpec par IA

Le LLM produit **du JSON validé par Zod**. Jamais de shell, jamais de commande,
jamais un chemin de fichier. C'est notre code qui exécute — et il n'exécute que
ce qui a passé `appSpecSchema`.

C'est une fonctionnalité **facultative**. Sans clé, la route répond `501` avec un
message explicite, l'onglet « Depuis une description » est désactivé et le dit,
et le reste du panel fonctionne à l'identique.

## Le flux

```
POST /api/applications/generate     application:create
  { prompt, hints? }
      ↓  generateObject()  — Vercel AI SDK
      ↓  safeParseAppSpec() — refinements compris
  { appSpec, model, usage, attempts }        ← RIEN n'est persisté
      ↓  l'utilisateur relit, corrige dans l'éditeur JSON
POST /api/applications              application:create
  { appSpec, generation: { prompt, model, appSpec } }
```

La génération n'écrit pas en base et ne déploie pas. **Une IA qui créerait
l'application elle-même retirerait à l'opérateur le seul moment où il peut dire
non.** Le bouton « Enregistrer » est le même dans les deux onglets de
`/applications/new`, et il emprunte la même route que l'import manuel.

## Trois fournisseurs

Le catalogue est une donnée pure, sans dépendance : `packages/core/src/ai/catalog.ts`.
`@pupitre/db` et le worker peuvent donc connaître la liste des fournisseurs sans tirer
le SDK IA dans leur graphe.

| Clé | Modèle par défaut | Variables d'env | `baseUrl` |
|---|---|---|---|
| `openrouter` | `anthropic/claude-sonnet-4.5` | `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | non |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` / `OPENAI_MODEL` | **oui** |
| `anthropic` | `claude-sonnet-4-5` | `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | non |

**La liste de modèles est statique.** Rien ne va interroger le fournisseur pour
savoir ce qu'il propose : le catalogue porte trois à cinq modèles par
fournisseur, avec un palier (`économique` / `équilibré` / `capable`) et un prix
indicatif en $/M jetons, **relevés le 11/09/2026**. La liste est suggestive, et
doublée d'une option « Autre — saisir un identifiant » avec un champ libre.

Les modèles à raisonnement (`gpt-5`, `o*`) en sont volontairement exclus : ils
dépassent la borne de temps de la route.

`aiModelMismatch()` **prévient sans interdire** : saisir `claude-…` alors que le
fournisseur est OpenAI affiche une alerte (« a la forme d'un identifiant
Anthropic, pas OpenAI »). Elle est neutralisée si une `baseUrl` est renseignée —
une API compatible OpenAI auto-hébergée sert ce qu'elle veut.

Le champ `baseUrl` n'est affiché **et envoyé** que si le fournisseur le déclare :
refus explicite de laisser en base un réglage sans effet.

### D'où vient la clé

```
apiKey = clé des paramètres d'instance ?? env[variable du fournisseur]
model  = modèle des paramètres ?? env[variable du fournisseur] ?? défaut du catalogue
enabled = ai.enabled ET une clé existe
```

**Le paramètre d'instance l'emporte.** La variable d'environnement est le filet :
un panel provisionné par `docker compose` génère sans que personne n'ait ouvert
l'écran des paramètres.

La variable lue **dépend du fournisseur retenu** : `OPENROUTER_API_KEY` ne servira
jamais à joindre Anthropic.

`ai.enabled` est un **interrupteur, pas une conséquence** : décoché, la
génération est coupée même avec une clé valide, et le `501` porte alors un motif
distinct de « pas de clé ».

Détail d'architecture : `@pupitre/core` n'importe ni `@pupitre/db` ni `apps/web`, donc les
deux sources lui sont **passées en argument**. Les appelants passent
`process.env` brut, et non l'environnement validé du panel — délibérément, pour
qu'ajouter un quatrième fournisseur ne force pas à toucher `env.ts`.

> Il n'existe **aucun bouton de test de connexion** pour l'IA. Le test se fait de
> fait en tentant une génération. Et `GET /api/health` publie un état `ai` qui ne
> lit que `OPENROUTER_API_KEY` en variable d'environnement : il ignore les
> paramètres d'instance et les deux autres fournisseurs. Une instance
> parfaitement configurée en base y apparaît `ai.enabled: false`.

## `generateObject()`, pas `generateText()` + `JSON.parse`

Le schéma passé au SDK est `appSpecShapeSchema` — la *forme* de l'AppSpec, sans
les contraintes croisées. Un JSON Schema ne sait de toute façon pas exprimer
« exactement un service exposé » ni « pas de cycle dans `dependsOn` » : ces
règles disparaissent à la traduction, quel que soit le schéma qu'on donne.

En gardant la validation complète de notre côté, c'est **notre** code qui tient
le verdict et qui peut réinjecter les reproches de Zod dans une relance, au lieu
de la déléguer au SDK et d'aller repêcher un `ZodError` au fond d'une chaîne de
`cause`.

Le mode strict des sorties structurées est désactivé pour OpenRouter et OpenAI :
l'AppSpec utilise un `discriminatedUnion`, donc un `oneOf`, que le mode strict
d'OpenAI refuse. La validation Zod côté panel reste la vraie garantie.

## Une relance, pas deux

Si la spec ne passe pas la validation, on relance **une seule fois** en
réinjectant les erreurs de Zod, chemin par chemin, mot pour mot. Si la seconde
échoue aussi, on rend la main avec la liste des reproches. **On ne « répare » pas
le JSON à la main** : réparer, c'est écrire soi-même la moitié de la spec sans
que personne ne l'ait demandé.

Trois motifs d'échec, trois codes HTTP, parce que ce sont trois pannes
différentes et qu'elles n'appellent pas la même réaction :

| Motif | HTTP | Ce qui s'est passé |
|---|---|---|
| `invalid_spec` | 422 | le modèle a répondu, sa spec ne passe pas la validation — même après relance |
| `no_object` | 422 | le modèle n'a pas produit d'objet JSON exploitable |
| `provider` | 502 | réseau, quota, clé refusée, délai dépassé — le modèle n'a rien dit |

## Le prompt système est un fichier

`packages/core/src/ai/prompts/generate-appspec.md`, versionné comme du code. Il
décrit le schéma et ses contraintes, impose des images officielles en tag précis
(**jamais `latest`**), un healthcheck par service, des `resources` réalistes, la
compatibilité `runAsNonRoot`, l'usage des alias de secrets, et l'interdiction des
secrets en clair dans `env`.

Il porte des marques `{{FIXTURE:nom.json}}` remplacées au chargement par le
contenu **réel** des trois fixtures. Recopier les fixtures dans le markdown aurait
été plus simple, et faux : les exemples few-shot auraient dérivé au premier
changement de fixture, sans que rien ne le signale.

**Charger ce fichier a été le vrai piège.** `tsc` ne copie pas les `.md` vers
`dist/` : le script `build` de `packages/core` les recopie. Mais surtout, Next
**inline** `@pupitre/core` dans ses chunks serveur — `import.meta.url` n'y désigne plus
le paquet, et le traceur ne voit aucun `import` vers un `.md`. Trois mesures,
aucune superflue :

1. `outputFileTracingIncludes` dans `next.config.ts` embarque le prompt et les
   fixtures dans l'arbre `standalone`, à leur chemin depuis la racine du monorepo ;
2. `readCoreAsset()` essaie plusieurs candidats — à côté du module, puis relatifs
   au répertoire courant, où le serveur `standalone` se place dans `apps/web` ;
3. **chaque candidat est validé par son contenu.** Turbopack réécrit
   `new URL(…, import.meta.url)` : le `readFileSync` réussissait parfaitement et
   rendait le code source d'un module JavaScript à la place du prompt. Constaté,
   pas supposé — la sonde annonçait 1 701 octets là où le prompt en faisait 9 966.
   Sans validation de contenu, l'erreur est silencieuse et le modèle répond
   n'importe quoi sans que rien n'ait échoué.

C'est aussi pourquoi `/api/health` charge le prompt et publie sa taille : un
fichier manquant dans une image doit se voir dans la sonde, pas devant le premier
utilisateur.

## Garde-fous

| Garde-fou | Valeur | Où |
|---|---|---|
| Taille du prompt | 8 à 4 000 caractères | Zod, avant tout appel |
| Délai | 60 s | `AbortSignal.timeout` |
| Débit | 10 générations / 10 min / **utilisateur** | Redis, `INCR` + `EXPIRE` |
| Tentatives | 2 au maximum | boucle de `generateAppSpec()` |

Le compteur de débit est par utilisateur et non par IP : derrière un NAT
d'entreprise tout le monde partage une adresse, et la session est de toute façon
obligatoire. Redis indisponible **laisse passer** — un compteur en panne ne doit
pas couper une fonctionnalité — mais l'incident est journalisé.

Le corps est validé **avant** de regarder la configuration : une requête mal
formée est mal formée sur tous les panels, avec ou sans clé. L'inverse rendrait
la réponse dépendante du déploiement, et un client ne pourrait plus distinguer
« ma requête est fausse » de « ce panel n'a pas d'IA ».

Chaque génération passe par `logAudit()` — prompt, modèle, tokens, durée,
tentatives, succès ou motif d'échec. La clé, elle, n'apparaît nulle part : ni
dans un log, ni dans une entrée d'audit, ni dans la réponse. Voir
[`securite.md`](securite.md#chiffrement) pour ce qui est expurgé, et pourquoi ça
va au-delà de la valeur exacte.

## Sans clé

La chaîne complète — prompt, validation, relance unique, rejet propre, panne du
fournisseur — est couverte par `packages/core/test/ai.test.ts` avec un **modèle
simulé** (`MockLanguageModelV3`).

Aucune clé n'est configurée sur ce dépôt. `verify-ai.sh` le dit en tête de
fichier et ne l'invente pas : ce qui dépend d'un fournisseur est joué soit hors
ligne, soit sur son refus propre. **Personne n'a vu un vrai modèle répondre sur
cette instance.**
