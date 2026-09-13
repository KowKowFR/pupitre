'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronLeft, Minus, SkipForward } from 'lucide-react';
import type {
  AppSettings,
  DateStyleName,
  OnboardingPresentedStep,
  OnboardingState,
  OnboardingStepId,
  RoleKey,
  SupportedLocale,
} from '@pupitre/core';
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
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { onboarding } from '@/i18n/messages/onboarding';
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
  /**
   * L'instance sait-elle envoyer un e-mail ? Sur une instance neuve — le cas
   * de figure de cet assistant — la réponse est presque toujours « non », et
   * l'étape propose alors un mot de passe. Le drapeau est tout de même
   * transmis : quelqu'un qui a configuré le SMTP avant d'arriver ici doit
   * pouvoir inviter, comme partout ailleurs.
   */
  canInvite: boolean;
};

type PatchResponse = { state: OnboardingState; steps: OnboardingPresentedStep[] };
type ApiError = { error?: { message?: string } };

/**
 * Les quatre étapes qui portent un prix — exactement celles que `optional`
 * autorise à passer.
 *
 * Une table de clés littérales plutôt qu'un `` `step.${id}.cost` `` construit à
 * la volée : le compilateur refuse alors `step.welcome.cost`, qui n'existe pas
 * et ne doit pas exister. C'est la garde qui remplace l'ancien `cost: null`.
 */
const COST_KEYS = {
  target: 'step.target.cost',
  role: 'step.role.cost',
  user: 'step.user.cost',
  security: 'step.security.cost',
} as const;

const RICH_PART = /\{(\w+)\}/g;

/**
 * Rend une phrase dont quelques fragments sont des nœuds — un mot en gras, un
 * lien, un identifiant en chasse fixe.
 *
 * Le dictionnaire garde la phrase **entière**, avec un `{nom}` là où le nœud
 * s'insère. La couper en trois clés aurait laissé au traducteur des bouts sans
 * contexte et figé l'ordre des mots : l'anglais déplace la mise en avant.
 * `t()` laisse intacts les `{nom}` qu'on ne lui passe pas en variables, ce qui
 * suffit à les retrouver ici.
 */
function rich(sentence: string, parts: Readonly<Record<string, ReactNode>>): ReactNode {
  return sentence
    .split(RICH_PART)
    .map((chunk, position) => (
      <Fragment key={position}>{position % 2 === 1 ? parts[chunk] : chunk}</Fragment>
    ));
}

export function OnboardingWizard(props: Props) {
  const t = useT(onboarding);
  const tc = useT(common);
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
      setError(payload.error?.message ?? tc('http.failure', { status: response.status }));
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

  const costKey = current ? COST_KEYS[current.id as keyof typeof COST_KEYS] : undefined;
  const currentCost = costKey ? t(costKey) : null;

  const previous = index > 0 ? steps[index - 1] : null;
  /** Ce qu'on laisse derrière soi — nommé, pas compté. */
  const remaining = actionable.filter((step) => step.outcome === 'todo');
  const noTarget = props.environment.targets === 0;

  return (
    <>
      <PageHeader
        eyebrow={t('page.eyebrow')}
        title={t('page.title')}
        description={t('page.description')}
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
              {t('action.later')}
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
                  <CardTitle>{t(`step.${current.id}.title`)}</CardTitle>
                  {current.optional ? (
                    <Badge variant="secondary">{t('badge.optional')}</Badge>
                  ) : null}
                  {current.outcome === 'done' ? (
                    <Badge variant="ok">{t('badge.done')}</Badge>
                  ) : null}
                  {current.outcome === 'skipped' ? (
                    <Badge variant="warn">{t('badge.skipped')}</Badge>
                  ) : null}
                </div>
                <CardDescription>{t(`step.${current.id}.summary`)}</CardDescription>
              </CardHeader>

              <CardContent className="pb-0">
                <p className="text-ink-muted border-line border-l-2 pl-3 text-sm leading-relaxed">
                  {t(`step.${current.id}.detail`)}
                </p>
                {currentCost ? (
                  <p className="text-ink-faint pt-3 pl-3 text-xs leading-relaxed">
                    <span className="text-ink">{t('cost.inlineLead')}</span>
                    {currentCost}
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
                    canInvite={props.canInvite}
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

          {currentCost ? (
            <Alert variant="warn">
              <span className="block font-medium text-ink">{t('cost.alertTitle')}</span>
              <span className="block text-ink-muted">{currentCost}</span>
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
                {t(`step.${previous.id}.title`)}
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
                  {t('action.skipStep')}
                </Button>
              ) : null}

              {currentId === 'welcome' ? (
                <Button size="sm" disabled={busy} onClick={() => goto(steps[1]?.id ?? 'summary')}>
                  {t('action.start')}
                  <ArrowRight />
                </Button>
              ) : null}

              {currentId === 'summary' ? (
                <Button size="sm" disabled={busy} onClick={() => void leave('finish')}>
                  <Check />
                  {t('action.finish')}
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
            <DialogTitle>{t('leave.title')}</DialogTitle>
            <DialogDescription>
              {t('leave.progress', { count: doneCount, total: actionable.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            <p className="text-ink-muted leading-relaxed">{t('leave.body')}</p>
            {remaining.length > 0 ? (
              <div className="border-line rounded-md border p-3">
                <span className="text-ink text-xs">{t('leave.remaining')}</span>
                <ul className="text-ink-muted mt-1.5 flex flex-col gap-1 text-xs">
                  {remaining.map((step) => (
                    <li key={step.id}>· {t(`step.${step.id}.title`)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {noTarget ? <Alert variant="warn">{t('leave.noTarget')}</Alert> : null}
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              {t('leave.stay')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={confirmAbandon}>
              {t('leave.confirm')}
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
            <DialogTitle>
              {t('skip.title', { step: current ? t(`step.${current.id}.title`) : '' })}
            </DialogTitle>
            <DialogDescription>
              {current ? t(`step.${current.id}.summary`) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3 text-sm">
            {currentCost ? <p className="text-ink-muted leading-relaxed">{currentCost}</p> : null}
            <p className="text-ink-faint text-xs leading-relaxed">{t('skip.note')}</p>
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              {t('skip.back')}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={confirmSkip}>
              {t('action.skipStep')}
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
  const t = useT(onboarding);

  return (
    <nav
      aria-label={t('stepper.label')}
      className="flex flex-col gap-1 lg:sticky lg:top-6 lg:self-start"
    >
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
            <span className="min-w-0 truncate">{t(`step.${step.id}.title`)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Welcome() {
  const t = useT(onboarding);

  return (
    <div className="flex flex-col gap-4 text-[0.8125rem] leading-relaxed text-ink-muted">
      <p>
        {rich(t('welcome.p1'), {
          controlPlane: <strong className="text-ink">{t('welcome.p1.controlPlane')}</strong>,
          your: <em>{t('welcome.p1.your')}</em>,
        })}
      </p>
      <p>
        {rich(t('welcome.p2'), {
          keepRunning: <strong className="text-ink">{t('welcome.p2.keepRunning')}</strong>,
        })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
          <div className="eyebrow text-ink-faint">{t('welcome.does.title')}</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs">
            <li>{t('welcome.does.ssh')}</li>
            <li>{t('welcome.does.render')}</li>
            <li>{t('welcome.does.scan')}</li>
          </ul>
        </div>
        <div className="rounded-md border border-line bg-surface-2 px-3.5 py-3">
          <div className="eyebrow text-ink-faint">{t('welcome.doesNot.title')}</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs">
            <li>{t('welcome.doesNot.run')}</li>
            <li>{t('welcome.doesNot.install')}</li>
            <li>{t('welcome.doesNot.firewall')}</li>
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
  const t = useT(onboarding);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const preflight = usePreflight({ onError: setError });

  async function afterCreate(target: { id: string; name: string }) {
    if (!canRunPreflight) {
      setPhase(t('target.noPreflight', { name: target.name }));
      onDone();
      return;
    }
    setPhase(t('target.running', { name: target.name }));
    // Exactement le même enchaînement que le bouton « Tester la connexion » de
    // la liste des cibles : POST /api/targets/{id}/preflight, puis suivi de la
    // tâche BullMQ. Aucune session SSH n'est ouverte depuis une route HTTP.
    await preflight.run(target.id);
    setPhase(t('target.tested', { name: target.name }));
    onDone();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">{t('target.intro')}</p>

      <div>
        <TargetHelpDialog label={t('target.help')} />
      </div>

      {existing !== null && existing > 0 ? (
        <Alert variant="info" className="flex flex-wrap items-center gap-3">
          {/*
            `count` choisit la forme, `{n}` porte le nombre en gras. Deux noms
            pour une seule valeur : l'un est substitué par `t()`, l'autre reste
            en place pour que `rich()` y pose le nœud.
          */}
          <span className="min-w-0 flex-1">
            {rich(t('target.existing', { count: existing }), {
              n: <strong>{existing}</strong>,
            })}
          </span>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onDone}>
            {t('target.haveOne')}
          </Button>
        </Alert>
      ) : null}

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {phase ? <Alert variant="success">{phase}</Alert> : null}

      <TargetForm
        onCreated={(target) => void afterCreate(target)}
        onCancel={null}
        submitLabel={t('target.submit')}
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
  const t = useT(onboarding);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
        {rich(t('role.intro'), {
          admin: <code className="font-mono text-xs">admin</code>,
          operator: <code className="font-mono text-xs">operator</code>,
          viewer: <code className="font-mono text-xs">viewer</code>,
          noPermission: (
            <strong className="text-ink">{t('role.intro.noPermission')}</strong>
          ),
          rolesLink: (
            <Link href="/admin/roles" className="text-signal underline underline-offset-4">
              {t('role.intro.link')}
            </Link>
          ),
        })}
      </p>
      <CreateRoleForm existingKeys={[...roleKeys]} onCreated={onCreated} />
    </div>
  );
}

function UserStep({
  roleKeys,
  existing,
  canInvite,
  onCreated,
}: {
  roleKeys: RoleKey[];
  existing: number | null;
  canInvite: boolean;
  onCreated: () => void;
}) {
  const t = useT(onboarding);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
        {t('user.intro')}
        {existing !== null ? ` ${t('user.existing', { count: existing })}` : ''}
      </p>
      <CreateUserForm roles={roleKeys} canInvite={canInvite} onCreated={onCreated} />
    </div>
  );
}

function Summary({ steps, state }: { steps: OnboardingPresentedStep[]; state: OnboardingState }) {
  const t = useT(onboarding);

  const outcomeLabel: Record<OnboardingPresentedStep['outcome'], string> = {
    done: t('outcome.done'),
    skipped: t('outcome.skipped'),
    todo: t('outcome.todo'),
  };

  const links: Partial<Record<OnboardingStepId, { href: string; label: string }>> = {
    identity: { href: '/admin/settings', label: t('link.settings') },
    target: { href: '/targets', label: t('link.targets') },
    role: { href: '/admin/roles', label: t('link.roles') },
    user: { href: '/admin/users', label: t('link.users') },
    security: { href: '/admin/settings', label: t('link.settings') },
  };

  const actionable = steps.filter((step) => step.requires !== null);
  const skipped = actionable.filter((step) => step.outcome === 'skipped');

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full min-w-0 border-collapse text-left text-[0.8125rem]">
          <tbody>
            {actionable.map((step) => {
              const link = links[step.id];
              return (
              <tr key={step.id} className="border-b border-line last:border-b-0">
                <td className="px-3 py-2 font-medium text-ink">
                  {t(`step.${step.id}.title`)}
                </td>
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
                    {outcomeLabel[step.outcome]}
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
          {rich(
            t('summary.skipped', {
              count: skipped.length,
              list: skipped.map((step) => t(`step.${step.id}.title`)).join(', '),
            }),
            {
              settings: (
                <Link href="/admin/settings" className="text-signal underline underline-offset-4">
                  {t('summary.skipped.settings')}
                </Link>
              ),
            },
          )}
        </Alert>
      ) : null}

      <p className="text-xs text-ink-faint">
        {t('summary.finishNote')}
        {state.runs > 0 ? ` ${t('summary.run', { n: state.runs + 1 })}` : ''}
      </p>
    </div>
  );
}
