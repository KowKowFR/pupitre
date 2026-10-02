# Traduire Pupitre

Ce fichier fait autorité sur les mots. Il se lit avant d'écrire une chaîne
anglaise, et il se met à jour quand un terme du domaine apparaît.

## La voix

Le panel parle **sobre, technique, à la deuxième personne**, avec un vocabulaire
d'instrument. Ses textes disent **pourquoi** plutôt que quoi, et annoncent
franchement ce qui ne marche pas.

L'anglais garde cette voix, pas les mots. « gérée par le panel — passez par son
déploiement » ne devient pas *managed by the panel — go through its deployment*
mais *managed by the panel — deploy it from there*. Une phrase française qui
tourne autour du verbe se réécrit en anglais autour du verbe : plus court, plus
direct, jamais plus bavard que l'original.

Trois réflexes :

- **Pas de mot à mot.** Si la version anglaise fait dix mots de plus, elle est
  fausse.
- **Pas de politesse ajoutée.** Ni *please*, ni *sorry*, ni *Oops*. Le français
  n'en met pas.
- **Pas d'euphémisme.** « rien ne sera analysé » devient *nothing will be
  scanned*, pas *scanning may be limited*.

Orthographe : **américaine** (`canceled`, `behavior`, `analyze`). C'est la
variante par défaut d'un projet open source, et `en-GB` comme `en-US` retombent
sur le même dictionnaire.

Typographie : le français garde ses guillemets `«  »` et son espace insécable
avant `: ; ? !`. L'anglais prend les guillemets courbes `“ ”` et pas d'espace
avant la ponctuation double. Les apostrophes anglaises sont `’`, pas `'`.

## Le glossaire

| Français | Anglais | Ne pas écrire |
| --- | --- | --- |
| cible | target | host, machine, server |
| sonde | probe | monitor *(désigne l'objet, pas la mesure)* |
| supervision (de sites) | monitoring | supervision |
| relevé | readout | reading, measurement, sample |
| déploiement | deployment | release, rollout |
| mise en ligne | going live / rollout | publishing |
| preflight | preflight | pre-flight, preflight check |
| étiquette | label | tag |
| seuil | threshold | limit |
| épisode | episode | incident *(réservé à `incident`)* |
| panne / incident | outage / incident | downtime |
| charge (de travail) | workload | container, pod |
| tâche planifiée | scheduled job | cron, task |
| file / queue | queue | job list |
| journal d'activité | activity log | audit log *(en UI ; `audit` reste la permission)* |
| enfilé (dans la queue) | queued | enqueued |
| bloqué (par un scan) | blocked | denied |
| coincé (déploiement) | stuck | frozen, hung |
| finding | finding | issue, vulnerability *(sauf en prose)* |
| scanner | scanner | analyzer |
| analyse (d'image) | scan | analysis |
| plan de contrôle | control plane | dashboard |
| assistant de démarrage | setup guide | onboarding wizard |
| étape | step | stage |
| rôle / permission | role / permission | — |
| clé d'API | API key | token |
| jeton d'API *(l'accès d'une CI au panel ; la clé d'API reste celle d'un fournisseur d'IA)* | API token | key, PAT |
| second facteur | second factor | 2FA *(sauf en libellé court)* |
| canal (de notification) | channel | destination |
| résumé (digest) | digest | summary *(réservé à « récapitulatif »)* |
| récapitulatif | summary | recap |
| régionalisation | regional settings | localization, i18n |
| instance | instance | server, site |
| paramètres d'instance | instance settings | preferences, config |
| identifiant | ID | identifier |
| hôte | host | — |
| port alloué | allocated port | assigned port |
| rollback | rollback | roll back *(en nom)* |
| purge | purge | cleanup |
| relancer | run again / restart | relaunch, retry *(retry = « réessayer »)* |
| écarter (un scanner) | skip | disable *(réservé à « désactiver »)* |
| poser (un seuil, une clé) | set | put, place |
| joignable / injoignable | reachable / unreachable | available |
| en panne | down | offline |
| rétabli | recovered | back up |

## Le glossaire, par domaine

Les mots ci-dessus valent partout. Ceux-ci ont été tranchés en traduisant un
écran précis ; ils sont ici pour que le suivant ne retranche pas autrement.

### Cibles, charges, parc

| Français | Anglais |
| --- | --- |
| parc | fleet |
| machine (dans un inventaire) | host |
| genre d'une charge | `container` / `pod` / `deployment` *(des clés, pas des mots)* |
| plage de ports publiables | publishable port range |
| élévation sudo | sudo elevation |
| empreinte (SSH) | fingerprint |
| contrôle (de preflight) | check |
| hors panel | outside the panel |
| fiche (d'une cible) | details |
| Gio / Mio | GiB / MiB *(base 1024 — vérifier le calcul avant de choisir)* |

### Déploiements, applications, scans

| Français | Anglais |
| --- | --- |
| bloquant / conforme | blocking / clear |
| indéterminé / en erreur | inconclusive / errored |
| sans objet (étape) | not applicable |
| exposition / exposé | exposure / exposed |
| réclamée par | claimed by |
| forçage / forcer l'effacement | forcing / force the erase |
| garde-fou | guardrail |
| rejouer une version | replay a version |
| défilement auto | auto-scroll |
| flux de logs / flux en direct | log stream / live stream |
| tout décocher | uncheck all |
| seuil de blocage | blocking threshold |
| bloquer sur HIGH ou plus | block on HIGH and above |

### Supervision, sondes, tâches

| Français | Anglais |
| --- | --- |
| mesure *(un relevé de sonde)* | readout *(comme « relevé » — un seul mot pour une seule chose)* |
| cadence | cadence *(rendue « every … », jamais « rate »)* |
| balayage | sweep |
| frise (des verdicts) | strip |
| bannière (TCP) | banner |
| préavis avant expiration | warning lead time |
| verrou de transfert | transfer lock |
| nom interrogé (DNS) | name queried |
| comparateur (avant / pendant) | comparator |
| jour du mois / jour de la semaine | day of month / day of week |
| échec consécutif | consecutive failure |
| panne de {durée} | down for {duration} |
| suspendue automatiquement | paused automatically |
| répond mal | answers badly |

### Comptes, rôles, journal

| Français | Anglais |
| --- | --- |
| connexion / se connecter | sign-in / sign in |
| déconnexion | signing out |
| inscription / créer un compte | signing up / create an account |
| code de secours | recovery code |
| jeton / lien périmé | token / expired link |
| invitation périmée | invitation expired |
| relancer (une invitation) | send again *(« run again » vise une tâche)* |
| réactiver (un compte) | re-enable |
| configuration en cours (2FA) | setup under way |
| système / anonyme | system / anonymous |
| traçabilité | traceability |
| type de ressource | resource type |
| nom affiché | displayed name |

### Paramètres, assistant, alertes

| Français | Anglais |
| --- | --- |
| prise en main / premiers pas | getting started / first steps |
| parcours de prise en main | walkthrough *(distinct de « setup guide » = l'assistant) *|
| sous-titre (de l'instance) | tagline |
| faite / passée / à faire | done / skipped / to do |
| passage (compteur de relances) | run |
| branchées (pastille de canaux) | wired |
| garde-fou de volume | volume guard |
| inactifs (champs en lecture seule) | inert |
| économique / équilibré / le plus capable | budget / balanced / most capable |
| constat (champ d'alerte) | observation |
| pire valeur atteinte | worst value reached |
| origine du seuil / levée par | threshold origin / cleared by |
| version tentée / restaurée | attempted / restored version |
| chiffrement (champ SMTP) | encryption |
| identifiant de conversation | chat ID |
| poste d'exploitation | operations desk |
| en vol | in flight |
| refus d'accès | access denials |

## Le mécanisme

Les dictionnaires vivent dans `messages/`, **un module par surface**. Chacun
n'importe que des *types* : c'est ce qui permet à la garde de les charger avec
Node sans rien compiler.

```ts
import type { Translated } from '@pupitre/core';

const fr = {
  'page.title': 'Cibles',
  'count': { one: '{count} cible', other: '{count} cibles' },
} as const;

const en: Translated<typeof fr> = {
  'page.title': 'Targets',
  'count': { one: '{count} target', other: '{count} targets' },
};

export const targets = { fr, en };
```

L'annotation `Translated<typeof fr>` est **la** garde : une clé manquante, une
clé en trop ou un pluriel promis puis rendu en chaîne simple font échouer
`pnpm typecheck`. Aucune traduction ne peut donc partir à moitié.

Usage :

```tsx
// composant serveur
const t = await getT(targets);   // @/i18n/server
// composant client
const t = useT(targets);         // @/i18n/client
t('page.title');
t('count', { count: n });
```

## Les pluriels

`${n > 1 ? 's' : ''}` ne survit pas à l'anglais : le français écrit « 0 cible
prête », l'anglais *0 targets ready*. `Intl.PluralRules` connaît cette
différence — on lui laisse le travail.

```ts
'ready': { one: '{count} cible prête', other: '{count} cibles prêtes' },
```

`zero` est facultatif et n'est pas une forme grammaticale : c'est la place de
« Aucune cible » là où « 0 cible » se lirait mal.

## La règle qui ne se discute pas

**La colonne `fr` reproduit à l'identique la chaîne qui existait.** Pas une
virgule déplacée, pas une apostrophe redressée. Des vérifications d'intégration
cherchent ces chaînes exactes dans le HTML servi ; le français par défaut doit
rester octet pour octet ce qu'il était. Une amélioration de formulation
française est un autre commit.

## La frontière

Traduit : tout ce qui s'affiche dans le panel, les messages d'erreur de l'API,
les e-mails transactionnels, les alertes des canaux.

Pas traduit, et volontairement : les commentaires de code, les messages Pino,
les clés de permission, les codes d'erreur, les noms d'action du journal
d'activité, les identifiants de queue et les libellés de fournisseurs.

Pas traduit non plus, parce que ce sont des **données** et non des phrases : ce
qu'un utilisateur a saisi (nom d'instance, sous-titre, description de cible,
libellé de rôle), les charges utiles du journal d'activité, les lignes de log de
déploiement écrites par le worker, et les sorties de commandes distantes.

## L'échappatoire

Une chaîne française légitime dans un composant — un script shell à
copier-coller, un marqueur interne, une valeur d'audit — se marque avec un
commentaire `i18n-ignore` **sur la ligne ou juste au-dessus**, qui dit
*pourquoi*. La marque couvre la déclaration qu'elle précède et s'arrête à la
première ligne vide.

```ts
// i18n-ignore — charge utile d'audit, figée à l'écriture : la traduire
// fixerait la langue de la trace pour toujours.
secrets: channel.configuredSecrets.map((field) => `${field} (défini)`),
```

Trois familles n'ont besoin d'aucune marque, la garde les traverse d'elle-même :
`logger.*()`, `console.*()` et `new Error()`.
