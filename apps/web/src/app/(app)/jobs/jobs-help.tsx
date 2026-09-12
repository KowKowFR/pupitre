'use client';

import { SCHEDULED_JOB_TYPES, SCHEDULED_JOB_TYPES_LIST } from '@pupitre/core/schedule';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Aide sur les tâches planifiées — contenu statique, aucune donnée serveur.
 *
 * Même parti pris que `components/appspec-help.tsx` : le composant `ui/dialog`
 * reste neutre, tout ce qui parle d'ordonnancement vit ici. Chaque phrase suit
 * `apps/worker/src/schedule/runners.ts` et `apps/worker/src/handlers/scheduled.ts`
 * — ce qui est décrit est ce que le code fait, pas ce qu'on aimerait qu'il fasse.
 */

type Props = {
  label?: string;
  className?: string;
  /** Fuseau des paramètres d'instance : le pré-réglage d'une tâche neuve. */
  defaultTimeZone: string;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.8em]">
      {children}
    </code>
  );
}

function ScrollableTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

/**
 * Ce que fait *réellement* chaque type, lu dans les runners du worker.
 * `SCHEDULED_JOB_TYPES` fournit le nom BullMQ, le libellé et la garantie
 * négative ; ce tableau ajoute le déroulé et le paramétrage.
 */
const WHAT_THEY_DO: Record<
  (typeof SCHEDULED_JOB_TYPES_LIST)[number],
  { steps: React.ReactNode; payload: React.ReactNode }
> = {
  scan: {
    steps: (
      <>
        Parcourt les déploiements <em>courants</em>, ouvre une session SSH sur chaque cible,
        demande au driver la liste des images en service, puis relance les scanners configurés
        pour l&apos;application. Les rapports s&apos;<strong>empilent</strong> au lieu de
        remplacer les précédents : c&apos;est ce qui permet de voir une image inchangée se
        dégrader au fil des semaines.
      </>
    ),
    payload: (
      <>
        <Code>scanners</Code> et <Code>failOn</Code> pour forcer la configuration ;
        <Code>applicationIds</Code> / <Code>targetIds</Code> pour restreindre le champ. Sans
        scanner configuré, l&apos;application est sautée — la tâche n&apos;en impose aucun.
      </>
    ),
  },
  healthcheck: {
    steps: (
      <>
        Sonde chaque déploiement courant par <Code>driver.healthcheck()</Code> et écrit le
        résultat (<Code>healthy</Code>, <Code>unhealthy</Code>, <Code>unreachable</Code>) dans
        l&apos;historique de santé du déploiement.
      </>
    ),
    payload: (
      <>
        <Code>applicationIds</Code> / <Code>targetIds</Code> uniquement.
      </>
    ),
  },
  cleanup: {
    steps: (
      <>
        Demande à chaque driver de purger ses répertoires de version sur la cible, au-delà des{' '}
        <Code>keep</Code> plus récents. La tâche ne nomme aucun chemin et ne sait pas sur quel
        runtime elle tourne : c&apos;est le driver qui sait où il dépose ses releases.
      </>
    ),
    payload: (
      <>
        <Code>keep</Code> (1 à 50, défaut 5) ; <Code>applicationIds</Code> /{' '}
        <Code>targetIds</Code>.
      </>
    ),
  },
  preflight: {
    steps: (
      <>
        Balaye les cibles enregistrées et <strong>enfile</strong> un{' '}
        <Code>target:preflight</Code> par cible. Elle ne fait pas le preflight elle-même :
        elle réutilise la tâche existante, pour qu&apos;il n&apos;y ait qu&apos;une
        implémentation et qu&apos;un endroit où un credential est déchiffré.
      </>
    ),
    payload: (
      <>
        <Code>targetIds</Code> pour ne rafraîchir qu&apos;une partie du parc.
      </>
    ),
  },
};

export function JobsHelpDialog({
  label = 'À quoi servent les tâches planifiées ?',
  className,
  defaultTimeZone,
}: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-[3px]',
            className,
          )}
        >
          {label}
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>À quoi servent les tâches planifiées&nbsp;?</DialogTitle>
          <DialogDescription>
            Ce qui doit se répéter sans que personne ne clique. Elles constatent et alertent —
            aucune n&apos;agit sur vos déploiements.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 text-sm">
          <Section title="L’idée directrice">
            <p className="text-muted-foreground">
              Un déploiement est un évènement : on le déclenche, il aboutit, on passe à autre
              chose. Mais une image scannée sans faille il y a trois semaines en a peut-être
              une aujourd&apos;hui, un conteneur en service a pu mourir sans témoin, et les
              répertoires de version s&apos;empilent sur la cible jusqu&apos;à remplir le
              disque. Les tâches planifiées sont ce qui regarde tout cela à intervalle
              régulier.
            </p>
            <p className="text-muted-foreground">
              Règle commune et non négociable :{' '}
              <strong className="text-foreground font-medium">aucune n&apos;agit</strong>. Un
              scan qui remonte une CRITICAL ne bloque rien et ne redéploie rien ; un healthcheck
              en échec ne déclenche aucun rollback. Le panel informe, l&apos;opérateur décide.
              La seule exception est la purge des répertoires de version, explicitement demandée
              et qui ne touche jamais la version courante.
            </p>
          </Section>

          <Section title="Ce que fait chaque type">
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Ce qui se passe</th>
                  <th className="px-3 py-2 font-medium">Paramètres (payload)</th>
                </tr>
              </thead>
              <tbody>
                {SCHEDULED_JOB_TYPES_LIST.map((type) => {
                  const definition = SCHEDULED_JOB_TYPES[type];
                  const detail = WHAT_THEY_DO[type];
                  return (
                    <tr key={type} className="border-t align-top">
                      <td className="px-3 py-2">
                        <div className="text-foreground font-medium whitespace-nowrap">
                          {definition.label}
                        </div>
                        <code className="text-muted-foreground font-mono text-[0.7rem]">
                          {definition.jobName}
                        </code>
                        <div className="text-muted-foreground mt-1 text-[0.7rem]">
                          par défaut&nbsp;: <Code>{definition.defaultCron}</Code>
                        </div>
                      </td>
                      <td className="text-muted-foreground px-3 py-2">
                        {detail.steps}
                        <div className="text-foreground/80 mt-1.5 text-[0.7rem]">
                          {definition.neverDoes}
                        </div>
                      </td>
                      <td className="text-muted-foreground px-3 py-2">{detail.payload}</td>
                    </tr>
                  );
                })}
              </tbody>
            </ScrollableTable>
          </Section>

          <Section title="Quand elles tournent">
            <p className="text-muted-foreground">
              L&apos;ordonnanceur est <strong className="text-foreground font-medium">BullMQ</strong>,
              pas un cron Linux : chaque tâche active est un <em>job scheduler</em> Redis, et
              c&apos;est lui qui calcule la prochaine occurrence. La base reste la source de
              vérité — au démarrage du worker, tout est réconcilié : une tâche active absente de
              Redis y est réinstallée, une tâche désactivée ou supprimée en est retirée. La
              colonne <em>État</em> signale l&apos;écart quand il existe.
            </p>
          </Section>

          <Section title="Le fuseau, réglage de la tâche">
            <p className="text-muted-foreground">
              <strong className="text-foreground font-medium">
                Chaque tâche porte son propre fuseau
              </strong>
              , enregistré à côté de son expression cron et transmis à BullMQ en{' '}
              <Code>{'{ pattern, tz }'}</Code>. Une tâche réglée «&nbsp;à 3&nbsp;h&nbsp;» en{' '}
              <Code>Europe/Paris</Code> tourne bien à 3&nbsp;h à Paris — et l&apos;instant UTC
              correspondant change avec l&apos;heure d&apos;été, ce qui est précisément le but.
              Le fuseau du process qui ordonnance n&apos;entre plus en jeu.
            </p>
            <p className="text-muted-foreground">
              Une tâche neuve part de <Code>{defaultTimeZone}</Code>, le fuseau des paramètres
              d&apos;instance : celui que vous avez déjà déclaré une fois. Le sélecteur du
              formulaire permet d&apos;en choisir un autre, tâche par tâche — utile quand une
              purge doit tomber la nuit d&apos;une machine qui n&apos;est pas dans votre
              fuseau. L&apos;aperçu sous le champ montre l&apos;heure dans le fuseau de la
              tâche, et sur votre horloge quand les deux diffèrent.
            </p>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">
                <strong className="text-foreground font-medium">
                  Les tâches antérieures à ce réglage sont en <Code>UTC</Code>
                </strong>{' '}
                — pas en {defaultTimeZone}. Elles ont été installées quand le motif était passé
                à BullMQ sans option <Code>tz</Code>, donc interprété dans le fuseau du
                process, qui est UTC dans nos conteneurs. Leur appliquer d&apos;office le
                fuseau d&apos;instance aurait déplacé leur exécution de plusieurs heures sans
                que personne ne l&apos;ait demandé. Changez-le explicitement si ce n&apos;est
                pas ce que vous vouliez : la prochaine occurrence est aussitôt recalculée.
              </p>
            </div>
          </Section>

          <Section title="Simple ou expert">
            <p className="text-muted-foreground">
              Le mode simple n&apos;est qu&apos;une aide à la saisie : ce qui est enregistré
              reste une expression cron, la même que celle du mode expert. Il n&apos;y a donc
              rien à choisir une fois pour toutes — une tâche créée en mode simple se relit en
              mode expert, et l&apos;inverse quand l&apos;expression a un équivalent simple.
            </p>
            <p className="text-muted-foreground">
              Certaines expressions n&apos;en ont pas : <Code>*/7 2-5 * * 1,3</Code> mélange un
              pas de 7 minutes, une plage d&apos;heures et une liste de jours. L&apos;écran
              reste alors en mode expert et le dit, plutôt que d&apos;afficher une périodicité
              approchée qui serait fausse. La phrase sous le champ, elle, décrit toujours
              l&apos;expression réelle.
            </p>
          </Section>

          <Section title="Déclencher, désactiver, supprimer">
            <ul className="text-muted-foreground list-disc space-y-1.5 pl-5">
              <li>
                <strong className="text-foreground font-medium">Lancer</strong> enfile une
                occurrence immédiate, marquée <Code>manuel</Code> dans l&apos;historique. Elle
                s&apos;exécute même si la tâche est désactivée — c&apos;est exactement ce
                qu&apos;on veut en réglant une tâche.
              </li>
              <li>
                <strong className="text-foreground font-medium">Désactiver</strong> retire le
                scheduler de Redis mais garde la ligne, son historique et son paramétrage. Une
                occurrence qui arriverait malgré tout est ignorée : le worker relit la base
                avant d&apos;exécuter.
              </li>
              <li>
                <strong className="text-foreground font-medium">Supprimer</strong> retire la
                ligne et le scheduler. L&apos;action est tracée dans les logs,
                comme la création et chaque modification de cadence.
              </li>
            </ul>
          </Section>

          <Section title="Bien choisir la cadence">
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Tâche</th>
                  <th className="px-3 py-2 font-medium">Cadence raisonnable</th>
                  <th className="px-3 py-2 font-medium">Pourquoi</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">Healthcheck</td>
                  <td className="text-muted-foreground px-3 py-2">toutes les 5 à 15 minutes</td>
                  <td className="text-muted-foreground px-3 py-2">
                    Chaque occurrence ouvre une session SSH par déploiement. Toutes les minutes,
                    on épuise <Code>MaxStartups</Code> sur la cible pour n&apos;apprendre rien de
                    plus.
                  </td>
                </tr>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">Scan périodique</td>
                  <td className="text-muted-foreground px-3 py-2">une fois par nuit</td>
                  <td className="text-muted-foreground px-3 py-2">
                    Les bases de vulnérabilités sont mises à jour au mieux quotidiennement.
                    Scanner plus souvent coûte du CPU sur la cible pour le même rapport.
                  </td>
                </tr>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">Purge des versions</td>
                  <td className="text-muted-foreground px-3 py-2">une fois par nuit</td>
                  <td className="text-muted-foreground px-3 py-2">
                    Décalée du scan, pour ne pas faire tourner les deux en même temps sur la
                    même machine.
                  </td>
                </tr>
                <tr className="border-t align-top">
                  <td className="px-3 py-2 whitespace-nowrap">Rafraîchissement des cibles</td>
                  <td className="text-muted-foreground px-3 py-2">toutes les heures</td>
                  <td className="text-muted-foreground px-3 py-2">
                    Une cible ne change pas de runtime quatre fois par heure. L&apos;heure suffit
                    à repérer une machine devenue injoignable.
                  </td>
                </tr>
              </tbody>
            </ScrollableTable>
          </Section>

          <Section title="La syntaxe cron, pour le mode expert">
            <pre className="bg-muted/50 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
              <code>{CRON_CHEATSHEET}</code>
            </pre>
            <p className="text-muted-foreground text-xs">
              Un sixième champ, placé <em>devant</em>, désigne les secondes. Il est accepté mais
              rarement utile : une tâche qui a besoin de la seconde près n&apos;est pas une
              tâche planifiée.
            </p>
          </Section>
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              Fermer
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CRON_CHEATSHEET = `┌─ minute        0-59
│ ┌─ heure       0-23
│ │ ┌─ jour      1-31   (du mois)
│ │ │ ┌─ mois    1-12   ou jan-dec
│ │ │ │ ┌─ jour  0-7    (de la semaine, 0 et 7 = dimanche) ou sun-sat
│ │ │ │ │
* * * * *

*        toute valeur              │  */15    un pas : 0, 15, 30, 45
5        une valeur                │  2-5     une plage : 2, 3, 4, 5
1,3,5    une liste                 │  2-8/2   une plage avec un pas : 2, 4, 6, 8

*/15 * * * *     toutes les 15 minutes
0 * * * *        toutes les heures, à l'heure pile
30 3 * * *       tous les jours à 03:30
0 4 * * 1        tous les lundis à 04:00
0 4 * * 1-5      du lundi au vendredi à 04:00     (pas d'équivalent simple)
0 2 1 * *        le 1er de chaque mois à 02:00

Attention : jour du mois ET jour de semaine renseignés se combinent en OU.
« 0 3 1 * 1 » tourne le 1er du mois *et* tous les lundis.`;
