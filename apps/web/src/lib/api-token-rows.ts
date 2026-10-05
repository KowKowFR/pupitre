import 'server-only';
import {
  isSensitivePermission,
  permissionDescriptions,
  permissionsByResource,
  resourceLabelOf,
  translator,
  type Permission,
} from '@pupitre/core';
import { listApiTokens, listApplications } from '@pupitre/db';
import type { TokenRow } from '@/components/api-tokens/token-list';
import { common } from '@/i18n/messages/common';
import { currentLanguage, getT } from '@/i18n/server';
import type { PermissionGroup } from '@/app/(app)/admin/roles/roles-editor';
import { toApiTokenDto } from './api-tokens';
import { formatDateTimeWith, type FormatSettings } from './format';
import { compactIp } from './ip';
import { relativeTime } from './relative-time';

/**
 * The tokens ready to show: dates in the instance's locale, last use in relative
 * time, applications by their name. Server rendering, so that the browser's clock
 * does not come into it.
 */
export async function apiTokenRows(
  filter: { userId?: string },
  format: FormatSettings,
): Promise<TokenRow[]> {
  const [tokens, applications, tc] = await Promise.all([
    listApiTokens(filter),
    listApplications(),
    getT(common),
  ]);
  const names = new Map(applications.map((application) => [application.id, application.name]));
  const date = (value: string) =>
    formatDateTimeWith(value, format, { day: 'numeric', month: 'short', year: 'numeric' });

  return tokens.map((token) => {
    const dto = toApiTokenDto(token);
    return {
      id: dto.id,
      name: dto.name,
      prefix: dto.prefix,
      status: dto.status,
      permissions: dto.permissions.length,
      // An application deleted since no longer covers anything: it disappears from the
      // list, as it disappeared from the effective scope.
      applications: dto.applicationIds
        ? dto.applicationIds.flatMap((id) => (names.has(id) ? [names.get(id)!] : []))
        : null,
      created: date(dto.createdAt),
      expires: dto.expiresAt ? date(dto.expiresAt) : null,
      lastUsed: relativeTime(dto.lastUsedAt, tc),
      lastUsedIp: compactIp(dto.lastUsedIp),
      ...(filter.userId ? {} : { owner: dto.owner.name || dto.owner.email }),
    };
  });
}

/** The permissions a person can delegate to a token: their own, grouped. */
export async function delegablePermissionGroups(
  held: readonly Permission[],
): Promise<PermissionGroup[]> {
  const language = await currentLanguage();
  const mine = new Set<string>(held);
  return permissionsByResource(translator(permissionDescriptions, language))
    .map((group) => ({
      resource: group.resource,
      label: resourceLabelOf(group.resource, language),
      permissions: group.permissions
        .filter((permission) => mine.has(permission.key))
        .map((permission) => ({ ...permission, sensitive: isSensitivePermission(permission.key) })),
    }))
    .filter((group) => group.permissions.length > 0);
}
