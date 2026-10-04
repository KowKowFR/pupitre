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
import { ProxyPanel } from '@/components/proxy/proxy-panel';
import { TargetHelp } from '@/components/target-help';
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
import type { FormatSettings } from '@/lib/format';
import type { ProxyViewForUi } from '@/lib/proxy';
import { cn } from '@/lib/utils';
import { CreateRoleForm } from '@/app/(app)/admin/roles/create-role-form';
import { CreateUserForm } from '@/app/(app)/admin/users/create-user-form';
import { TargetForm } from '@/app/(app)/targets/target-form';
import { usePreflight } from '@/app/(app)/targets/use-preflight';
import { OnboardingTopbar } from '../onboarding-topbar';
import { IdentityStep, SecurityStep } from './settings-steps';

/**
 * The onboarding assistant — the shell.
 *
 * The rule that governs this whole file: **it creates nothing itself**. Each step
 * mounts the normal screen's form (`TargetForm`, `CreateRoleForm`,
 * `CreateUserForm`) or calls the route that screen already calls
 * (`PATCH /api/settings`). A "simpler" form copied here would have started to
 * diverge from the original at the first added field, and its validation, its
 * audit and its preflight with it.
 *
 * Only the progress goes through a route of its own — `PATCH /api/onboarding` —
 * because remembering where one stands is the business of none of the others.
 */

/** A client mirror of `OnboardingEnvironment`, without importing the server module. */
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
  /** The machines whose reverse proxy can be set — the `proxy` step. */
  proxyTargets: Array<{ id: string; name: string }>;
  format: FormatSettings;
  /** Offered for Let's Encrypt: the signed-in person's email. */
  userEmail: string;
  /**
   * Can the instance send an email? On a new instance — this assistant's typical
   * case — the answer is almost always "no", and the step then offers a password.
   * The flag is passed on all the same: someone who configured SMTP before
   * arriving here must be able to invite, as everywhere else.
   */
  canInvite: boolean;
};

type PatchResponse = { state: OnboardingState; steps: OnboardingPresentedStep[] };
type ApiError = { error?: { message?: string } };

/**
 * The four steps that carry a cost — exactly those that `optional` allows
 * skipping.
 *
 * A table of literal keys rather than a `` `step.${id}.cost` `` built on the fly:
 * the compiler then refuses `step.welcome.cost`, which does not exist and must
 * not exist. It is the guard that replaces the old `cost: null`.
 */
const COST_KEYS = {
  target: 'step.target.cost',
  proxy: 'step.proxy.cost',
  role: 'step.role.cost',
  user: 'step.user.cost',
  security: 'step.security.cost',
} as const;

const RICH_PART = /\{(\w+)\}/g;

/**
 * Renders a sentence some fragments of which are nodes — a bold word, a link, a
 * monospaced identifier.
 *
 * The dictionary keeps the **whole** sentence, with a `{name}` where the node
 * goes in. Cutting it into three keys would have left the translator pieces
 * without context and frozen the word order: English moves the emphasis. `t()`
 * leaves intact the `{name}`s it is not given as variables, which is enough to
 * find them here.
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
   * The remembered step is the *instance*'s, not the person's: if an administrator
   * stopped on "a role" and an operator takes over, one lands on the first step
   * that concerns them rather than on an empty screen.
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
   * Only two gestures can cut the journey short, and both go through a
   * confirmation that names the consequence. A button pressed by reflex is not a
   * choice: a half-configured installation rediscovered three weeks later costs
   * more than the time to read two sentences.
   */
  const [confirming, setConfirming] = useState<'abandon' | 'skip' | null>(null);

  async function leave(action: 'finish' | 'dismiss') {
    if (!(await send({ action }))) return;
    // The resume banner lives in the server layout: it must be rendered again for it
    // to disappear, otherwise it would stay on screen.
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
  /** What one leaves behind — named, not counted. */
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

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
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

                {currentId === 'proxy' ? (
                  <ProxyStep
                    targets={props.proxyTargets}
                    format={props.format}
                    email={props.userEmail}
                    onDone={() => complete('proxy')}
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
 * The steps, as a vertical ladder: the dot says the outcome (check, dash,
 * number), the line under the title says it again in words, and the current step
 * sits on a white card. A click leads there: one jumps freely from one to the
 * other, nothing is lost.
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

/**
 * The machine's reverse proxy: the same card as on the target's page. The step is
 * done when a proxy is linked — found or installed.
 */
function ProxyStep({
  targets,
  format,
  email,
  onDone,
}: {
  targets: Array<{ id: string; name: string }>;
  format: FormatSettings;
  email: string;
  onDone: () => void;
}) {
  const t = useT(onboarding);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [proxy, setProxy] = useState<ProxyViewForUi | null>(null);
  const target = targets.find((candidate) => candidate.id === targetId) ?? targets[0];
  if (!target) return <p className="t-sm text-text-3">{t('proxy.noTarget')}</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="t-sm text-text-2">{t('proxy.intro')}</p>
      {targets.length > 1 ? (
        <label className="flex max-w-sm flex-col gap-1.5">
          <span className="t-sm font-medium">{t('proxy.target')}</span>
          <select
            className="select"
            value={target.id}
            onChange={(event) => {
              setProxy(null);
              setTargetId(event.target.value);
            }}
          >
            {targets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ProxyPanel
        key={target.id}
        targetId={target.id}
        targetName={target.name}
        canManage
        format={format}
        defaultEmail={email}
        onProxyChange={setProxy}
      />
      {proxy && proxy.status !== 'installing' && proxy.status !== 'failed' ? (
        <div>
          <Button onClick={onDone}>
            <Check aria-hidden />
            {t('proxy.done')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

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
    // Exactly the same sequence as the targets list's "Test the connection" button:
    // POST /api/targets/{id}/preflight, then following the BullMQ job. No SSH
    // session is opened from an HTTP route.
    await preflight.run(target.id);
    setPhase(t('target.tested', { name: target.name }));
    onDone();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="t-sm text-text-2">{t('target.intro')}</p>

      <div>
        <TargetHelp label={t('target.help')} />
      </div>

      {existing !== null && existing > 0 ? (
        <Alert variant="info">
          {/*
            `count` chooses the form, `{n}` carries the number in bold. Two names
            for a single value: one is substituted by `t()`, the other stays in
            place so that `rich()` sets the node there.
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
          auditor: <code className="mono">auditor</code>,
          viewer: <code className="mono">viewer</code>,
          noAccess: <code className="mono">no-access</code>,
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
