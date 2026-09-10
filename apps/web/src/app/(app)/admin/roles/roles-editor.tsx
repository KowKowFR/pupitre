'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { Permission } from '@tp/core';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

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

export function RolesEditor({
  roles,
  groups,
  canManage,
}: {
  roles: RoleRow[];
  groups: PermissionGroup[];
  canManage: boolean;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="space-y-4">
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
  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.permissions.length, 0),
    [groups],
  );

  const [label, setLabel] = useState(role.label);
  const [description, setDescription] = useState(role.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(role.permissions));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const editable = canManage && !role.locked;

  const dirty =
    label !== role.label ||
    description !== (role.description ?? '') ||
    selected.size !== role.permissions.length ||
    role.permissions.some((permission) => !selected.has(permission));

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
    setNotice(null);

    const response = await fetch(`/api/admin/roles/${role.key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label,
        description: description.trim() === '' ? null : description.trim(),
        permissions: [...selected],
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setPending(false);
      return;
    }

    setNotice('Rôle enregistré.');
    setPending(false);
    router.refresh();
  }

  async function remove() {
    if (
      !window.confirm(
        `Supprimer le rôle « ${role.key} » ? Cette action est définitive.`,
      )
    ) {
      return;
    }

    setPending(true);
    setError(null);

    const response = await fetch(`/api/admin/roles/${role.key}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setPending(false);
      return;
    }

    setPending(false);
    router.refresh();
  }

  function reset() {
    setLabel(role.label);
    setDescription(role.description ?? '');
    setSelected(new Set(role.permissions));
    setError(null);
    setNotice(null);
  }

  return (
    <Card className={cn(role.locked && 'border-dashed')}>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {role.label}
            <code className="text-muted-foreground font-mono text-xs font-normal">
              {role.key}
            </code>
            {role.locked ? <Badge variant="outline">verrouillé</Badge> : null}
          </CardTitle>
          <CardDescription>
            {role.description ?? 'Sans description.'}
            {' · '}
            {role.permissions.length} / {total} permission
            {role.permissions.length > 1 ? 's' : ''}
            {' · '}
            {role.userCount} utilisateur{role.userCount > 1 ? 's' : ''}
          </CardDescription>
        </div>

        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={onToggle}>
            {open ? 'Replier' : role.locked ? 'Voir' : 'Modifier'}
          </Button>
          {editable ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void remove()}>
              Supprimer
            </Button>
          ) : null}
        </div>
      </CardHeader>

      {open ? (
        <CardContent className="space-y-5 border-t pt-5">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          {notice ? <Alert variant="success">{notice}</Alert> : null}

          {role.locked ? (
            <Alert>
              Ce rôle est verrouillé. Il détient toujours l&apos;intégralité des permissions, y
              compris celles ajoutées plus tard, et ne peut être ni renommé ni supprimé.
            </Alert>
          ) : null}

          {editable ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`label-${role.key}`}>Nom affiché</Label>
                <Input
                  id={`label-${role.key}`}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  minLength={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`desc-${role.key}`}>Description</Label>
                <Input
                  id={`desc-${role.key}`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="À quoi sert ce rôle ?"
                />
              </div>
            </div>
          ) : null}

          <div className="space-y-4">
            {groups.map((group) => {
              const held = group.permissions.filter((p) => selected.has(p.key)).length;
              const all = held === group.permissions.length;

              return (
                <fieldset key={group.resource} className="space-y-2">
                  <legend className="flex w-full items-center justify-between gap-3 pb-1">
                    <span className="text-sm font-medium">{group.label}</span>
                    {editable ? (
                      <button
                        type="button"
                        onClick={() => toggleGroup(group, !all)}
                        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
                      >
                        {all ? 'tout décocher' : 'tout cocher'}
                      </button>
                    ) : (
                      <span className="text-muted-foreground font-mono text-xs">
                        {held}/{group.permissions.length}
                      </span>
                    )}
                  </legend>

                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {group.permissions.map((permission) => (
                      <label
                        key={permission.key}
                        className={cn(
                          'flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors',
                          selected.has(permission.key) ? 'bg-secondary' : 'bg-transparent',
                          editable ? 'cursor-pointer hover:border-ring' : 'cursor-default',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={selected.has(permission.key)}
                          disabled={!editable}
                          onChange={() => toggle(permission.key)}
                        />
                        <span className="min-w-0">
                          <span className="block font-mono text-xs">{permission.key}</span>
                          <span className="text-muted-foreground block text-xs">
                            {permission.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>

          {editable ? (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button size="sm" disabled={pending || !dirty} onClick={() => void save()}>
                {pending ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending || !dirty} onClick={reset}>
                Annuler
              </Button>
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                {selected.size} / {total} sélectionnée{selected.size > 1 ? 's' : ''}
              </span>
            </div>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
