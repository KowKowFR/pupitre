'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { BookOpen, Copy, KeyRound } from 'lucide-react';
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
import { copyText } from '@/lib/secure-origin';
import { isLoopbackHost } from '@/lib/secure-transport';

type Preset = 'deploy' | 'read' | 'all' | 'custom';
type Expiry = '30' | '90' | '365' | 'never';

/** What a CI does with a deployment, end to end: start it, follow it, come back from it. */
const DEPLOY_PRESET: readonly Permission[] = [
  'deployment:create',
  'deployment:read',
  'deployment:rollback',
  'application:read',
  'application:update',
];

/**
 * "New token": a name, an expiry, what it can do, on which applications. The
 * permissions offered are the person's, and theirs alone: one only delegates
 * what one has.
 *
 * Once created, the drawer shows the token **only once**, with what it takes to
 * use it. Closing the drawer makes it disappear for good.
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
      // An agent driven through MCP does what one asks it, not one gesture: it
      // gets what its author has — and still loses what they lose.
      all: [...held],
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
              {(['deploy', 'read', 'all', 'custom'] as const).map((value) => (
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

/** The token, only once, and what it takes to use it. */
function Reveal({
  created,
  onClose,
}: {
  created: { token: string; name: string };
  onClose: () => void;
}) {
  const t = useT(messages);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  // The MCP server refuses plain HTTP outside the machine itself: say so now,
  // rather than let the agent's first call fail.
  const insecure =
    typeof window !== 'undefined' &&
    window.location.protocol === 'http:' &&
    !isLoopbackHost(window.location.hostname.replace(/^\[|\]$/g, ''));
  const example = [
    `curl -X POST ${origin}/api/deployments \\`,
    '  -H "Authorization: Bearer $PUPITRE_TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"applicationId":"…","targetId":"…","runtime":"docker",`,
    `       "images":{"web":"ghcr.io/acme/web:'"$GITHUB_SHA"'"}}'`,
  ].join('\n');
  // One line, the token written in it, between double quotes: the same command
  // pastes into bash, zsh, PowerShell and cmd — no variable, no line continuation,
  // whose syntax differs from one shell to the other. A token only carries
  // `[A-Za-z0-9_-]`: nothing a shell would interpret.
  const mcpCommand = `claude mcp add --transport http pupitre ${origin}/api/mcp --header "Authorization: Bearer ${created.token}"`;
  const mcpConfig = JSON.stringify(
    {
      mcpServers: {
        pupitre: {
          type: 'http',
          url: `${origin}/api/mcp`,
          headers: { Authorization: 'Bearer ${PUPITRE_TOKEN}' },
        },
      },
    },
    null,
    2,
  );

  async function copy(): Promise<void> {
    // Not copied: the token stays on screen, selectable by hand.
    if (await copyText(created.token)) toast({ title: t('reveal.copied'), tone: 'ok' });
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
        {/* `Field` gives its identifier to its direct child: only the input goes in,
            the button stays beside it. */}
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
          <Snippet text={example} />
        </DrawerSection>
        <DrawerSection title={t('reveal.mcp')}>
          {insecure ? <Alert variant="warn">{t('reveal.mcp.insecure')}</Alert> : null}
          <p className="t-sm text-text-2">{t('reveal.mcp.hint')}</p>
          <Snippet text={mcpCommand} />
          <p className="t-sm text-text-2">{t('reveal.mcp.config')}</p>
          <Snippet text={mcpConfig} />
          <Link href="/docs/mcp" className="link t-sm inline-flex items-center gap-1">
            <BookOpen aria-hidden className="size-3.5" />
            {t('reveal.mcp.docs')}
          </Link>
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

/**
 * An example to paste, with its copy button — in a bar above the code, as in
 * the documentation, so that a long line never runs under the button.
 */
function Snippet({ text }: { text: string }) {
  const t = useT(messages);
  return (
    <div className="doc-code">
      <div className="doc-code-head">
        <span />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (await copyText(text)) toast({ title: t('reveal.exampleCopied'), tone: 'ok' });
          }}
        >
          <Copy aria-hidden />
          {t('reveal.copyExample')}
        </Button>
      </div>
      <pre className="codeblock mono t-cap overflow-x-auto whitespace-pre">{text}</pre>
    </div>
  );
}
