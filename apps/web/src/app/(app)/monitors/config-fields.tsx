'use client';

import type { ConfigField } from '@pupitre/core';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useT } from '@/i18n/client';
import { monitors as messages } from '@/i18n/messages/monitors';

/**
 * A probe's configuration fields, rendered **from the catalog**.
 *
 * It is the abstraction's test on the screen side: this component knows neither
 * `http`, nor `tls`, nor any field name. It knows how to render five shapes — URL,
 * host, text, number, list — and the catalog tells it which ones, in which order,
 * with which bounds. Adding a monitoring type does not lead here.
 *
 * The fields marked `advanced` are folded: a creation form must only ask for the
 * essentials, and offer the rest to whoever looks for it.
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
  const t = useT(messages);
  const id = `${idPrefix}-${field.key}`;
  const value = fieldValue(values, field);
  const handle = (raw: string): void => onChange(field.key, readBack(field, raw));

  return (
    <div className="field">
      <Label htmlFor={id}>
        {field.label}
        {field.optional ? <span className="opt">{t('config.optional')}</span> : null}
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
          {field.unit ? <span className="t-cap shrink-0 text-text-3">{field.unit}</span> : null}
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

      {field.hint ? <p className="help">{field.hint}</p> : null}
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
  const t = useT(messages);
  const plain = fields.filter((field) => field.advanced !== true);
  const advanced = fields.filter((field) => field.advanced === true);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <CollapsibleTrigger className="t-sm font-medium text-text-2 hover:text-text">
            {t('config.advanced')}
          </CollapsibleTrigger>
          <CollapsiblePanel className="grid grid-cols-1 gap-4 pt-3 sm:grid-cols-2">
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

/** A type's starting values, as the catalog gives them. */
export function defaultsOf(defaults: unknown): ConfigValues {
  return defaults !== null && typeof defaults === 'object' ? { ...(defaults as ConfigValues) } : {};
}

/** Removes the empty fields before sending: Zod will apply its own defaults. */
export function cleanConfig(values: ConfigValues): ConfigValues {
  const out: ConfigValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}
