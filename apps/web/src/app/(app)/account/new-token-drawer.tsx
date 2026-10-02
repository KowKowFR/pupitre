'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import type { Permission } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CheckboxField } from '@/components/ui/checkbox';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Radio, RadioGroup, RadioOption } from '@/components/ui/radio';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n/client';
import { apiTokens as messages } from '@/i18n/messages/api-tokens';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';
import { PermissionGroups } from '../admin/roles/permission-groups';
import type { PermissionGroup } from '../admin/roles/roles-editor';
import { readApiError } from './api-error';

type Preset = 'deploy' | 'read' | 'custom';
type Expiry = '30' | '90' | '365' | 'never';

/** Ce qu'une CI fait d'un déploiement, de bout en bout : le lancer, le suivre, en revenir. */
const DEPLOY_PRESET: readonly Permission[] = [
  'deployment:create',
  'deployment:read',
  'deployment:rollback',
  'application:read',
  'application:update',
];

/**
 * « Nouveau jeton » : un nom, une échéance, ce qu'il peut faire, sur quelles
 * applications. Les permissions proposées sont celles de la personne, et
 * elles seules : on ne délègue que ce qu'on a.
 *
 * Une fois créé, le tiroir montre le jeton **une seule fois**, avec de quoi
 * s'en servir. Fermer le tiroir le fait disparaître pour de bon.
 */
export function NewTokenDrawer({
  open,
  groups,
  applications,
  onClose,
}: {
  open: boolean;
  groups: PermissionGroup[];
  applications: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const t = useT(messages);
  return (
    <Drawer
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      wide
      label={t('new.title')}
    >
      {open ? <NewTokenForm groups={groups} applications={applications} onClose={onClose} /> : null}
    </Drawer>
  );
}

function NewTokenForm({
  groups,
  applications,
  onClose,
}: {
  groups: PermissionGroup[];
  applications: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const t = useT(messages);
  const c = useT(common);
  const router = useRouter();

  const held = useMemo(
    () => groups.flatMap((group) => group.permissions.map((permission) => permission.key)),
    [groups],
  );
  const presets = useMemo<Record<Exclude<Preset, 'custom'>, Permission[]>>(
    () => ({
      deploy: DEPLOY_PRESET.filter((key) => held.includes(key)),
      read: held.filter((key) => key.endsWith(':read')),
    }),
    [held],
  );

  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [preset, setPreset] = useState<Preset>(presets.deploy.length > 0 ? 'deploy' : 'read');
  const [custom, setCustom] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const permissions = preset === 'custom' ? [...custom] : presets[preset];
  const problem =
    name.trim().length === 0
      ? t('problem.name')
      : permissions.length === 0
        ? t('problem.permissions')
        : scope === 'some' && chosen.size === 0
          ? t('problem.applications')
          : null;

  async function create(): Promise<void> {
    setPending(true);
    setError(null);
    const response = await fetch('/api/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        permissions,
        applicationIds: scope === 'some' ? [...chosen] : null,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      }),
    });
    setPending(false);
    if (!response.ok) {
      setError(await readApiError(response, c('http.failure', { status: response.status })));
      return;
    }
    const body = (await response.json()) as { token: string; item: { name: string } };
    setCreated({ token: body.token, name: body.item.name });
    router.refresh();
  }

  if (created) return <Reveal created={created} onClose={onClose} />;

  return (
    <>
      <DrawerHeader
        icon={<KeyRound />}
        kind={t('new.kind')}
        title={t('new.title')}
        extra={<p className="t-sm text-text-2">{t('new.help')}</p>}
      />
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem === null) void create();
        }}
      >
        <DrawerBody>
          {error ? <Alert variant="destructive">{error}</Alert> : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem]">
            <Field label={t('field.name')} help={t('field.name.hint')} htmlFor="token-name">
              <Input
                id="token-name"
                value={name}
                maxLength={80}
                placeholder={t('field.name.placeholder')}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
            <Field
              label={t('field.expiry')}
              help={expiry === 'never' ? t('expiry.never.hint') : undefined}
              htmlFor="token-expiry"
            >
              <Select
                id="token-expiry"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value as Expiry)}
              >
                <option value="30">{t('expiry.30')}</option>
                <option value="90">{t('expiry.90')}</option>
                <option value="365">{t('expiry.365')}</option>
                <option value="never">{t('expiry.never')}</option>
              </Select>
            </Field>
          </div>

          <DrawerSection title={t('field.permissions')}>
            <RadioGroup aria-label={t('field.permissions')}>
              {(['deploy', 'read', 'custom'] as const).map((value) => (
                <RadioOption
                  key={value}
                  name="token-preset"
                  value={value}
                  checked={preset === value}
                  disabled={value !== 'custom' && presets[value].length === 0}
                  onChange={() => setPreset(value)}
                  label={t(`preset.${value}`)}
                />
              ))}
            </RadioGroup>
            <p className="t-cap text-text-3">{t(`preset.${preset}.hint`)}</p>
            {preset === 'custom' ? (
              <PermissionGroups
                groups={groups}
                selected={custom}
                editable
                onToggle={(key) =>
                  setCustom((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                onToggleGroup={(group, checked) =>
                  setCustom((current) => {
                    const next = new Set(current);
                    for (const permission of group.permissions) {
                      if (checked) next.add(permission.key);
                      else next.delete(permission.key);
                    }
                    return next;
                  })
                }
              />
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {permissions.map((key) => (
                  <li
                    key={key}
                    className="mono t-cap rounded-md bg-surface-2 px-1.5 py-0.5 text-text-2"
                  >
                    {key}
                  </li>
                ))}
              </ul>
            )}
          </DrawerSection>

          <DrawerSection title={t('field.applications')}>
            <div className="flex flex-col gap-2">
              <Radio
                name="token-scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
                label={t('applications.all')}
                help={t('applications.all.hint')}
              />
              <Radio
                name="token-scope"
                checked={scope === 'some'}
                onChange={() => setScope('some')}
                label={t('applications.some')}
                help={t('applications.some.hint')}
                disabled={applications.length === 0}
              />
            </div>
            {scope === 'some' ? (
              applications.length === 0 ? (
                <p className="t-cap text-text-3">{t('applications.none')}</p>
              ) : (
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {applications.map((application) => (
                    <CheckboxField
                      key={application.id}
                      label={application.name}
                      checked={chosen.has(application.id)}
                      onChange={() =>
                        setChosen((current) => {
                          const next = new Set(current);
                          if (next.has(application.id)) next.delete(application.id);
                          else next.add(application.id);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
              )
            ) : null}
          </DrawerSection>
        </DrawerBody>

        <DrawerFooter
          end={
            <span className="t-cap text-text-3">
              {t('new.selected', { count: permissions.length })}
            </span>
          }
        >
          <Button type="submit" loading={pending} disabledReason={problem}>
            {pending ? c('creating') : t('new.create')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {c('cancel')}
          </Button>
        </DrawerFooter>
      </form>
    </>
  );
}

/** Le jeton, une seule fois, et de quoi s'en servir. */
function Reveal({
  created,
  onClose,
}: {
  created: { token: string; name: string };
  onClose: () => void;
}) {
  const t = useT(messages);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const example = [
    `curl -X POST ${origin}/api/deployments \\`,
    '  -H "Authorization: Bearer $PUPITRE_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"applicationId":"…","targetId":"…","runtime":"docker",`,
    `       "images":{"web":"ghcr.io/acme/web:'"$GITHUB_SHA"'"}}'`,
  ].join('\n');

  async function copy(): Promise<void> {
    // Le presse-papiers peut être refusé (contexte non sécurisé) : le jeton
    // reste affiché, sélectionnable à la main.
    try {
      await navigator.clipboard.writeText(created.token);
      toast({ title: t('reveal.copied'), tone: 'ok' });
    } catch {
      /* rien à signaler : le jeton est à l'écran */
    }
  }

  return (
    <>
      <DrawerHeader
        icon={<KeyRound />}
        kind={t('new.kind')}
        title={t('reveal.title', { name: created.name })}
      />
      <DrawerBody>
        <Alert variant="warn">{t('reveal.warning')}</Alert>
        {/* `Field` donne son identifiant à son enfant direct : le champ seul y
            entre, le bouton reste à côté. */}
        <div className="flex items-end gap-2">
          <Field label={t('reveal.label')} htmlFor="token-value" className="min-w-0 flex-1">
            <Input
              readOnly
              value={created.token}
              className="mono"
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          <Button type="button" variant="secondary" onClick={() => void copy()}>
            <Copy aria-hidden />
            {t('reveal.copy')}
          </Button>
        </div>
        <DrawerSection title={t('reveal.example')}>
          <p className="t-sm text-text-2">{t('reveal.example.hint')}</p>
          <pre className="codeblock mono t-cap overflow-x-auto whitespace-pre">{example}</pre>
        </DrawerSection>
      </DrawerBody>
      <DrawerFooter>
        <Button type="button" onClick={onClose}>
          {t('reveal.done')}
        </Button>
      </DrawerFooter>
    </>
  );
}
