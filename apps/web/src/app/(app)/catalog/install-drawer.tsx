'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUpRight, Dices } from 'lucide-react';
import { SERVICE_NAME_PATTERN } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerSection,
} from '@/components/ui/drawer';
import { Field, SecretInput } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SwitchField } from '@/components/ui/switch';
import { useT } from '@/i18n/client';
import { catalog as messages } from '@/i18n/messages/catalog';
import { common } from '@/i18n/messages/common';
import { toast } from '@/lib/toast';
import { ServiceList } from '../applications/service-list';
import { CATEGORY_ICON, Monogram, type TemplateView } from './catalog-view';
import { copyText } from '@/lib/secure-origin';

type ApiError = { error?: { message?: string } };

/** The first free name: `uptime-kuma`, otherwise `uptime-kuma-2`, `uptime-kuma-3`… */
function freeName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** A password drawn in the browser: 20 base64url characters. */
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A template's drawer: what it does, what will run, what will have to be done at
 * first access — then the installation, which creates the application without
 * deploying it. The deployment follows, from the application's overview.
 */
export function InstallDrawer({
  template,
  taken,
  onClose,
  onPrevious,
  onNext,
}: {
  template: TemplateView | null;
  taken: string[];
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const t = useT(messages);
  const Icon = template ? CATEGORY_ICON[template.category] : null;
  return (
    <Drawer
      open={template !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
      onPrevious={onPrevious}
      onNext={onNext}
      wide
      label={template?.name}
    >
      {template && Icon ? (
        <>
          <DrawerHeader
            icon={<Icon className="size-4" />}
            kind={t('drawer.kind')}
            route={template.id}
            title={
              <span className="flex items-center gap-3">
                <Monogram name={template.name} size="lg" />
                {template.name}
              </span>
            }
            state={
              <>
                <Badge variant="outline">{t(`category.${template.category}`)}</Badge>
                <a
                  href={template.website}
                  target="_blank"
                  rel="noreferrer"
                  className="link inline-flex items-center gap-1"
                >
                  {t('drawer.website')}
                  <ArrowUpRight aria-hidden className="size-3" />
                </a>
              </>
            }
            extra={<p className="t-sm text-text-2">{template.summary}</p>}
          />
          <InstallForm key={template.id} template={template} taken={taken} onCancel={onClose} />
        </>
      ) : null}
    </Drawer>
  );
}

function InstallForm({
  template,
  taken,
  onCancel,
}: {
  template: TemplateView;
  taken: string[];
  onCancel: () => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [name, setName] = useState(() => freeName(template.id, taken));
  const [host, setHost] = useState('');
  const [tls, setTls] = useState(true);
  const [secrets, setSecrets] = useState<Record<string, string>>(() =>
    Object.fromEntries(template.askedSecrets.map((secret) => [secret, ''])),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameTaken = taken.includes(name);
  const nameValid = name.length >= 2 && name.length <= 48 && SERVICE_NAME_PATTERN.test(name);
  const missingSecret = template.askedSecrets.find((secret) => !secrets[secret]?.trim());
  const invalid = !nameValid
    ? t('invalid.name')
    : nameTaken
      ? t('field.name.taken')
      : missingSecret
        ? t('invalid.secret', { name: missingSecret })
        : null;

  async function generate(secret: string) {
    const value = randomPassword();
    setSecrets((current) => ({ ...current, [secret]: value }));
    // Not copied: the value stays in the field, which the Show button reveals.
    if (await copyText(value)) {
      toast({ title: t('field.secret.copied'), description: secret, tone: 'ok' });
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) return;
    setPending(true);
    setError(null);
    const response = await fetch(`/api/catalog/${template.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, host: host.trim() || null, tls, secrets }),
    });
    if (!response.ok) {
      setPending(false);
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    const created = (await response.json()) as { id: string; slug: string };
    const deployHref = `/applications?app=${encodeURIComponent(created.slug)}&deploy=1`;
    toast({
      title: t('toast.installed', { name: template.name }),
      description: t('toast.installed.detail'),
      tone: 'ok',
      action: { label: t('toast.deploy'), href: deployHref },
    });
    router.push(deployHref);
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DrawerBody>
        <DrawerSection title={t('drawer.section.run')}>
          <ServiceList
            application={{
              services: template.services,
              ingress: host.trim()
                ? {
                    host: host.trim(),
                    service: template.services.find((service) => service.exposed)?.name ?? '',
                    tls,
                  }
                : null,
            }}
          />
        </DrawerSection>

        <DrawerSection title={t('drawer.section.images')}>
          <span className="flex flex-wrap gap-1.5">
            {template.images.map((image) => (
              <CodeBadge key={image}>{image}</CodeBadge>
            ))}
          </span>
          <p className="help">{t('drawer.images.note')}</p>
        </DrawerSection>

        <DrawerSection title={t('drawer.section.firstRun')}>
          <Alert variant="info">{template.firstRun}</Alert>
        </DrawerSection>

        <DrawerSection title={t('drawer.section.install')}>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('field.name')}
              help={t('field.name.help')}
              error={nameTaken ? t('field.name.taken') : undefined}
            >
              <Input
                className="mono"
                value={name}
                maxLength={48}
                spellCheck={false}
                onChange={(event) => setName(event.target.value.toLowerCase())}
              />
            </Field>
            <Field label={t('field.host')} help={t('field.host.help')} optional>
              <Input
                className="mono"
                value={host}
                spellCheck={false}
                placeholder={`${template.id}.exemple.fr`}
                onChange={(event) => setHost(event.target.value)}
              />
            </Field>
          </div>
          {host.trim() ? (
            <SwitchField
              label={t('field.tls')}
              help={t('field.tls.help')}
              checked={tls}
              onChange={(event) => setTls(event.target.checked)}
            />
          ) : template.wantsHost ? (
            <Alert variant="warn">{t('field.host.wanted')}</Alert>
          ) : null}

          {template.askedSecrets.map((secret) => (
            <Field
              key={secret}
              // The control is wrapped (field + button): the identifier is set by hand so that
              // the label does designate the field.
              htmlFor={`secret-${secret}`}
              label={<span className="mono">{secret}</span>}
              help={t('field.secret.help')}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <SecretInput
                    id={`secret-${secret}`}
                    value={secrets[secret] ?? ''}
                    onChange={(event) =>
                      setSecrets((current) => ({ ...current, [secret]: event.target.value }))
                    }
                  />
                </span>
                <Button type="button" variant="secondary" onClick={() => void generate(secret)}>
                  <Dices aria-hidden />
                  {t('field.secret.generate')}
                </Button>
              </span>
            </Field>
          ))}
          {template.generatedSecrets > 0 ? (
            <p className="help">{t('secrets.generated', { count: template.generatedSecrets })}</p>
          ) : null}
        </DrawerSection>
      </DrawerBody>
      <DrawerFooter end={null}>
        <Button type="submit" loading={pending} disabledReason={invalid}>
          {pending ? t('submit.pending') : t('submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tc('cancel')}
        </Button>
      </DrawerFooter>
    </form>
  );
}
