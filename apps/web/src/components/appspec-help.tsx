'use client';

import * as React from 'react';
import { CircleHelp } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { appspecHelp as messages } from '@/i18n/messages/appspec-help';
import { cn } from '@/lib/utils';

/**
 * Aide sur l'AppSpec — contenu statique, aucune donnée serveur.
 *
 * Le composant `ui/dialog.tsx` reste neutre et réutilisable ; tout ce qui parle
 * d'AppSpec vit ici. Le contenu suit `packages/core/src/spec/app-spec.ts` et les
 * deux rendus `drivers/docker/render.ts` et `drivers/k3s/render.ts` : chaque
 * contrainte citée est celle du schéma Zod, pas une approximation.
 */

type Props = {
  /** Libellé du déclencheur. Le défaut convient à la plupart des pages. */
  label?: string;
  className?: string;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.8em]">
      {children}
    </code>
  );
}

const MARKUP = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

/**
 * Rend une phrase du dictionnaire qui alterne prose et identifiants.
 *
 * Les accents graves encadrent un nom de champ ou une valeur du format, `**` un
 * passage appuyé, `*` une insistance. Sans ce petit rendu, chaque phrase de
 * cette page devrait être coupée en trois ou quatre clés autour de ses
 * `<Code>` — un dictionnaire de fragments, illisible et intraduisible. Le
 * balisage ne sort jamais du dictionnaire : il n'atteint ni la base ni l'API.
 */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(MARKUP).map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return <Code key={index}>{part.slice(1, -1)}</Code>;
        }
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={index} className="text-foreground font-medium">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return <em key={index}>{part.slice(1, -1)}</em>;
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

/** Un tableau large ne doit jamais élargir la modale : il défile chez lui. */
function ScrollableTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

/**
 * Les champs du format. Le **nom** est une clé JSON, il n'est pas traduit ; les
 * deux autres colonnes sont des clés du dictionnaire.
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

export function AppSpecHelpDialog({ label, className }: Props) {
  const t = useT(messages);
  const tc = useT(common);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={cn('btn btn-ghost', className)}>
          <CircleHelp aria-hidden />
          {label ?? t('trigger')}
        </button>
      </DialogTrigger>

      <DialogContent size="xwide">
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>
            <Rich text={t('dialog.description')} />
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 text-sm">
          <Section title={t('section.idea')}>
            <p className="text-muted-foreground">
              <Rich text={t('idea.p1')} />
            </p>
            <p className="text-muted-foreground">
              <Rich text={t('idea.p2')} />
            </p>
          </Section>

          <Section title={t('section.fields')}>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('fields.column.name')}</th>
                  <th className="px-3 py-2 font-medium">{t('fields.column.role')}</th>
                  <th className="px-3 py-2 font-medium">{t('fields.column.constraint')}</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((field) => (
                  <tr key={field.name} className="border-t align-top">
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{field.name}</td>
                    <td className="text-muted-foreground px-3 py-2">
                      <Rich text={t(`field.${field.key}.role`)} />
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      <Rich text={t(`field.${field.key}.constraint`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <p className="text-muted-foreground text-xs">{t('fields.note')}</p>
          </Section>

          <Section title={t('section.guards')}>
            <p className="text-muted-foreground">{t('guards.intro')}</p>
            <ol className="space-y-2">
              {/*
                Texte brut, sans `<Rich>` : ces énoncés portent déjà des accents
                graves, affichés tels quels — c'est leur ponctuation, pas du
                balisage.
              */}
              {GUARDS.map((guard, index) => (
                <li key={guard} className="flex gap-3">
                  <span className="bg-muted text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  <div className="space-y-0.5">
                    <div className="text-foreground font-medium">{t(`guard.${guard}.rule`)}</div>
                    <p className="text-muted-foreground text-xs">{t(`guard.${guard}.why`)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section title={t('section.mapping')}>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('mapping.column.spec')}</th>
                  <th className="px-3 py-2 font-medium">{t('mapping.column.docker')}</th>
                  <th className="px-3 py-2 font-medium">{t('mapping.column.k3s')}</th>
                </tr>
              </thead>
              <tbody>
                {MAPPING.map((row) => (
                  <tr key={row} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Rich text={t(`mapping.${row}.field`)} />
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      <Rich text={t(`mapping.${row}.docker`)} />
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      <Rich text={t(`mapping.${row}.k3s`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">
                <Rich text={t('mapping.note')} />
              </p>
            </div>
          </Section>

          <Section title={t('section.simple')}>
            <p className="text-muted-foreground">
              <Rich text={t('simple.intro')} />
            </p>
            <pre className="codeblock">
              <code>{t('example.simple')}</code>
            </pre>
          </Section>

          <Section title={t('section.full')}>
            <p className="text-muted-foreground">{t('full.intro')}</p>
            <pre className="codeblock">
              <code>{t('example.full')}</code>
            </pre>
            <p className="text-muted-foreground text-xs">
              <Rich text={t('full.note')} />
            </p>
          </Section>
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" type="button">
              {tc('close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
