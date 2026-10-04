# Translating Pupitre

This file is the authority on words. Read it before writing an English string,
and update it when a domain term appears.

The French dictionary is the source: each `messages/*.ts` module declares
`const fr` first, and `const en: Translated<typeof fr>` follows it key for key.
The tables below therefore go from French to English.

## The voice

The panel speaks **plainly, technically, in the second person**, with an
instrument's vocabulary. Its texts say **why** rather than what, and announce
frankly what does not work.

English keeps that voice, not the words. « gérée par le panel — passez par son
déploiement » does not become *managed by the panel — go through its deployment*
but *managed by the panel — deploy it from there*. A French sentence that turns
around the verb is rewritten in English around the verb: shorter, more direct,
never wordier than the original.

Three reflexes:

- **No word for word.** If the English version has ten more words, it is wrong.
- **No added politeness.** Neither *please*, nor *sorry*, nor *Oops*. The French
  puts none.
- **No euphemism.** « rien ne sera analysé » becomes *nothing will be scanned*,
  not *scanning may be limited*.

Spelling: **American** (`canceled`, `behavior`, `analyze`). It is the default
variant of an open source project, and `en-GB` as well as `en-US` fall back on
the same dictionary.

Typography: French keeps its `«  »` quotation marks and its non-breaking space
before `: ; ? !`. English takes curly quotes `“ ”` and no space before double
punctuation. English apostrophes are `’`, not `'`.

## The glossary

| French | English | Do not write |
| --- | --- | --- |
| cible | target | host, machine, server |
| sonde | probe | monitor *(designates the object, not the measurement)* |
| supervision (de sites) | monitoring | supervision |
| relevé | readout | reading, measurement, sample |
| déploiement | deployment | release, rollout |
| mise en ligne | going live / rollout | publishing |
| preflight | preflight | pre-flight, preflight check |
| étiquette | label | tag |
| seuil | threshold | limit |
| épisode | episode | incident *(reserved for `incident`)* |
| panne / incident | outage / incident | downtime |
| charge (de travail) | workload | container, pod |
| tâche planifiée | scheduled job | cron, task |
| file / queue | queue | job list |
| journal d'activité | activity log | audit log *(in the UI; `audit` stays the permission)* |
| enfilé (dans la queue) | queued | enqueued |
| bloqué (par un scan) | blocked | denied |
| coincé (déploiement) | stuck | frozen, hung |
| finding | finding | issue, vulnerability *(except in prose)* |
| scanner | scanner | analyzer |
| analyse (d'image) | scan | analysis |
| plan de contrôle | control plane | dashboard |
| assistant de démarrage | setup guide | onboarding wizard |
| étape | step | stage |
| rôle / permission | role / permission | — |
| clé d'API | API key | token |
| jeton d'API *(a CI's access to the panel; the API key stays an AI provider's)* | API token | key, PAT |
| second facteur | second factor | 2FA *(except in a short label)* |
| canal (de notification) | channel | destination |
| résumé (digest) | digest | summary *(reserved for « récapitulatif »)* |
| récapitulatif | summary | recap |
| régionalisation | regional settings | localization, i18n |
| instance | instance | server, site |
| paramètres d'instance | instance settings | preferences, config |
| identifiant | ID | identifier |
| hôte | host | — |
| port alloué | allocated port | assigned port |
| rollback | rollback | roll back *(as a noun)* |
| purge | purge | cleanup |
| relancer | run again / restart | relaunch, retry *(retry = « réessayer »)* |
| écarter (un scanner) | skip | disable *(reserved for « désactiver »)* |
| poser (un seuil, une clé) | set | put, place |
| joignable / injoignable | reachable / unreachable | available |
| en panne | down | offline |
| rétabli | recovered | back up |

## The glossary, by area

The words above apply everywhere. These were decided while translating a given
screen; they are here so that the next person does not decide otherwise.

### Targets, workloads, fleet

| French | English |
| --- | --- |
| parc | fleet |
| machine (in an inventory) | host |
| genre d'une charge | `container` / `pod` / `deployment` *(keys, not words)* |
| plage de ports publiables | publishable port range |
| élévation sudo | sudo elevation |
| empreinte (SSH) | fingerprint |
| contrôle (de preflight) | check |
| hors panel | outside the panel |
| fiche (d'une cible) | details |
| Gio / Mio | GiB / MiB *(base 1024 — check the computation before choosing)* |

### Deployments, applications, scans

| French | English |
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

### Monitoring, probes, jobs

| French | English |
| --- | --- |
| mesure *(a probe readout)* | readout *(like « relevé » — a single word for a single thing)* |
| cadence | cadence *(rendered « every … », never « rate »)* |
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

### Accounts, roles, activity log

| French | English |
| --- | --- |
| connexion / se connecter | sign-in / sign in |
| déconnexion | signing out |
| inscription / créer un compte | signing up / create an account |
| code de secours | recovery code |
| jeton / lien périmé | token / expired link |
| invitation périmée | invitation expired |
| relancer (une invitation) | send again *(« run again » is for a job)* |
| réactiver (un compte) | re-enable |
| configuration en cours (2FA) | setup under way |
| système / anonyme | system / anonymous |
| traçabilité | traceability |
| type de ressource | resource type |
| nom affiché | displayed name |

### Settings, setup guide, alerts

| French | English |
| --- | --- |
| prise en main / premiers pas | getting started / first steps |
| parcours de prise en main | walkthrough *(distinct from « setup guide » = the wizard)* |
| sous-titre (de l'instance) | tagline |
| faite / passée / à faire | done / skipped / to do |
| passage (counter of reruns) | run |
| branchées (channel badge) | wired |
| garde-fou de volume | volume guard |
| inactifs (read-only fields) | inert |
| économique / équilibré / le plus capable | budget / balanced / most capable |
| constat (alert field) | observation |
| pire valeur atteinte | worst value reached |
| origine du seuil / levée par | threshold origin / cleared by |
| version tentée / restaurée | attempted / restored version |
| chiffrement (SMTP field) | encryption |
| identifiant de conversation | chat ID |
| poste d'exploitation | operations desk |
| en vol | in flight |
| refus d'accès | access denials |

## The mechanism

The panel's dictionaries live in `messages/`, **one module per surface**. Each
one only imports *types*: that is what lets the guard load them with Node without
compiling anything.

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

The `Translated<typeof fr>` annotation is **the** guard: a missing key, an extra
key or a plural promised then returned as a plain string fail `pnpm typecheck`.
No translation can therefore go out half done.

Usage:

```tsx
// server component
const t = await getT(targets);   // @/i18n/server
// client component
const t = useT(targets);         // @/i18n/client
t('page.title');
t('count', { count: n });
```

Away from the screens, `@pupitre/core`, the worker and `@pupitre/db` follow the
same pattern in their own `messages.ts` files, with `translator(copy, language)`
from `@pupitre/core`: the language comes from the instance, through the context
(`TargetContext.language`, `ProbeContext.language`…).

## Plurals

`${n > 1 ? 's' : ''}` does not survive English: French writes « 0 cible prête »,
English *0 targets ready*. `Intl.PluralRules` knows that difference — we leave
it the work.

```ts
'ready': { one: '{count} cible prête', other: '{count} cibles prêtes' },
```

`zero` is optional and is not a grammatical form: it is the place for « Aucune
cible » where « 0 cible » would read badly.

## The rule that is not up for debate

**The `fr` column reproduces the string that existed exactly.** Not a comma
moved, not an apostrophe straightened. Integration checks look for these exact
strings in the served HTML; the default French must stay byte for byte what it
was. An improvement of French wording is another commit.

## The boundary

Translated: everything shown in the panel, the API's error messages,
transactional emails, channel alerts, deployment logs, driver errors and schema
complaints — the last three when they are emitted, in the instance's language.

Not translated, on purpose: code comments, Pino messages, permission keys, error
codes, activity log action names, queue identifiers and provider labels.

Not translated either, because they are **data** and not sentences: what a user
entered (instance name, tagline, target description, role label), activity log
payloads, a deployment log line already written (it stays in the language it was
written in), and the output of remote commands.

## The escape hatch

A legitimate French string in a component — a shell script to copy and paste,
an internal marker, an audit value — is marked with an `i18n-ignore` comment
**on the line or just above**, which says *why*. The mark covers the
declaration it precedes and stops at the first empty line.

```ts
// i18n-ignore — audit payload, frozen when written: translating it would fix
// the language of the trace forever.
secrets: channel.configuredSecrets.map((field) => `${field} (défini)`),
```

Three families need no mark, the guard goes through them by itself:
`logger.*()`, `console.*()` and `new Error()`.
