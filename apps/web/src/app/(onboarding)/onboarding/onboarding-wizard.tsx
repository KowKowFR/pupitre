'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronLeft, LogOut, Minus, SkipForward } from 'lucide-react';
import type {
  AppSettings,
  DateStyleName,
  OnboardingPresentedStep,
  OnboardingState,
  OnboardingStepId,
  RoleKey,
  SupportedLocale,
} from '@pupitre/core';
import { Led } from '@/components/instrument';
import { PageHeader } from '@/components/page-header';
import { TargetHelpDialog } from '@/components/target-help';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { onboarding } from '@/i18n/messages/onboarding';
import { cn } from '@/lib/utils';
import { CreateRoleForm } from '@/app/(app)/admin/roles/create-role-form';
import { CreateUserForm } from '@/app/(app)/admin/users/create-user-form';
import { TargetForm } from '@/app/(app)/targets/target-form';
import { usePreflight } from '@/app/(app)/targets/use-preflight';
import { OnboardingTopbar } from '../onboarding-topbar';
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
  instanceName: string;
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
      <OnboardingTopbar instanceName={props.instanceName} eyebrow={t('shell.eyebrow')}>
        <span
          className="mono t-cap text-text-3"
          aria-label={t('progress.label', { done: doneCount, total: actionable.length })}
        >
          {index + 1} / {steps.length}
        </span>
        <Button variant="ghost" disabled={busy} onClick={() => setConfirming('abandon')}>
          {t('action.later')}
        </Button>
      </OnboardingTopbar>

      <main className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-6 py-9">
        <PageHeader title={t('page.title')} description={t('page.description')} />

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <div className="grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Stepper steps={steps} currentId={currentId} busy={busy} onSelect={goto} />

          {current ? (
            <section className="card min-w-0 overflow-hidden">
              <div className="card-h flex-col !items-start gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <h2 className="!text-[18px] !leading-6">{t(`step.${current.id}.title`)}</h2>
                  {current.optional ? <Badge>{t('badge.optional')}</Badge> : null}
                  {current.outcome === 'done' ? (
                    <Badge variant="ok">{t('badge.done')}</Badge>
                  ) : null}
                  {current.outcome === 'skipped' ? (
                    <Badge variant="warn">{t('badge.skipped')}</Badge>
                  ) : null}
                </span>
                <span className="sub">{t(`step.${current.id}.summary`)}</span>
              </div>

              <div className="card-b flex flex-col gap-4">
                <p className="t-sm border-l-2 border-border pl-3 text-text-2">
                  {t(`step.${current.id}.detail`)}
                </p>
                {currentCost ? (
                  <p className="t-cap text-text-3">
                    <span className="text-text-2">{t('cost.inlineLead')}</span>
                    {currentCost}
                  </p>
                ) : null}

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
              </div>

              <div className="card-f flex flex-wrap items-center gap-2">
                {previous ? (
                  <Button variant="ghost" disabled={busy} onClick={() => goto(previous.id)}>
                    <ChevronLeft aria-hidden />
                    {t(`step.${previous.id}.title`)}
                  </Button>
                ) : null}

                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {current.optional ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setConfirming('skip')}
                    >
                      {t('action.skipStep')}
                    </Button>
                  ) : null}

                  {currentId === 'welcome' ? (
                    <Button disabled={busy} onClick={() => goto(steps[1]?.id ?? 'summary')}>
                      {t('action.start')}
                      <ArrowRight aria-hidden />
                    </Button>
                  ) : null}

                  {currentId === 'summary' ? (
                    <Button loading={busy} onClick={() => void leave('finish')}>
                      {busy ? null : <Check aria-hidden />}
                      {t('action.finish')}
                    </Button>
                  ) : null}
                </span>
              </div>
            </section>
          ) : null}
        </div>
      </main>

      <Dialog
        open={confirming === 'abandon'}
        onOpenChange={(open) => setConfirming(open ? 'abandon' : null)}
      >
        <DialogContent>
          <DialogHeader icon={<LogOut />} tone="warn">
            <DialogTitle>{t('leave.title')}</DialogTitle>
            <DialogDescription>
              {t('leave.progress', { count: doneCount, total: actionable.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p>{t('leave.body')}</p>
            {remaining.length > 0 ? (
              <div className="well flex flex-col gap-1.5">
                <span className="t-cap font-medium text-text-2">{t('leave.remaining')}</span>
                <ul className="bul flex flex-col gap-1">
                  {remaining.map((step) => (
                    <li key={step.id}>{t(`step.${step.id}.title`)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {noTarget ? <Alert variant="warn">{t('leave.noTarget')}</Alert> : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('leave.stay')}
            </Button>
            <Button variant="secondary" loading={busy} onClick={confirmAbandon}>
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
          <DialogHeader icon={<SkipForward />} tone="warn">
            <DialogTitle>
              {t('skip.title', { step: current ? t(`step.${current.id}.title`) : '' })}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {currentCost ? <p>{currentCost}</p> : null}
            <p className="t-cap text-text-3">{t('skip.note')}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t('skip.back')}
            </Button>
            <Button variant="secondary" loading={busy} onClick={confirmSkip}>
              {t('action.skipStep')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Les étapes, en échelle verticale : la pastille dit l'issue (coche, trait,
 * numéro), la ligne sous le titre la redit en mots, et l'étape courante est
 * posée sur une carte blanche. Un clic y mène : on saute librement de l'une à
 * l'autre, rien n'est perdu.
 */
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
    <nav aria-label={t('stepper.label')} className="lg:sticky lg:top-20 lg:self-start">
      <ol className="flex flex-col">
        {steps.map((step, position) => {
          const active = step.id === currentId;
          const status =
            step.outcome === 'done'
              ? t('outcome.done')
              : step.outcome === 'skipped'
                ? t('outcome.skipped')
                : active
                  ? t('stepper.current')
                  : step.optional
                    ? t('badge.optional')
                    : null;
          return (
            <li key={step.id} className="relative">
              {position < steps.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-[34px] bottom-[-6px] left-[18px] w-[1.5px]',
                    step.outcome === 'done' ? 'bg-ok-line' : 'bg-border',
                  )}
                />
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => onSelect(step.id)}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'relative flex w-full items-start gap-3 rounded-[10px] px-2 py-2 text-left outline-none',
                  'transition-colors focus-visible:shadow-focus disabled:opacity-60 motion-reduce:transition-none',
                  active ? 'bg-surface shadow-sm' : 'hover:bg-surface-3',
                )}
              >
                <span
                  className={cn(
                    'mono flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] bg-surface text-[11px] font-semibold',
                    step.outcome === 'done'
                      ? 'border-ok-line bg-ok-soft text-ok'
                      : step.outcome === 'skipped'
                        ? 'border-warn-line bg-warn-soft text-warn'
                        : active
                          ? 'border-accent bg-accent text-white'
                          : 'border-border-strong text-text-3',
                  )}
                >
                  {step.outcome === 'done' ? (
                    <Check aria-hidden className="size-3" strokeWidth={2.4} />
                  ) : step.outcome === 'skipped' ? (
                    <Minus aria-hidden className="size-3" strokeWidth={2.4} />
                  ) : (
                    position + 1
                  )}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className={cn(
                      'truncate text-[13px] leading-5',
                      active ? 'font-semibold text-text' : 'font-medium text-text',
                    )}
                  >
                    {t(`step.${step.id}.title`)}
                  </span>
                  {status ? <span className="t-cap text-text-3">{status}</span> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Welcome() {
  const t = useT(onboarding);

  return (
    <div className="t-sm flex flex-col gap-4 text-text-2">
      <p>
        {rich(t('welcome.p1'), {
          controlPlane: <strong className="text-text">{t('welcome.p1.controlPlane')}</strong>,
          your: <em>{t('welcome.p1.your')}</em>,
        })}
      </p>
      <p>
        {rich(t('welcome.p2'), {
          keepRunning: <strong className="text-text">{t('welcome.p2.keepRunning')}</strong>,
        })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="well flex flex-col gap-1.5">
          <div className="t-cap font-medium text-text-2">{t('welcome.does.title')}</div>
          <ul className="bul t-cap flex flex-col gap-1">
            <li>{t('welcome.does.ssh')}</li>
            <li>{t('welcome.does.render')}</li>
            <li>{t('welcome.does.scan')}</li>
          </ul>
        </div>
        <div className="well flex flex-col gap-1.5">
          <div className="t-cap font-medium text-text-2">{t('welcome.doesNot.title')}</div>
          <ul className="bul t-cap flex flex-col gap-1">
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
      <p className="t-sm text-text-2">{t('target.intro')}</p>

      <div>
        <TargetHelpDialog label={t('target.help')} />
      </div>

      {existing !== null && existing > 0 ? (
        <Alert variant="info">
          {/*
            `count` choisit la forme, `{n}` porte le nombre en gras. Deux noms
            pour une seule valeur : l'un est substitué par `t()`, l'autre reste
            en place pour que `rich()` y pose le nœud.
          */}
          <span className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              {rich(t('target.existing', { count: existing }), {
                n: <strong>{existing}</strong>,
              })}
            </span>
            <Button size="sm" variant="secondary" disabled={disabled} onClick={onDone}>
              {t('target.haveOne')}
            </Button>
          </span>
        </Alert>
      ) : null}

      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {phase ? (
        <div className="well flex items-center gap-2.5">
          <Led tone="accent" pulse />
          <span className="t-sm font-semibold text-text">{phase}</span>
        </div>
      ) : null}

      <TargetForm
        onCreated={(target) => void afterCreate(target)}
        onCancel={null}
        submitLabel={t('target.submit')}
      />
    </div>
  );
}

function RoleStep({ roleKeys, onCreated }: { roleKeys: RoleKey[]; onCreated: () => void }) {
  const t = useT(onboarding);

  return (
    <div className="flex flex-col gap-4">
      <p className="t-sm text-text-2">
        {rich(t('role.intro'), {
          admin: <code className="mono">admin</code>,
          operator: <code className="mono">operator</code>,
          viewer: <code className="mono">viewer</code>,
          noPermission: <strong className="text-text">{t('role.intro.noPermission')}</strong>,
          rolesLink: (
            <Link href="/admin/roles" className="link">
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
      <p className="t-sm text-text-2">
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
      <section className="card overflow-hidden">
        <Table dense label={t('stepper.label')}>
          <TableBody>
            {actionable.map((step) => {
              const link = links[step.id];
              return (
                <TableRow key={step.id}>
                  <TableCell className="cellname">{t(`step.${step.id}.title`)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        step.outcome === 'done'
                          ? 'ok'
                          : step.outcome === 'skipped'
                            ? 'warn'
                            : 'idle'
                      }
                      dot
                    >
                      {outcomeLabel[step.outcome]}
                    </Badge>
                  </TableCell>
                  <TableCell className="r">
                    {link ? (
                      <Link href={link.href as never} className="link">
                        {link.label}
                      </Link>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      {skipped.length > 0 ? (
        <Alert variant="warn">
          {rich(
            t('summary.skipped', {
              count: skipped.length,
              list: skipped.map((step) => t(`step.${step.id}.title`)).join(', '),
            }),
            {
              settings: (
                <Link href="/admin/settings" className="link">
                  {t('summary.skipped.settings')}
                </Link>
              ),
            },
          )}
        </Alert>
      ) : null}

      <p className="t-cap text-text-3">
        {t('summary.finishNote')}
        {state.runs > 0 ? ` ${t('summary.run', { n: state.runs + 1 })}` : ''}
      </p>
    </div>
  );
}
