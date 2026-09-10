'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, Check, ChevronLeft, Minus, SkipForward } from 'lucide-react';
import type {
  AppSettings,
  DateStyleName,
  OnboardingPresentedStep,
  OnboardingState,
  OnboardingStepId,
  RoleKey,
  SupportedLocale,
} from '@tp/core';
import { PageHeader } from '@/components/page-header';
import { TargetHelpDialog } from '@/components/target-help';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { CreateRoleForm } from '@/app/(app)/admin/roles/create-role-form';
import { CreateUserForm } from '@/app/(app)/admin/users/create-user-form';
import { TargetForm } from '@/app/(app)/targets/target-form';
import { usePreflight } from '@/app/(app)/targets/use-preflight';
import { IdentityStep, SecurityStep } from './settings-steps';

/**
 * Assistant de démarrage — la coquille.
 *
 * Règle qui gouverne tout ce fichier : **il ne crée rien lui-même**. Chaque
 * étape monte le formulaire de l'écran normal (`TargetForm`, `CreateRoleForm`,
 * `CreateUserForm`) ou appelle la route que cet écran appelle déjà
 * (`PATCH /api/settings`). Un formulaire « en plus simple » recopié ici aurait
 * commencé à diverger de l'original au premier champ ajouté, et sa validation,
 * son audit et son preflight avec lui.
 *
 * Seul l'avancement passe par une route propre — `PATCH /api/onboarding` —
 * parce que se souvenir d'où l'on en est n'est le métier d'aucune des autres.
 */

/** Miroir client de `OnboardingEnvironment`, sans importer le module serveur. */
export type OnboardingEnvironmentView = {
  targets: number | null;
  applications: number | null;
  roles: number | null;
  users: number | null;
  aiApiKeyConfigured: boolean | null;
};

type Props = {
  state: OnboardingState;
  steps: OnboardingPresentedStep[];
  environment: OnboardingEnvironmentView;
  settings: AppSettings;
  aiApiKeyConfigured: boolean;
  aiApiKeyLast4: string | null;
  timezones: string[];
  locales: SupportedLocale[];
  dateStyles: DateStyleName[];
  roleKeys: RoleKey[];
  canRunPreflight: boolean;
};

type PatchResponse = { state: OnboardingState; steps: OnboardingPresentedStep[] };
type ApiError = { error?: { message?: string } };

const OUTCOME_BADGE: Record<OnboardingPresentedStep['outcome'], string> = {
  done: 'faite',
  skipped: 'passée',
  todo: 'à faire',
};

export function OnboardingWizard(props: Props) {
  const router = useRouter();

  const [state, setState] = useState(props.state);
  const [steps, setSteps] = useState(props.steps);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * L'étape mémorisée est celle de l'*instance*, pas de la personne : si un
   * administrateur s'est arrêté sur « un rôle » et qu'un opérateur reprend, on
   * retombe sur la première étape qui le concerne plutôt que sur un écran vide.
   */
  const fallback = steps[0]?.id ?? 'welcome';
  const currentId: OnboardingStepId = steps.some((step) => step.id === state.currentStep)
    ? state.currentStep
    : fallback;
  const current = steps.find((step) => step.id === currentId) ?? steps[0];
  const index = steps.findIndex((step) => step.id === currentId);

  const actionable = steps.filter((step) => step.requires !== null);
  const doneCount = actionable.filter((step) => step.outcome === 'done').length;

  async function send(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);

    const response = await fetch('/api/onboarding', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ApiError;
      setError(payload.error?.message ?? `Échec (HTTP ${response.status})`);
      setBusy(false);
      return false;
    }

    const data = (await response.json()) as PatchResponse;
    setState(data.state);
    setSteps(data.steps);
    setBusy(false);
    return true;
  }

  /**
   * Deux gestes seulement peuvent écourter le parcours, et tous deux passent
   * par une confirmation qui nomme la conséquence. Un bouton qu'on presse par
   * réflexe n'est pas un choix : une installation à moitié configurée qu'on
   * redécouvre trois semaines plus tard coûte plus cher que le temps de lire
   * deux phrases.
   */
  const [confirming, setConfirming] = useState<'abandon' | 'skip' | null>(null);

  async function leave(action: 'finish' | 'dismiss') {
    if (!(await send({ action }))) return;
    // Le bandeau de reprise vit dans le layout serveur : il faut le refaire
    // rendre pour qu'il disparaisse, sans quoi il resterait à l'écran.
    router.push('/');
    router.refresh();
  }

  function goto(step: OnboardingStepId) {
    void send({ action: 'goto', step });
  }

  function complete(step: OnboardingStepId) {
    void send({ action: 'complete', step });
  }

  function skip(step: OnboardingStepId) {
    void send({ action: 'skip', step });
  }

  function confirmAbandon() {
    setConfirming(null);
    void leave('dismiss');
  }

  function confirmSkip() {
    setConfirming(null);
    skip(currentId);
  }

  const previous = index > 0 ? steps[index - 1] : null;
  /** Ce qu'on laisse derrière soi — nommé, pas compté. */
  const remaining = actionable.filter((step) => step.outcome === 'todo');
  const noTarget = props.environment.targets === 0;

  return (
    <>
      <PageHeader
        eyebrow="Prise en main"
        title="Assistant de démarrage"
        description="Six écrans pour rendre ce panel utilisable : le nommer, lui donner une machine, décider qui y accède. Chaque étape appelle exactement la même API que l'écran correspondant — rien de ce que vous faites ici n'est un raccourci."
        actions={
          <>
            <span className="font-mono text-xs text-ink-faint tabular-nums">
              {doneCount}/{actionable.length}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming('abandon')}
            >
              Plus tard
            </Button>
          </>
        }
      />

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <Stepper steps={steps} currentId={currentId} busy={busy} onSelect={goto} />

        <div className="flex min-w-0 flex-col gap-4">
          {current ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{current.title}</CardTitle>
                  {current.optional ? <Badge variant="secondary">facultative</Badge> : null}
                  {current.outcome === 'done' ? <Badge variant="ok">déjà faite</Badge> : null}
                  {current.outcome === 'skipped' ? <Badge variant="warn">passée</Badge> : null}
                </div>
                <CardDescription>{current.summary}</CardDescription>
              </CardHeader>

              <CardContent className="pb-0">
                <p className="text-ink-muted border-line border-l-2 pl-3 text-sm leading-relaxed">
                  {current.detail}
                </p>
                {current.optional && current.cost ? (
                  <p className="text-ink-faint pt-3 pl-3 text-xs leading-relaxed">
                    <span className="text-ink">Si vous la passez : </span>
                    {current.cost}
                  </p>
                ) : null}
              </CardContent>

              <CardContent className="flex flex-col gap-4">
                {currentId === 'welcome' ? <Welcome /> : null}

                {currentId === 'identity' ? (
                  <IdentityStep
                    settings={props.settings}
                    timezones={props.timezones}
                    locales={props.locales}
                    dateStyles={props.dateStyles}
                    disabled={busy}
                    onSaved={() => complete('identity')}
                  />
                ) : null}

                {currentId === 'target' ? (
                  <TargetStep
                    existing={props.environment.targets}
                    canRunPreflight={props.canRunPreflight}
                    disabled={busy}
                    onDone={() => complete('target')}
                  />
                ) : null}

                {currentId === 'role' ? (
                  <RoleStep roleKeys={props.roleKeys} onCreated={() => complete('role')} />
                ) : null}

                {currentId === 'user' ? (
                  <UserStep
                    roleKeys={props.roleKeys}
                    existing={props.environment.users}
                    onCreated={() => complete('user')}
                  />
                ) : null}

                {currentId === 'security' ? (
                  <SecurityStep
                    settings={props.settings}
                    aiApiKeyConfigured={props.aiApiKeyConfigured}
                    aiApiKeyLast4={props.aiApiKeyLast4}
                    disabled={busy}
                    onSaved={() => complete('security')}
                  />
                ) : null}

                {currentId === 'summary' ? <Summary steps={steps} state={state} /> : null}
              </CardContent>
            </Card>
          ) : null}

          {current?.optional && current.cost ? (
            <Alert variant="warn">
              <span className="block font-medium text-ink">Si vous passez cette étape</span>
              <span className="block text-ink-muted">{current.cost}</span>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {previous ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => goto(previous.id)}
              >
                <ChevronLeft />
                {previous.title}
              </Button>
            ) : null}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {current?.optional ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirming('skip')}
                >
                  <SkipForward />
                  Passer cette étape
                </Button>
              ) : null}

              {currentId === 'welcome' ? (
                <Button size="sm" disabled={busy} onClick={() => goto(steps[1]?.id ?? 'summary')}>
                  Commencer
                  <ArrowRight />
                </Button>
              ) : null}

              {currentId === 'summary' ? (
                <Button size="sm" disabled={busy} onClick={() => void leave('finish')}>
                  <Check />
                  Terminer
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={confirming === 'abandon'}
        onOpenChange={(open) => setConfirming(open ? 'abandon' : null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quitter l&apos;assistant sans l&apos;avoir terminé ?</DialogTitle>
            <DialogDescription>
              Vous avez traité {doneCount} étape{doneCount > 1 ? 's' : ''} sur{' '}
              {actionable.length}.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            <p className="text-ink-muted leading-relaxed">
              Le panel restera utilisable, mais dans l&apos;état où vous le laissez. Les étapes
              non traitées correspondent chacune à un écran : vous pourrez les faire à la main,
              ou relancer cet assistant depuis les paramètres.
            </p>
            {remaining.length > 0 ? (
              <div className="border-line rounded-md border p-3">
                <span className="text-ink text-xs">Il reste à faire :</span>
                <ul className="text-ink-muted mt-1.5 flex flex-col gap-1 text-xs">
                  {remaining.map((step) => (
                    <li key={step.id}>· {step.title}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {noTarget ? (
              <Alert variant="warn">
                Aucune cible n&apos;est déclarée. Tant qu&apos;il n&apos;en existe pas une, le
                panel ne peut rien déployer : les écrans d&apos;application et de déploiement
                resteront vides.
              </Alert>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Continuer l&apos;assistant
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={confirmAbandon}>
              Quitter quand même
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming === 'skip'}
        onOpenChange={(open) => setConfirming(open ? 'skip' : null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Passer «&nbsp;{current?.title}&nbsp;» ?</DialogTitle>
            <DialogDescription>{current?.summary}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            {current?.cost ? (
              <p className="text-ink-muted leading-relaxed">{current.cost}</p>
            ) : null}
            <p className="text-ink-faint text-xs leading-relaxed">
              Vous restez dans l&apos;assistant : seule cette étape est marquée comme passée, et
              elle se refait plus tard depuis l&apos;écran correspondant.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Revenir à l&apos;étape
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={confirmSkip}>
              Passer cette étape
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}

/* -------------------------------------------------------------------------- */

function Stepper({
  steps,
  currentId,
  busy,
  onSelect,
}: {
  steps: OnboardingPresentedStep[];
  currentId: OnboardingStepId;
  busy: boolean;
  onSelect: (step: OnboardingStepId) => void;
}) {
  return (
    <nav aria-label="Étapes" className="flex flex-col gap-1 lg:sticky lg:top-6 lg:self-start">
      {steps.map((step, position) => {
        const active = step.id === currentId;
        return (
          <button
            key={step.id}
            type="button"
            disabled={busy}
            onClick={() => onSelect(step.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[0.8125rem]',
              'transition-colors duration-100 ease-out disabled:opacity-60',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              active ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:bg-surface-2/60 hover:text-ink',
            )}
            aria-current={active ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-full border text-[0.6875rem] tabular-nums',
                step.outcome === 'done'
                  ? 'border-ok-edge bg-ok-soft text-ok'
                  : step.outcome === 'skipped'
                    ? 'border-warn-edge bg-warn-soft text-warn'
                    : active
                      ? 'border-signal bg-signal text-signal-ink'
                      : 'border-line text-ink-faint',
              )}
            >
              {step.outcome === 'done' ? (
                <Check className="size-3" />
              ) : step.outcome === 'skipped' ? (
                <Minus className="size-3" />
              ) : (
                position + 1
              )}
            </span>
            <span className="min-w-0 truncate">{step.title}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Welcome() {
  return (
    <div className="flex flex-col gap-4 text-[0.8125rem] leading-relaxed text-ink-muted">
      <p>
        Ce panel est un <strong className="text-ink">plan de contrôle</strong>. Il décide, trace,
        chiffre et ordonnance ; il n&apos;héberge rien. Vos applications tournent sur{' '}
        <em>vos</em> machines, jointes en SSH — leurs images sont même construites là-bas, il n&apos;y
        a pas de registry entre les deux.
      </p>
      <p>
        Conséquence directe, et c&apos;est la seule chose à retenir de cet écran :{' '}
        <strong className="text-ink">
          si le panel s&apos;arrête, vos applications continuent de tourner
        </strong>
        . Vous perdez la capacité de déployer et de superviser, pas le service rendu.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
          <div className="eyebrow text-ink-faint">Ce qu&apos;il fait</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs">
            <li>Ouvre des sessions SSH vers vos machines</li>
            <li>Rend une AppSpec en Docker Compose ou en manifests K3s</li>
            <li>Analyse les images, journalise qui a fait quoi</li>
          </ul>
        </div>
        <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
          <div className="eyebrow text-ink-faint">Ce qu&apos;il ne fait pas</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs">
            <li>Exécuter vos applications</li>
            <li>Installer Docker ou K3s sur une cible</li>
            <li>Activer un pare-feu à votre place</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function TargetStep({
  existing,
  canRunPreflight,
  disabled,
  onDone,
}: {
  existing: number | null;
  canRunPreflight: boolean;
  disabled: boolean;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const preflight = usePreflight({ onError: setError });

  async function afterCreate(target: { id: string; name: string }) {
    if (!canRunPreflight) {
      setPhase(`« ${target.name} » déclarée. Preflight non lancé : permission target:update requise.`);
      onDone();
      return;
    }
    setPhase(`« ${target.name} » déclarée — preflight en cours…`);
    // Exactement le même enchaînement que le bouton « Tester la connexion » de
    // la liste des cibles : POST /api/targets/{id}/preflight, puis suivi de la
    // tâche BullMQ. Aucune session SSH n'est ouverte depuis une route HTTP.
    await preflight.run(target.id);
    setPhase(`« ${target.name} » déclarée et testée.`);
    onDone();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
        Déclarer une cible n&apos;installe rien : cela n&apos;écrit qu&apos;une ligne en base et un
        credential chiffré. La machine n&apos;est touchée qu&apos;au preflight, lancé
        automatiquement juste après — il découvre ce qui y est exécutable, Docker, K3s, ou ni
        l&apos;un ni l&apos;autre.
      </p>

      <div>
        <TargetHelpDialog label="Qu’est-ce qu’une cible, et que faut-il préparer sur la machine ?" />
      </div>

      {existing !== null && existing > 0 ? (
        <Alert variant="info" className="flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">
            Ce panel connaît déjà <strong>{existing}</strong> cible{existing > 1 ? 's' : ''}. Vous
            pouvez en déclarer une de plus, ou considérer l&apos;étape faite.
          </span>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onDone}>
            J&apos;en ai déjà une
          </Button>
        </Alert>
      ) : null}

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {phase ? <Alert variant="success">{phase}</Alert> : null}

      <TargetForm
        onCreated={(target) => void afterCreate(target)}
        onCancel={null}
        submitLabel="Déclarer et tester"
      />
    </div>
  );
}

function RoleStep({
  roleKeys,
  onCreated,
}: {
  roleKeys: RoleKey[];
  onCreated: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
        Un utilisateur porte un rôle ; le rôle porte les permissions. Trois rôles sont déjà
        installés — <code className="font-mono text-xs">admin</code>,{' '}
        <code className="font-mono text-xs">operator</code>,{' '}
        <code className="font-mono text-xs">viewer</code>. Un rôle naît{' '}
        <strong className="text-ink">sans aucune permission</strong> : on les coche ensuite, une par
        une, depuis{' '}
        <Link href="/admin/roles" className="text-signal underline underline-offset-4">
          Rôles
        </Link>
        .
      </p>
      <CreateRoleForm existingKeys={[...roleKeys]} onCreated={onCreated} />
    </div>
  );
}

function UserStep({
  roleKeys,
  existing,
  onCreated,
}: {
  roleKeys: RoleKey[];
  existing: number | null;
  onCreated: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
        Chaque geste du panel est journalisé avec son auteur. Un compte par personne n&apos;est pas
        une formalité : c&apos;est ce qui rend le journal d&apos;audit lisible.
        {existing !== null ? ` Ce panel compte déjà ${existing} compte${existing > 1 ? 's' : ''}.` : ''}
      </p>
      <CreateUserForm roles={roleKeys} onCreated={onCreated} />
    </div>
  );
}

function Summary({ steps, state }: { steps: OnboardingPresentedStep[]; state: OnboardingState }) {
  const links: Partial<Record<OnboardingStepId, { href: string; label: string }>> = {
    identity: { href: '/admin/settings', label: 'Paramètres' },
    target: { href: '/targets', label: 'Cibles' },
    role: { href: '/admin/roles', label: 'Rôles' },
    user: { href: '/admin/users', label: 'Utilisateurs' },
    security: { href: '/admin/settings', label: 'Paramètres' },
  };

  const actionable = steps.filter((step) => step.requires !== null);
  const skipped = actionable.filter((step) => step.outcome === 'skipped');

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-[28rem] border-collapse text-left text-[0.8125rem]">
          <tbody>
            {actionable.map((step) => {
              const link = links[step.id];
              return (
              <tr key={step.id} className="border-b border-line last:border-b-0">
                <td className="px-3 py-2 font-medium text-ink">{step.title}</td>
                <td className="px-3 py-2">
                  <Badge
                    variant={
                      step.outcome === 'done'
                        ? 'ok'
                        : step.outcome === 'skipped'
                          ? 'warn'
                          : 'secondary'
                    }
                  >
                    {OUTCOME_BADGE[step.outcome]}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  {link ? (
                    <Link href={link.href} className="text-signal underline underline-offset-4">
                      {link.label}
                    </Link>
                  ) : null}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {skipped.length > 0 ? (
        <Alert variant="warn">
          {skipped.length} étape{skipped.length > 1 ? 's' : ''} passée
          {skipped.length > 1 ? 's' : ''} :{' '}
          {skipped.map((step) => step.title).join(', ')}. Rien n&apos;est perdu — chacune se refait
          depuis l&apos;écran correspondant, et l&apos;assistant se relance depuis{' '}
          <Link href="/admin/settings" className="text-signal underline underline-offset-4">
            les paramètres
          </Link>
          .
        </Alert>
      ) : null}

      <p className="text-xs text-ink-faint">
        Terminer marque le parcours comme accompli : le bandeau de reprise disparaît et
        l&apos;assistant ne se proposera plus de lui-même.
        {state.runs > 0 ? ` C'est le passage n° ${state.runs + 1}.` : ''}
      </p>
    </div>
  );
}
