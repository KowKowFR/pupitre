'use client';

import { ArrowLeftRight, Braces, FileCode, Lightbulb, ShieldCheck } from 'lucide-react';
import {
  HelpBlock,
  HelpCallout,
  HelpDrawer,
  HelpSection,
  HelpSteps,
  HelpTable,
  rich,
} from '@/components/help-drawer';
import { useT } from '@/i18n/client';
import { appspecHelp as messages } from '@/i18n/messages/appspec-help';

/**
 * Help on the AppSpec — static content, no server data.
 *
 * A help kit drawer (`components/help-drawer.tsx`); everything that talks about
 * the AppSpec lives here. The content follows `packages/core/src/spec/app-spec.ts`
 * and the two renderings `drivers/docker/render.ts` and `drivers/k3s/render.ts`:
 * each quoted constraint is the Zod schema's, not an approximation.
 */

type Props = {
  /** The trigger's label. The default suits most pages. */
  label?: string;
  className?: string;
};

/**
 * The format's fields. The **name** is a JSON key, it is not translated; the two
 * other columns are dictionary keys.
 */
const FIELDS = [
  { name: 'name', key: 'name' },
  { name: 'version', key: 'version' },
  { name: 'services[]', key: 'services' },
  { name: 'services[].name', key: 'serviceName' },
  { name: 'services[].source', key: 'source' },
  { name: 'services[].port', key: 'port' },
  { name: 'services[].exposed', key: 'exposed' },
  { name: 'services[].replicas', key: 'replicas' },
  { name: 'services[].env', key: 'env' },
  { name: 'services[].secrets', key: 'secrets' },
  { name: 'services[].resources', key: 'resources' },
  { name: 'services[].healthcheck', key: 'healthcheck' },
  { name: 'services[].volumes', key: 'volumes' },
  { name: 'services[].dependsOn', key: 'dependsOn' },
  { name: 'ingress', key: 'ingress' },
] as const;

const GUARDS = ['exposed', 'uniqueNames', 'dependsOn', 'cycle', 'ingress', 'envSecret'] as const;

const MAPPING = [
  'name',
  'version',
  'services',
  'sourceImage',
  'sourceDockerfile',
  'port',
  'exposed',
  'replicas',
  'env',
  'secrets',
  'resources',
  'healthcheck',
  'volumes',
  'dependsOn',
  'ingress',
] as const;

export function AppSpecHelp({ label, className }: Props) {
  const t = useT(messages);

  return (
    <HelpDrawer
      triggerLabel={label ?? t('trigger')}
      title={t('dialog.title')}
      description={rich(t('dialog.description'))}
      className={className}
    >
      <HelpSection icon={Lightbulb} title={t('section.idea')}>
        <p>{rich(t('idea.p1'))}</p>
        <HelpCallout tone="accent">{rich(t('idea.p2'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={Braces} title={t('section.fields')}>
        <HelpTable
          columns={[
            { key: 'name', label: t('fields.column.name'), nowrap: true },
            { key: 'role', label: t('fields.column.role') },
            { key: 'constraint', label: t('fields.column.constraint'), tone: 'warn' },
          ]}
          rows={FIELDS.map((field) => ({
            key: field.name,
            cells: [
              <code key="name" className="mono text-[12px]">
                {field.name}
              </code>,
              rich(t(`field.${field.key}.role`)),
              rich(t(`field.${field.key}.constraint`)),
            ],
          }))}
        />
        <HelpCallout tone="neutral">{t('fields.note')}</HelpCallout>
      </HelpSection>

      <HelpSection icon={ShieldCheck} tone="ok" title={t('section.guards')}>
        <p>{t('guards.intro')}</p>
        {/*
          Plain text, without `rich()`: these statements already carry
          backticks, shown as is — it is their punctuation, not markup.
                 */}
        <HelpSteps
          tone="ok"
          steps={GUARDS.map((guard) => ({
            key: guard,
            title: t(`guard.${guard}.rule`),
            body: t(`guard.${guard}.why`),
          }))}
        />
      </HelpSection>

      <HelpSection icon={ArrowLeftRight} title={t('section.mapping')}>
        <HelpTable
          columns={[
            { key: 'spec', label: t('mapping.column.spec'), nowrap: true },
            { key: 'docker', label: t('mapping.column.docker'), tone: 'accent' },
            { key: 'k3s', label: t('mapping.column.k3s'), tone: 'ok' },
          ]}
          rows={MAPPING.map((row) => ({
            key: row,
            cells: [
              rich(t(`mapping.${row}.field`)),
              rich(t(`mapping.${row}.docker`)),
              rich(t(`mapping.${row}.k3s`)),
            ],
          }))}
        />
        <HelpCallout tone="accent">{rich(t('mapping.note'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={FileCode} title={t('section.simple')}>
        <p>{rich(t('simple.intro'))}</p>
        <HelpBlock>{t('example.simple')}</HelpBlock>
      </HelpSection>

      <HelpSection icon={FileCode} title={t('section.full')}>
        <p>{t('full.intro')}</p>
        <HelpBlock>{t('example.full')}</HelpBlock>
        <HelpCallout tone="accent">{rich(t('full.note'))}</HelpCallout>
      </HelpSection>
    </HelpDrawer>
  );
}
