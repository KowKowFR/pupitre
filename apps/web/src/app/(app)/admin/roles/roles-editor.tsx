'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Lock, Plus, Trash2, KeyRound } from 'lucide-react';
import type { Permission } from '@pupitre/core';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { IconButton, Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { CreateRoleForm } from './create-role-form';

export type RoleRow = {
  key: string;
  label: string;
  description: string | null;
  locked: boolean;
  permissions: Permission[];
  userCount: number;
};

export type PermissionGroup = {
  resource: string;
  label: string;
  permissions: Array<{ key: Permission; action: string; description: string }>;
};

type ApiError = { error?: { message?: string } };

/**
 * Les rôles, un par carte. Une carte se déplie pour éditer : nom, description
 * et permissions groupées par ressource. Une seule carte ouverte à la fois —
 * on compare deux rôles en les lisant replié, pas en éditant les deux.
 */
export function RolesEditor({
  roles,
  groups,
  canManage,
  lockedRole,
}: {
  roles: RoleRow[];
  groups: PermissionGroup[];
  canManage: boolean;
  /** La clé du rôle verrouillé, nommée dans la description de l'écran. */
  lockedRole: string;
}) {
  const t = useT(admin);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title={t('roles.title')}
        description={
          <>
            {t('roles.description.before')} <code className="mono">{lockedRole}</code>{' '}
            {t('roles.description.after')}
          </>
        }
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('roles.new.action')}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-col gap-4">
        {roles.map((role) => (
          <RoleCard
            key={role.key}
            role={role}
            groups={groups}
            canManage={canManage}
            open={openKey === role.key}
            onToggle={() => setOpenKey((current) => (current === role.key ? null : role.key))}
          />
        ))}
      </div>

      {canManage ? (
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent>
            <DialogHeader icon={<KeyRound />} tone="accent">
              <DialogTitle>{t('roles.new.title')}</DialogTitle>
              <DialogDescription>{t('roles.new.help')}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <CreateRoleForm
                existingKeys={roles.map((role) => role.key)}
                onCreated={(role) => {
                  setCreating(false);
                  setOpenKey(role.key);
                  toast({ title: t('roles.created', { label: role.label }) });
                }}
              />
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function RoleCard({
  role,
  groups,
  canManage,
  open,
  onToggle,
}: {
  role: RoleRow;
  groups: PermissionGroup[];
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
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

  // Le décompte de ce qui change : chaque permission ajoutée ou retirée, plus
  // le nom et la description. C'est ce que le pied de carte annonce.
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
    router.refresh();
  }

  function reset() {
    setLabel(role.label);
    setDescription(role.description ?? '');
    setSelected(new Set(role.permissions));
    setError(null);
  }

  return (
    <section className={cn('card overflow-hidden', role.locked && 'border-dashed')}>
      <div
        className={cn(
          'flex flex-wrap items-center gap-3 px-4 py-3.5',
          open && 'border-b border-border-subtle',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <h2 className="text-[14px] font-semibold text-text">{role.label}</h2>
            <CodeBadge>{role.key}</CodeBadge>
            {role.locked ? (
              <Badge variant="outline">
                <Lock aria-hidden className="size-3" />
                {t('roles.locked')}
              </Badge>
            ) : null}
          </span>
          <span className="t-cap text-text-3">
            {role.description ?? t('roles.noDescription')}
            {' · '}
            {t('roles.permissionCount', { count: role.permissions.length, total })}
            {' · '}
            {t('roles.userCount', { count: role.userCount })}
          </span>
        </div>

        <span className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="secondary" aria-expanded={open} onClick={onToggle}>
            {open ? t('roles.action.collapse') : editable ? c('edit') : t('roles.action.view')}
          </Button>
          {editable ? (
            inUse ? (
              // Un rôle porté ne se supprime pas : le bouton reste là, et dit
              // pourquoi au survol comme au focus.
              <Tooltip content={t('roles.delete.inUse', { count: role.userCount })} wide>
                <span
                  tabIndex={0}
                  className="inline-flex rounded-md outline-none focus-visible:shadow-focus"
                >
                  <IconButton
                    label={t('roles.delete.aria', { label: role.label })}
                    size="icon-sm"
                    disabled
                  >
                    <Trash2 />
                  </IconButton>
                </span>
              </Tooltip>
            ) : (
              <IconButton
                label={t('roles.delete.aria', { label: role.label })}
                size="icon-sm"
                disabled={pending}
                onClick={() => {
                  setDeleteError(null);
                  setDeleting(true);
                }}
              >
                <Trash2 />
              </IconButton>
            )
          ) : null}
        </span>
      </div>

      {open ? (
        <>
          <div className="flex flex-col gap-5 px-4 py-4">
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            {role.locked ? <Alert>{t('roles.locked.notice')}</Alert> : null}

            {editable ? (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
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
            ) : null}

            {groups.map((group) => {
              const held = group.permissions.filter((p) => selected.has(p.key)).length;
              const all = held === group.permissions.length;

              return (
                <fieldset
                  key={group.resource}
                  className="rounded-[10px] border border-border px-3 pt-1 pb-3"
                >
                  <legend className="flex items-center gap-2 px-1.5 text-[13px]">
                    <span className="font-semibold text-text">{group.label}</span>
                    <span className="mono t-cap text-text-3">
                      {held}/{group.permissions.length}
                    </span>
                    {editable ? (
                      <button
                        type="button"
                        className="btn btn-link t-cap"
                        onClick={() => toggleGroup(group, !all)}
                      >
                        {all ? t('roles.group.uncheckAll') : t('roles.group.checkAll')}
                      </button>
                    ) : null}
                  </legend>

                  <div className="grid gap-1 sm:grid-cols-2">
                    {group.permissions.map((permission) => {
                      const checked = selected.has(permission.key);
                      return (
                        <label
                          key={permission.key}
                          className={cn(
                            'flex items-start gap-2.5 rounded-lg px-3 py-2 transition-colors',
                            checked && 'bg-surface-2',
                            editable ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="cb mt-0.5"
                            checked={checked}
                            disabled={!editable}
                            onChange={() => toggle(permission.key)}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="mono text-[12px] font-semibold text-text">
                              {permission.key}
                            </span>
                            <span className="t-cap text-text-3">{permission.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}

            {editable && inUse ? (
              <p className="t-cap text-text-3">
                {t('roles.delete.inUse', { count: role.userCount })}
              </p>
            ) : null}
          </div>

          {editable ? (
            <div className="card-f flex flex-wrap items-center gap-2">
              <Button loading={pending} disabled={changes === 0} onClick={() => void save()}>
                {pending ? c('saving') : c('save')}
              </Button>
              <Button variant="ghost" disabled={pending || changes === 0} onClick={reset}>
                {c('reset')}
              </Button>
              <span className="t-cap ml-auto text-text-3">
                {t('roles.selectedCount', { count: selected.size, total })}
                {changes > 0 ? ` · ${t('roles.changes', { count: changes })}` : ''}
              </span>
            </div>
          ) : null}
        </>
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
    </section>
  );
}
