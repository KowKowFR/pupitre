'use client';

import type { ConfigField } from '@tp/core';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';

/**
 * Les champs de configuration d'une sonde, rendus **depuis le catalogue**.
 *
 * C'est le test de l'abstraction côté écran : ce composant ne connaît ni `http`,
 * ni `tls`, ni aucun nom de champ. Il sait rendre cinq formes — URL, hôte,
 * texte, nombre, liste — et le catalogue lui dit lesquelles, dans quel ordre,
 * avec quelles bornes. Ajouter un type de surveillance n'amène pas ici.
 *
 * Les champs marqués `advanced` sont repliés : un formulaire de création ne doit
 * demander que l'essentiel, et proposer le reste à qui le cherche.
 */

export type ConfigValues = Record<string, unknown>;

function fieldValue(values: ConfigValues, field: ConfigField): string {
  const raw = values[field.key];
  if (raw === null || raw === undefined) return '';
  return String(raw);
}

function readBack(field: ConfigField, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return field.optional ? null : '';
  if (field.kind === 'number') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  return trimmed;
}

function FieldControl({
  field,
  values,
  onChange,
  idPrefix,
}: {
  field: ConfigField;
  values: ConfigValues;
  onChange: (key: string, value: unknown) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-${field.key}`;
  const value = fieldValue(values, field);
  const handle = (raw: string): void => onChange(field.key, readBack(field, raw));

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.optional ? <span className="text-ink-faint normal-case">— facultatif</span> : null}
      </Label>

      {field.kind === 'select' ? (
        <Select id={id} value={value} onChange={(event) => handle(event.target.value)}>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ) : field.kind === 'number' ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={value}
            onChange={(event) => handle(event.target.value)}
          />
          {field.unit ? (
            <span className="shrink-0 text-xs text-ink-faint">{field.unit}</span>
          ) : null}
        </div>
      ) : (
        <Input
          id={id}
          type={field.kind === 'url' ? 'url' : 'text'}
          inputMode={field.kind === 'url' || field.kind === 'host' ? 'url' : 'text'}
          placeholder={'placeholder' in field ? field.placeholder : undefined}
          value={value}
          onChange={(event) => handle(event.target.value)}
        />
      )}

      {field.hint ? <p className="text-[0.6875rem] text-ink-faint">{field.hint}</p> : null}
    </div>
  );
}

export function ConfigFields({
  fields,
  values,
  onChange,
  idPrefix,
}: {
  fields: readonly ConfigField[];
  values: ConfigValues;
  onChange: (key: string, value: unknown) => void;
  idPrefix: string;
}) {
  const plain = fields.filter((field) => field.advanced !== true);
  const advanced = fields.filter((field) => field.advanced === true);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {plain.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            values={values}
            onChange={onChange}
            idPrefix={idPrefix}
          />
        ))}
      </div>

      {advanced.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="eyebrow text-ink-muted hover:text-ink">
            Options avancées
          </CollapsibleTrigger>
          <CollapsiblePanel className="grid gap-4 pt-3 sm:grid-cols-2">
            {advanced.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                values={values}
                onChange={onChange}
                idPrefix={idPrefix}
              />
            ))}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** Valeurs de départ d'un type, telles que le catalogue les donne. */
export function defaultsOf(defaults: unknown): ConfigValues {
  return defaults !== null && typeof defaults === 'object'
    ? { ...(defaults as ConfigValues) }
    : {};
}

/** Retire les champs vides avant l'envoi : Zod appliquera ses propres défauts. */
export function cleanConfig(values: ConfigValues): ConfigValues {
  const out: ConfigValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}
