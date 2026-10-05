'use client';

import { requiresTwoFactor, type TwoFactorPolicy } from '@pupitre/core';
import { Lock, ShieldCheck } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { TableScroller } from '@/components/ui/table-scroller';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { common } from '@/i18n/messages/common';
import { cn } from '@/lib/utils';
import type { PermissionGroup, RoleRow } from './roles-editor';

/**
 * The rights matrix: the roles in columns, the permission families in rows.
 * Each cell lines up one dot per permission of the family — filled if the role
 * carries it, hollow otherwise; an orange diamond when it is sensitive. Hovering
 * says which ones; clicking opens the role.
 */
export function RolesMatrix({
  roles,
  groups,
  canManage,
  twoFactorPolicy,
  selected,
  onOpen,
}: {
  roles: RoleRow[];
  groups: PermissionGroup[];
  canManage: boolean;
  twoFactorPolicy: TwoFactorPolicy;
  selected: string | null;
  onOpen: (key: string) => void;
}) {
  const t = useT(admin);
  const c = useT(common);
  const total = groups.reduce((sum, group) => sum + group.permissions.length, 0);

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border-subtle px-4 py-2.5">
        <span className="t-cap text-text-3">{t('roles.matrix.legend')}</span>
        <span className="t-cap flex items-center gap-1.5 text-text-2">
          <Pip held sensitive={false} />
          {t('roles.matrix.held')}
        </span>
        <span className="t-cap flex items-center gap-1.5 text-text-2">
          <Pip held sensitive />
          {t('roles.matrix.heldSensitive')}
        </span>
        <span className="t-cap flex items-center gap-1.5 text-text-2">
          <span className="inline-flex items-center gap-[3px]">
            <Pip held={false} sensitive={false} />
            <Pip held={false} sensitive />
          </span>
          {t('roles.matrix.missing')}
        </span>
      </div>

      <TableScroller label={t('roles.title')}>
        <table className="tbl roles-matrix">
          <thead>
            <tr>
              <th scope="col" className="roles-matrix-corner">
                {t('roles.matrix.family')}
              </th>
              {roles.map((role) => (
                <th
                  key={role.key}
                  scope="col"
                  className={cn('roles-matrix-role', selected === role.key && 'is-selected')}
                >
                  <button
                    type="button"
                    className="roles-matrix-head"
                    onClick={() => onOpen(role.key)}
                    aria-label={t('roles.matrix.open', {
                      label: role.label,
                      action: canManage && !role.locked ? c('edit') : t('roles.action.view'),
                    })}
                  >
                    <span className="flex items-center gap-1.5 font-semibold text-text">
                      <span className="truncate">{role.label}</span>
                      {role.locked ? (
                        <Lock aria-hidden className="size-3 shrink-0 text-text-3" />
                      ) : null}
                    </span>
                    <span className="mono truncate text-[11px] font-normal text-text-3">
                      {role.key}
                    </span>
                    <span className="t-cap font-normal text-text-2">
                      {t('roles.userCount', { count: role.userCount })}
                    </span>
                    <span className="t-cap font-medium text-accent-text">
                      {canManage && !role.locked ? c('edit') : t('roles.action.view')}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group.resource}>
                <th scope="row" className="roles-matrix-family">
                  <span className="font-medium text-text">{group.label}</span>
                  <span className="mono t-cap block text-text-3">{group.resource}</span>
                </th>
                {roles.map((role) => (
                  <MatrixCell
                    key={role.key}
                    role={role}
                    group={group}
                    selected={selected === role.key}
                    onOpen={() => onOpen(role.key)}
                  />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="roles-matrix-family">
                {t('roles.matrix.total')}
              </th>
              {roles.map((role) => (
                <td key={role.key} className={cn(selected === role.key && 'is-selected')}>
                  <span className="mono num text-text">
                    {role.permissions.length}
                    <span className="text-text-3">/{total}</span>
                  </span>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className="roles-matrix-family">
                <Tooltip content={t(`roles.matrix.twoFactor.help.${twoFactorPolicy}`)} wide>
                  <span tabIndex={0} className="cursor-help underline decoration-dotted">
                    {t('roles.matrix.twoFactor')}
                  </span>
                </Tooltip>
              </th>
              {roles.map((role) => (
                <td key={role.key} className={cn(selected === role.key && 'is-selected')}>
                  {requiresTwoFactor(role.permissions, twoFactorPolicy) ? (
                    <span className="t-cap inline-flex items-center gap-1 font-medium text-warn-text">
                      <ShieldCheck aria-hidden className="size-3.5" />
                      {t('roles.matrix.twoFactor.required')}
                    </span>
                  ) : (
                    <span className="t-cap text-text-3">{c('none')}</span>
                  )}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </TableScroller>
    </section>
  );
}

function MatrixCell({
  role,
  group,
  selected,
  onOpen,
}: {
  role: RoleRow;
  group: PermissionGroup;
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT(admin);
  const held = group.permissions.filter((permission) => role.permissions.includes(permission.key));
  const summary = t('roles.matrix.cell', {
    family: group.label,
    count: held.length,
    total: group.permissions.length,
  });

  return (
    <td className={cn('roles-matrix-cell', selected && 'is-selected')} onClick={onOpen}>
      <Tooltip
        wide
        content={
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">{summary}</span>
            {group.permissions.map((permission) => (
              <span
                key={permission.key}
                className={cn(
                  'mono',
                  !role.permissions.includes(permission.key) && 'line-through opacity-60',
                )}
              >
                {permission.key}
                {permission.sensitive ? ' ◆' : ''}
              </span>
            ))}
          </span>
        }
      >
        <span
          role="img"
          aria-label={[summary, ...held.map((permission) => permission.key)].join(', ')}
          className="inline-flex items-center gap-2"
        >
          <span className="inline-flex items-center gap-[3px]">
            {group.permissions.map((permission) => (
              <Pip
                key={permission.key}
                held={role.permissions.includes(permission.key)}
                sensitive={permission.sensitive}
              />
            ))}
          </span>
          <span className="mono t-cap num text-text-3">
            {held.length}/{group.permissions.length}
          </span>
        </span>
      </Tooltip>
    </td>
  );
}

/**
 * A permission. The shape says the nature (diamond: sensitive), the fill says
 * the grant (filled: carried) — the color only doubles it.
 */
function Pip({ held, sensitive }: { held: boolean; sensitive: boolean }) {
  return (
    <span aria-hidden className={cn('role-pip', held && 'is-held', sensitive && 'is-sensitive')} />
  );
}
