'use client';

import * as React from 'react';
import {
  CircleCheck,
  CircleHelp,
  Info,
  Lightbulb,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { cn } from '@/lib/utils';

/**
 * Le kit des aides du panel : un tiroir large, et de quoi y expliquer.
 *
 * Une aide se lit à côté de ce qu'elle explique — le formulaire reste visible
 * derrière le tiroir, ce qu'une modale centrée ne permettait pas. Et la couleur
 * y porte un sens constant, le même dans toutes les aides :
 *
 *   — `accent` : une idée à retenir, un conseil, une étape ;
 *   — `ok`     : ce qui est sûr, ce qui marche, ce que le panel garantit ;
 *   — `warn`   : un piège, ce qui se fait mal facilement ;
 *   — `danger` : une panne, un symptôme, ce qui casse.
 *
 * Chaque bloc porte aussi une icône et un texte : la couleur appuie, elle ne
 * dit jamais seule.
 */

export type HelpTone = 'accent' | 'ok' | 'warn' | 'danger' | 'neutral';

const TONE: Record<HelpTone, { box: string; icon: string; chip: string; Icon: LucideIcon }> = {
  accent: {
    box: 'border-accent-line bg-accent-soft',
    icon: 'text-accent-text',
    chip: 'bg-accent-soft text-accent-text border-accent-line',
    Icon: Lightbulb,
  },
  ok: {
    box: 'border-ok-line bg-ok-soft',
    icon: 'text-ok-text',
    chip: 'bg-ok-soft text-ok-text border-ok-line',
    Icon: CircleCheck,
  },
  warn: {
    box: 'border-warn-line bg-warn-soft',
    icon: 'text-warn-text',
    chip: 'bg-warn-soft text-warn-text border-warn-line',
    Icon: TriangleAlert,
  },
  danger: {
    box: 'border-danger-line bg-danger-soft',
    icon: 'text-danger-text',
    chip: 'bg-danger-soft text-danger-text border-danger-line',
    Icon: OctagonAlert,
  },
  neutral: {
    box: 'border-border bg-surface-2',
    icon: 'text-text-3',
    chip: 'bg-surface-3 text-text-2 border-border',
    Icon: Info,
  },
};

/** Le déclencheur et le tiroir. Le contenu n'est monté qu'à l'ouverture. */
export function HelpDrawer({
  triggerLabel,
  title,
  description,
  className,
  children,
}: {
  triggerLabel: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const tc = useT(common);
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        className={cn('btn btn-ghost', className)}
        onClick={() => setOpen(true)}
      >
        <CircleHelp aria-hidden />
        {triggerLabel}
      </button>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        wide
        label={typeof title === 'string' ? title : undefined}
      >
        {open ? (
          <>
            <DrawerHeader
              icon={<CircleHelp />}
              kind={tc('help')}
              title={title}
              extra={description ? <p className="t-sm text-text-2">{description}</p> : null}
            />
            <DrawerBody className="gap-8">{children}</DrawerBody>
            <DrawerFooter end={null}>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {tc('close')}
              </Button>
            </DrawerFooter>
          </>
        ) : null}
      </Drawer>
    </>
  );
}

/** Une section : une pastille d'icône à la teinte du propos, un titre, un corps. */
export function HelpSection({
  icon: Icon,
  tone = 'accent',
  title,
  children,
}: {
  icon: LucideIcon;
  tone?: HelpTone;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 text-[13.5px] leading-[21px]">
      <h3 className="flex items-center gap-2.5 text-[15px] leading-6 font-semibold text-text">
        <span
          aria-hidden
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-lg border',
            TONE[tone].chip,
          )}
        >
          <Icon className="size-4" />
        </span>
        {title}
      </h3>
      <div className="flex flex-col gap-3 text-text-2">{children}</div>
    </section>
  );
}

/** Un encadré coloré : conseil, garantie, piège ou panne — l'icône le dit aussi. */
export function HelpCallout({
  tone,
  title,
  children,
}: {
  tone: HelpTone;
  title?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { box, icon, Icon } = TONE[tone];
  return (
    <div className={cn('flex gap-3 rounded-[10px] border px-3.5 py-3', box)}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', icon)} />
      <div className="flex min-w-0 flex-col gap-1 text-[13px] leading-5 text-text-2">
        {title ? <p className="font-semibold text-text">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** Des étapes numérotées, reliées par un filet : l'ordre compte, il se voit. */
export function HelpSteps({
  steps,
  tone = 'accent',
}: {
  steps: ReadonlyArray<{ key: string; title: React.ReactNode; body?: React.ReactNode }>;
  tone?: HelpTone;
}) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <li key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
          {index < steps.length - 1 ? (
            <span aria-hidden className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />
          ) : null}
          <span
            className={cn(
              'relative grid size-7 shrink-0 place-items-center rounded-full border text-[12px] font-semibold tabular-nums',
              TONE[tone].chip,
            )}
          >
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5 pt-1">
            <div className="font-medium text-text">{step.title}</div>
            {step.body ? (
              <div className="text-[13px] leading-5 text-text-2">{step.body}</div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Une liste à puces teintées. */
export function HelpList({
  items,
  tone = 'accent',
}: {
  items: ReadonlyArray<{ key: string; content: React.ReactNode }>;
  tone?: HelpTone;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.key} className="flex gap-2.5">
          <span
            aria-hidden
            className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', {
              'bg-accent': tone === 'accent',
              'bg-ok': tone === 'ok',
              'bg-warn': tone === 'warn',
              'bg-danger': tone === 'danger',
              'bg-text-3': tone === 'neutral',
            })}
          />
          <span className="min-w-0">{item.content}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Un tableau d'aide. Il défile chez lui plutôt que d'élargir le tiroir. Une
 * colonne peut porter une teinte d'en-tête, pour opposer deux côtés (le panel
 * et la cible, Docker et K3s).
 */
export function HelpTable({
  columns,
  rows,
}: {
  columns: ReadonlyArray<{
    key: string;
    label: React.ReactNode;
    tone?: HelpTone;
    nowrap?: boolean;
  }>;
  rows: ReadonlyArray<{ key: string; cells: React.ReactNode[] }>;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-[12.5px] leading-[19px]">
        <thead>
          <tr className="bg-surface-2">
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 font-medium text-text-2">
                {column.tone ? (
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md border px-2 py-0.5 text-[12px] font-semibold',
                      TONE[column.tone].chip,
                    )}
                  >
                    {column.label}
                  </span>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-border-subtle align-top">
              {row.cells.map((cell, index) => (
                <td
                  key={columns[index]?.key ?? index}
                  className={cn(
                    'px-3 py-2',
                    index === 0 ? 'font-medium text-text' : 'text-text-2',
                    columns[index]?.nowrap && 'whitespace-nowrap',
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Un bout de code en ligne. */
export function HelpCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="mono rounded bg-surface-3 px-1 py-0.5 text-[0.85em] text-text">
      {children}
    </code>
  );
}

/** Un bloc de commandes ou de JSON, à copier tel quel. */
export function HelpBlock({ children }: { children: string }) {
  return (
    <pre className="codeblock">
      <code>{children}</code>
    </pre>
  );
}

/**
 * Le balisage en ligne des dictionnaires d'aide, rendu : `` `code` ``,
 * `**gras**`, `__gras de tête__`, `*italique*`. Une entrée de dictionnaire est
 * une chaîne ; ces quatre marques évitent de découper chaque phrase en
 * fragments que le traducteur devrait réassembler. Récursif, parce qu'un gras
 * contient parfois du code ; le contenu d'un `` `…` `` ne l'est pas.
 */
const INLINE = /(`[^`]+`|__[^_]+__|\*\*[^*]+\*\*|\*[^*]+\*)/;

export function rich(text: string): React.ReactNode {
  return text.split(INLINE).map((part, index) => {
    if (!part) return null;
    if (part.startsWith('`')) return <HelpCode key={index}>{part.slice(1, -1)}</HelpCode>;
    if (part.startsWith('__') || part.startsWith('**')) {
      return (
        <strong key={index} className="font-medium text-text">
          {rich(part.slice(2, -2))}
        </strong>
      );
    }
    if (part.startsWith('*')) return <em key={index}>{rich(part.slice(1, -1))}</em>;
    return part;
  });
}
