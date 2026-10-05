'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Check, KeyRound } from 'lucide-react';
import type { Permission } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { cn } from '@/lib/utils';
import { RoleIdentityFields, toKey, type CreatedRole } from './create-role-form';
import { PermissionGroups } from './permission-groups';
import type { PermissionGroup } from './roles-editor';

type ApiError = { error?: { message?: string } };

/**
 * "New role", in two steps: who it is, then what it can do.
 *
 * The role is only created at the end, in a single call that carries its
 * permissions: closing the drawer midway does not leave a half-defined role, and
 * the log only keeps one entry. No permission is checked in advance — a role
 * only carries what is granted to it, deliberately.
 */
export function NewRoleDrawer({
  open,
  existingKeys,
  groups,
  onClose,
  onCreated,
}: {
  open: boolean;
  existingKeys: string[];
  groups: PermissionGroup[];
  onClose: () => void;
  onCreated: (role: CreatedRole) => void;
}) {
  const t = useT(admin);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      wide
      label={t('roles.new.title')}
    >
      {open ? (
        <NewRoleSteps
          existingKeys={existingKeys}
          groups={groups}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </Drawer>
  );
}

function NewRoleSteps({
  existingKeys,
  groups,
  onClose,
  onCreated,
}: {
  existingKeys: string[];
  groups: PermissionGroup[];
  onClose: () => void;
  onCreated: (role: CreatedRole) => void;
}) {
  const t = useT(admin);
  const c = useT(common);
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const effectiveKey = keyTouched ? key : toKey(label);
  const taken = existingKeys.includes(effectiveKey);
  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.permissions.length, 0),
    [groups],
  );

  // What prevents moving to the next step, spelled out under the button.
  const identityProblem = taken
    ? t('roles.form.keyTaken')
    : label.trim().length < 2
      ? t('roles.new.nameMissing')
      : !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(effectiveKey)
        ? t('roles.new.keyInvalid')
        : null;

  function toggle(permission: Permission) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  function toggleGroup(group: PermissionGroup, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const permission of group.permissions) {
        if (checked) next.add(permission.key);
        else next.delete(permission.key);
      }
      return next;
    });
  }

  async function create() {
    setPending(true);
    setError(null);
    const response = await fetch('/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: effectiveKey,
        label: label.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        permissions: [...selected],
      }),
    });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }
    const created = (await response.json().catch(() => null)) as CreatedRole | null;
    onCreated(created ?? { key: effectiveKey, label: label.trim() });
    router.refresh();
  }

  return (
    <>
      <DrawerHeader
        icon={<KeyRound />}
        kind={t('roles.new.kind')}
        title={t('roles.new.title')}
        extra={
          <div className="flex flex-col gap-3">
            <p className="t-sm text-text-2">{t('roles.new.help')}</p>
            <Stepper
              step={step}
              labels={[t('roles.new.step.identity'), t('roles.new.step.permissions')]}
            />
          </div>
        }
      />

      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 1) {
            if (identityProblem === null) setStep(2);
            return;
          }
          void create();
        }}
      >
        <DrawerBody>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {step === 1 ? (
            <RoleIdentityFields
              label={label}
              onLabelChange={setLabel}
              roleKey={effectiveKey}
              onKeyChange={(value) => {
                setKeyTouched(true);
                setKey(value);
              }}
              taken={taken}
              description={description}
              onDescriptionChange={setDescription}
            />
          ) : (
            <>
              <p className="t-sm text-text-2">
                {t('roles.new.permissions.help', { label: label.trim() })}
              </p>
              <PermissionGroups
                groups={groups}
                selected={selected}
                editable
                onToggle={toggle}
                onToggleGroup={toggleGroup}
              />
            </>
          )}
        </DrawerBody>

        <DrawerFooter
          end={
            step === 2 ? (
              <span className="t-cap text-text-3">
                {t('roles.selectedCount', { count: selected.size, total })}
              </span>
            ) : null
          }
        >
          {step === 1 ? (
            <>
              <Button type="submit" disabledReason={identityProblem}>
                {t('roles.new.next')}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                {c('cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button type="submit" loading={pending}>
                {pending ? c('creating') : t('roles.new.create')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
              >
                {t('roles.new.back')}
              </Button>
            </>
          )}
        </DrawerFooter>
      </form>
    </>
  );
}

/**
 * The two steps, readable at a glance: the done step carries a check mark, the
 * current step the accent tint, the next one stays neutral. The number and the
 * label say the same thing without color.
 */
function Stepper({ step, labels }: { step: 1 | 2; labels: [string, string] }) {
  const t = useT(admin);
  return (
    <ol
      className="flex flex-wrap items-center gap-2"
      aria-label={t('roles.new.progress', { step })}
    >
      {labels.map((label, index) => {
        const number = index + 1;
        const state = number < step ? 'done' : number === step ? 'current' : 'next';
        return (
          <li key={label} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-border-strong" /> : null}
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-[12.5px] font-medium',
                state === 'current' && 'border-accent-line bg-accent-soft text-accent-text',
                state === 'done' && 'border-ok-line bg-ok-soft text-ok-text',
                state === 'next' && 'border-border bg-surface text-text-3',
              )}
            >
              <span
                className={cn(
                  'grid size-5 place-items-center rounded-full text-[11px] font-semibold',
                  state === 'current' && 'bg-accent text-white',
                  state === 'done' && 'bg-ok text-white',
                  state === 'next' && 'bg-surface-3 text-text-3',
                )}
              >
                {state === 'done' ? <Check aria-hidden className="size-3" /> : number}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
