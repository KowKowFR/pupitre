'use client';

import type { Permission } from '@pupitre/core';
import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n/client';
import { admin } from '@/i18n/messages/admin';
import { cn } from '@/lib/utils';
import type { PermissionGroup } from './roles-editor';

/**
 * A role's permissions, grouped by resource, with "check all" per group. Shared
 * by a role's drawer and the second step of "New role": both check the same
 * thing, the same way. A sensitive permission says so: it is the one that makes
 * a second factor required.
 */
export function PermissionGroups({
  groups,
  selected,
  editable,
  onToggle,
  onToggleGroup,
}: {
  groups: PermissionGroup[];
  selected: ReadonlySet<string>;
  editable: boolean;
  onToggle: (permission: Permission) => void;
  onToggleGroup: (group: PermissionGroup, checked: boolean) => void;
}) {
  const t = useT(admin);
  const toggle = onToggle;
  const toggleGroup = onToggleGroup;
  return (
    <>
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

            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
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
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="mono text-[12px] font-semibold text-text">
                          {permission.key}
                        </span>
                        {permission.sensitive ? (
                          <Badge variant="warn" title={t('roles.sensitive.help')}>
                            {t('roles.sensitive')}
                          </Badge>
                        ) : null}
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
    </>
  );
}
