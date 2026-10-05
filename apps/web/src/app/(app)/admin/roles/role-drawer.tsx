'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Lock, ShieldCheck, Trash2, UsersRound } from 'lucide-react';
import { requiresTwoFactor, type Permission, type TwoFactorPolicy } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Drawer,
  DrawerBody,
  DrawerDanger,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';
import { PermissionGroups } from './permission-groups';
import type { PermissionGroup, RoleRow } from './roles-editor';

type ApiError = { error?: { message?: string } };

/**
 * A role, in its drawer: read it entirely, and — if it is not locked and one has
 * `role:manage` — rename it, change its permissions, delete it when nobody
 * carries it any more.
 */
export function RoleDrawer({
  role,
  groups,
  canManage,
  twoFactorPolicy,
  onClose,
  onPrevious,
  onNext,
}: {
  role: RoleRow | null;
  groups: PermissionGroup[];
  canManage: boolean;
  twoFactorPolicy: TwoFactorPolicy;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const t = useT(admin);
  return (
    <Drawer
      open={role !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
      onPrevious={onPrevious}
      onNext={onNext}
      wide
      label={role ? role.label : t('roles.title')}
    >
      {role ? (
        <RoleForm
          // Another role, or the same one read again after saving: we start again from
          // what the server says.
          key={`${role.key}|${role.label}|${role.description ?? ''}|${role.permissions.join(',')}`}
          role={role}
          groups={groups}
          canManage={canManage}
          twoFactorPolicy={twoFactorPolicy}
          onDeleted={onClose}
        />
      ) : null}
    </Drawer>
  );
}

function RoleForm({
  role,
  groups,
  canManage,
  twoFactorPolicy,
  onDeleted,
}: {
  role: RoleRow;
  groups: PermissionGroup[];
  canManage: boolean;
  twoFactorPolicy: TwoFactorPolicy;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const t = useT(admin);
  const c = useT(common);
  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.permissions.length, 0),
    [groups],
  );

  const [label, setLabel] = useState(role.label);
  const [description, setDescription] = useState(role.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role.permissions));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const editable = canManage && !role.locked;
  const inUse = role.userCount > 0;
  const twoFactor = requiresTwoFactor([...selected], twoFactorPolicy);

  // The count of what changes: each permission added or removed, plus the name
  // and the description. It is what the drawer's footer announces.
  const changes =
    (label !== role.label ? 1 : 0) +
    (description !== (role.description ?? '') ? 1 : 0) +
    role.permissions.filter((permission) => !selected.has(permission)).length +
    [...selected].filter((permission) => !role.permissions.includes(permission as Permission))
      .length;

  function toggle(permission: Permission) {
    if (!editable) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  function toggleGroup(group: PermissionGroup, checked: boolean) {
    if (!editable) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const permission of group.permissions) {
        if (checked) next.add(permission.key);
        else next.delete(permission.key);
      }
      return next;
    });
  }

  async function save() {
    setPending(true);
    setError(null);

    const response = await fetch(`/api/admin/roles/${role.key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label,
        description: description.trim() === '' ? null : description.trim(),
        permissions: [...selected],
      }),
    });

    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }

    toast({ title: t('roles.saved') });
    router.refresh();
  }

  async function remove() {
    setPending(true);
    setDeleteError(null);

    const response = await fetch(`/api/admin/roles/${role.key}`, { method: 'DELETE' });
    setPending(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setDeleteError(body.error?.message ?? c('http.failure', { status: response.status }));
      return;
    }

    setDeleting(false);
    toast({ title: t('roles.deleted', { label: role.label }) });
    onDeleted();
    router.refresh();
  }

  function reset() {
    setLabel(role.label);
    setDescription(role.description ?? '');
    setSelected(new Set(role.permissions));
    setError(null);
  }

  return (
    <>
      <DrawerHeader
        icon={<UsersRound />}
        kind={t('roles.new.kind')}
        route={role.key}
        title={role.label}
        state={
          <>
            {role.locked ? (
              <Badge variant="outline">
                <Lock aria-hidden className="size-3" />
                {t('roles.locked')}
              </Badge>
            ) : null}
            {twoFactor ? (
              <Badge variant="warn">
                <ShieldCheck aria-hidden className="size-3" />
                {t('roles.matrix.twoFactor.required')}
              </Badge>
            ) : null}
            <span className="text-text-2">{t('roles.userCount', { count: role.userCount })}</span>
            <span className="text-text-3">
              {t('roles.permissionCount', { count: selected.size, total })}
            </span>
          </>
        }
      />
      <DrawerBody>
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {role.locked ? <Alert>{t('roles.locked.notice')}</Alert> : null}

        {editable ? (
          <DrawerSection title={t('roles.new.step.identity')}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
              <Field label={t('roles.field.label')}>
                <Input
                  value={label}
                  minLength={2}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </Field>
              <Field label={t('roles.form.description')}>
                <Input
                  value={description}
                  placeholder={t('roles.field.descriptionPlaceholder')}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
            </div>
          </DrawerSection>
        ) : role.description ? (
          <p className="t-sm text-text-2">{role.description}</p>
        ) : null}

        <DrawerSection title={t('roles.new.step.permissions')}>
          <div className="flex flex-col gap-3">
            <PermissionGroups
              groups={groups}
              selected={selected}
              editable={editable}
              onToggle={toggle}
              onToggleGroup={toggleGroup}
            />
          </div>
        </DrawerSection>

        {editable ? (
          <DrawerDanger>
            {inUse ? (
              <p className="t-sm text-text-2">
                {t('roles.delete.inUse', { count: role.userCount })}
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="t-sm min-w-0 flex-1 text-text-2">{t('roles.delete.gone')}</p>
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(true);
                  }}
                >
                  <Trash2 aria-hidden />
                  {t('roles.delete.confirm')}
                </Button>
              </div>
            )}
          </DrawerDanger>
        ) : null}
      </DrawerBody>

      {editable ? (
        <DrawerFooter
          end={
            <span className="t-cap text-text-3">
              {changes > 0 ? t('roles.changes', { count: changes }) : t('roles.noChanges')}
            </span>
          }
        >
          <Button loading={pending} disabled={changes === 0} onClick={() => void save()}>
            {pending ? c('saving') : c('save')}
          </Button>
          <Button variant="ghost" disabled={pending || changes === 0} onClick={reset}>
            {c('reset')}
          </Button>
        </DrawerFooter>
      ) : null}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        level="trace"
        icon={<Trash2 />}
        title={t('roles.delete.title', { label: role.label })}
        consequences={[t('roles.delete.gone'), t('roles.delete.audit')]}
        confirmLabel={t('roles.delete.confirm')}
        pending={pending}
        error={deleteError}
        onConfirm={remove}
      />
    </>
  );
}
