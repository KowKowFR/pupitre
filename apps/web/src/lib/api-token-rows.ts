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
 * Les jetons prêts à afficher : dates à la locale de l'instance, dernière
 * utilisation en temps relatif, applications par leur nom. Rendu serveur, pour
 * que l'horloge du navigateur n'y entre pas.
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
      // Une application supprimée depuis ne couvre plus rien : elle disparaît
      // de la liste, comme elle a disparu de la portée effective.
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

/** Les permissions qu'une personne peut déléguer à un jeton : les siennes, groupées. */
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
