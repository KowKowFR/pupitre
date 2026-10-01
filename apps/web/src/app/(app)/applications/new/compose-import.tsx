'use client';

import { useRef, useState } from 'react';
import { FileUp, Wand2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { useT } from '@/i18n/client';
import { applications as messages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';

type Level = 'blocking' | 'warning' | 'info';

type ImportedIssue = { level: Level; code: string; service: string | null; message: string };

type Conversion = {
  spec: { name: string; services: unknown[] } | null;
  valid: boolean;
  slugTaken: boolean;
  issues: ImportedIssue[];
};

type ApiError = { error?: { message?: string } };

const MAX_BYTES = 256 * 1024;

/**
 * « Depuis un docker-compose » : coller ou choisir le fichier, le convertir,
 * lire ce qui n'est pas passé tel quel.
 *
 * La conversion propose une AppSpec qui part dans l'éditeur de la page — la
 * même relecture, la même validation, le même enregistrement que les autres
 * chemins. Ce composant ne crée rien ; il dit, niveau par niveau, ce que la
 * traduction a dû décider à la place de la personne.
 */
export function ComposeImport({ onConverted }: { onConverted: (spec: unknown) => void }) {
  const t = useT(messages);
  const tc = useT(common);
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Conversion | null>(null);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(t('compose.fileTooLarge', { size: Math.ceil(file.size / 1024) }));
      return;
    }
    setError(null);
    setSource(await file.text());
  }

  async function convert() {
    setPending(true);
    setError(null);
    const response = await fetch('/api/applications/import-compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name.trim() ? { source, name: name.trim() } : { source }),
    }).catch(() => null);
    setPending(false);
    if (!response) {
      setError(tc('http.failure', { status: 0 }));
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    const conversion = (await response.json()) as Conversion;
    setResult(conversion);
    if (conversion.spec) onConverted(conversion.spec);
  }

  const byLevel = (level: Level) => result?.issues.filter((issue) => issue.level === level) ?? [];
  const blocking = byLevel('blocking');
  const warnings = byLevel('warning');
  const infos = byLevel('info');

  const list = (issues: ImportedIssue[]) => (
    <ul className="mt-1.5 flex flex-col gap-1">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="flex gap-2">
          <span className="mono t-cap shrink-0 pt-px text-text-3">
            {issue.service ?? t('compose.file.scope')}
          </span>
          <span className="t-sm">{issue.message}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="flex flex-col gap-4">
      <Field label={t('compose.label')} help={t('compose.help')}>
        <Textarea
          rows={10}
          wrap="off"
          spellCheck={false}
          value={source}
          placeholder={t('compose.placeholder')}
          onChange={(event) => setSource(event.target.value)}
          className="mono bg-surface-2"
        />
      </Field>

      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label={t('compose.name')} help={t('compose.name.help')} optional>
          <Input
            className="mono"
            value={name}
            maxLength={48}
            placeholder="imported-app"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <input
          ref={fileInput}
          type="file"
          accept=".yml,.yaml,text/yaml,application/x-yaml"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            void pickFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
          <FileUp aria-hidden />
          {t('compose.file')}
        </Button>
        <Button
          type="button"
          loading={pending}
          disabledReason={source.trim().length === 0 ? t('compose.empty') : null}
          onClick={() => void convert()}
        >
          {pending ? null : <Wand2 aria-hidden />}
          {pending ? t('compose.converting') : t('compose.convert')}
        </Button>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {result ? (
        <div className="flex flex-col gap-3">
          {result.spec ? (
            <Alert variant={blocking.length > 0 || !result.valid ? 'warn' : 'success'}>
              {t('compose.summary', {
                services: t('compose.services', { count: result.spec.services.length }),
              })}
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {blocking.length > 0 ? (
                  <Badge variant="danger">
                    {t('compose.count.blocking', { count: blocking.length })}
                  </Badge>
                ) : null}
                {warnings.length > 0 ? (
                  <Badge variant="warn">
                    {t('compose.count.warning', { count: warnings.length })}
                  </Badge>
                ) : null}
                <Badge variant="idle">{t('compose.count.info', { count: infos.length })}</Badge>
              </span>
            </Alert>
          ) : null}
          {result.slugTaken && result.spec ? (
            <Alert variant="warn">{t('compose.slugTaken', { name: result.spec.name })}</Alert>
          ) : null}
          {blocking.length > 0 ? (
            <Alert variant="destructive" title={t('compose.lead.blocking')}>
              {list(blocking)}
            </Alert>
          ) : null}
          {warnings.length > 0 ? (
            <Alert variant="warn" title={t('compose.lead.warning')}>
              {list(warnings)}
            </Alert>
          ) : null}
          {infos.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger className="t-sm font-medium text-text-2 hover:text-text">
                {t('compose.lead.info')} {t('compose.count.info', { count: infos.length })}
              </CollapsibleTrigger>
              <CollapsiblePanel className="pt-1 text-text-2">{list(infos)}</CollapsiblePanel>
            </Collapsible>
          ) : null}
          {result.spec && !result.valid ? (
            <p className="t-cap text-danger-text">{t('compose.invalid')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
