'use client';

import { useEffect, useState } from 'react';
import { Globe, Plus, X } from 'lucide-react';
import { hostnameProblem, WAF_MODES, type ProxyCapabilities, type WafMode } from '@pupitre/core';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { proxy as messages } from '@/i18n/messages/proxy';

/**
 * Les domaines d'une application sur une cible : une ligne par nom, HTTPS ou
 * non. La redirection HTTP → HTTPS suit le HTTPS — le cas courant, sans réglage
 * de plus à comprendre.
 *
 * Chaque nom est confronté au DNS, pour prévenir — jamais pour refuser :
 * derrière un CDN ou un NAT, il ne pointe pas vers l'adresse par laquelle le
 * panel joint la machine, et c'est normal.
 */

/** `waf` : la protection, pour un proxy qui est aussi un WAF — « bloquer » par défaut. */
export type DomainDraft = { hostname: string; tls: boolean; waf?: WafMode };

export function toRouteInputs(drafts: DomainDraft[]) {
  return drafts
    .map((draft) => ({ ...draft, hostname: draft.hostname.trim().toLowerCase() }))
    .filter((draft) => draft.hostname.length > 0)
    .map((draft) => ({
      hostname: draft.hostname,
      tls: draft.tls,
      redirectHttps: draft.tls,
      waf: draft.waf ?? 'block',
    }));
}

type DnsState =
  | { state: 'checking' }
  | { state: 'ok'; via: string | null }
  | { state: 'elsewhere'; addresses: string[] }
  | { state: 'none' };

function DnsHint({ targetId, hostname }: { targetId: string; hostname: string }) {
  const t = useT(messages);
  const [dns, setDns] = useState<{ host: string; result: DnsState } | null>(null);
  const valid = hostname.length > 0 && hostnameProblem(hostname) === null;

  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    // Un nom qu'on tape change à chaque touche : on attend qu'il se pose.
    const timer = window.setTimeout(() => {
      void fetch(`/api/targets/${targetId}/dns?hostname=${encodeURIComponent(hostname)}`)
        .then(async (response) => {
          if (!response.ok || cancelled) return;
          const body = (await response.json()) as {
            addresses: string[];
            resolves: boolean;
            matches: boolean;
            via: string | null;
          };
          setDns({
            host: hostname,
            result: !body.resolves
              ? { state: 'none' }
              : body.matches
                ? { state: 'ok', via: body.via }
                : { state: 'elsewhere', addresses: body.addresses },
          });
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [targetId, hostname, valid]);

  if (!valid) {
    return hostname.length > 0 ? (
      <span className="t-cap text-danger-text">{hostnameProblem(hostname)}</span>
    ) : null;
  }
  const result = dns?.host === hostname ? dns.result : { state: 'checking' as const };
  return (
    <span
      className={
        result.state === 'ok'
          ? 't-cap text-ok-text'
          : result.state === 'checking'
            ? 't-cap text-text-3'
            : 't-cap text-warn-text'
      }
    >
      {result.state === 'checking'
        ? t('domains.dns.checking')
        : result.state === 'ok'
          ? result.via
            ? t('domains.dns.okVia', { target: result.via })
            : t('domains.dns.ok')
          : result.state === 'none'
            ? t('domains.dns.none')
            : t('domains.dns.elsewhere', { addresses: result.addresses.join(', ') })}
    </span>
  );
}

export function DomainsField({
  targetId,
  targetName,
  proxy,
  value,
  onChange,
  disabled = false,
}: {
  targetId: string;
  targetName: string;
  /**
   * `null` : la cible n'a pas de proxy — on le dit, et rien ne se saisit.
   * `via` : la machine du proxy, quand c'est celui d'une autre.
   */
  proxy: { description: string; capabilities: ProxyCapabilities; via?: string | null } | null;
  value: DomainDraft[];
  onChange: (value: DomainDraft[]) => void;
  disabled?: boolean;
}) {
  const t = useT(messages);
  if (!proxy) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="t-sm font-medium">{t('domains.title')}</span>
        <p className="t-cap text-text-3">{t('domains.noProxy')}</p>
      </div>
    );
  }
  const update = (index: number, patch: Partial<DomainDraft>) =>
    onChange(value.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)));

  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="t-sm font-medium">{t('domains.title')}</legend>
      <p className="t-cap text-text-3">
        {t('domains.help', { target: proxy.via ?? targetName, proxy: proxy.description })}
        {proxy.capabilities.autoTls ? t('domains.helpAcme') : ''}
        {proxy.capabilities.waf ? ` ${t('domains.helpWaf')}` : ''}
      </p>
      {value.map((draft, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Globe aria-hidden className="size-4 shrink-0 text-text-3" />
            <Input
              className="mono input-sm min-w-0 flex-1"
              value={draft.hostname}
              placeholder={t('domains.placeholder')}
              aria-label={t('domains.title')}
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => update(index, { hostname: event.target.value })}
            />
            <label className="t-cap flex shrink-0 items-center gap-1.5 text-text-2">
              <Checkbox
                checked={draft.tls && proxy.capabilities.https}
                disabled={!proxy.capabilities.https}
                onChange={(event) => update(index, { tls: event.target.checked })}
              />
              {t('domains.https')}
            </label>
            {proxy.capabilities.waf ? (
              <Select
                className="input-sm w-auto shrink-0"
                aria-label={t('domains.waf')}
                value={draft.waf ?? 'block'}
                onChange={(event) => update(index, { waf: event.target.value as WafMode })}
              >
                {WAF_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`waf.${mode}`)}
                  </option>
                ))}
              </Select>
            ) : null}
            <IconButton
              label={t('domains.remove')}
              size="icon-sm"
              onClick={() => onChange(value.filter((_, at) => at !== index))}
            >
              <X />
            </IconButton>
          </div>
          <div className="pl-6">
            <DnsHint targetId={targetId} hostname={draft.hostname.trim().toLowerCase()} />
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...value, { hostname: '', tls: proxy.capabilities.https }])}
        >
          <Plus aria-hidden />
          {t('domains.add')}
        </Button>
      </div>
    </fieldset>
  );
}
