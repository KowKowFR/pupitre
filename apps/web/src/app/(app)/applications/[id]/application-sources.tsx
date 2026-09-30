'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GitBranch, GitCommitHorizontal, Pencil, RefreshCw, Rocket, Unlink } from 'lucide-react';
import type { SpecChange } from '@pupitre/core';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { KeyValue } from '@/components/ui/data';
import { useDrawerSelection } from '@/components/ui/drawer';
import { useT } from '@/i18n/client';
import { applications as appMessages } from '@/i18n/messages/applications';
import { common } from '@/i18n/messages/common';
import { sources as messages } from '@/i18n/messages/sources';
import { branchHref, commitHref } from '@/lib/commit';
import { toast } from '@/lib/toast';
import { SourceDrawer, type DeployTarget } from './source-drawer';

type ApiError = { error?: { message?: string } };

export type SourceMode = 'auto' | 'auto_unless_infra' | 'manual';

export type ProposalView = {
  id: string;
  sha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  commitUrl: string | null;
  reason: 'manual' | 'infra';
  changes: SpecChange[];
  receivedAgo: string | null;
};

export type SourceView = {
  id: string;
  repository: string;
  branch: string;
  specPath: string;
  watchPaths: string[];
  /** Ce que surveille une liaison sans chemin déclaré : le dossier du fichier de spec. */
  defaultWatchPaths: string[];
  mode: SourceMode;
  enabled: boolean;
  lastSeenSha: string | null;
  checkedAgo: string | null;
  lastError: string | null;
  targets: { targetId: string; runtime: 'docker' | 'k3s'; targetName: string }[];
  proposals: ProposalView[];
};

/**
 * La carte « Dépôt » de la fiche : les branches que l'application suit, ce que
 * Pupitre en a vu, et les commits qui attendent qu'on les valide.
 *
 * Tout ce qui touche au dépôt passe par le worker : « Vérifier maintenant » et
 * « Déployer le dernier commit » enfilent une tâche et rendent la main. Le
 * résultat revient au rafraîchissement suivant — comme le reste du panel.
 */
export function ApplicationSources({
  applicationId,
  sources,
  targets,
  connection,
  canEdit,
  canDeploy,
}: {
  applicationId: string;
  sources: SourceView[];
  targets: DeployTarget[];
  /** `null` : aucune GitHub App connectée. */
  connection: { installUrl: string } | null;
  canEdit: boolean;
  canDeploy: boolean;
}) {
  const t = useT(messages);
  const drawer = useDrawerSelection('source');
  const editing = sources.find((source) => source.id === drawer.selected) ?? null;
  const drawerOpen =
    connection !== null && canEdit && (drawer.selected === 'new' || editing !== null);

  return (
    <Card>
      <CardHeader
        actions={
          connection && canEdit ? (
            <Button variant="secondary" size="sm" onClick={() => drawer.open('new')}>
              <GitBranch aria-hidden />
              {t('card.link')}
            </Button>
          ) : null
        }
      >
        <CardTitle>{t('card.title')}</CardTitle>
        <CardDescription>{t('card.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {connection === null && sources.length === 0 ? (
          <Alert
            variant="info"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/admin/settings/integrations">{t('card.notConnected.link')}</Link>
              </Button>
            }
          >
            {t('card.notConnected')}
          </Alert>
        ) : sources.length === 0 ? (
          <p className="t-sm text-text-3">{t('card.empty')}</p>
        ) : (
          sources.map((source) => (
            <SourceBlock
              key={source.id}
              applicationId={applicationId}
              source={source}
              canEdit={canEdit && connection !== null}
              canDeploy={canDeploy && connection !== null}
              onEdit={() => drawer.open(source.id)}
            />
          ))
        )}
      </CardContent>

      {connection ? (
        <SourceDrawer
          open={drawerOpen}
          onClose={drawer.close}
          applicationId={applicationId}
          source={editing}
          targets={targets}
          installUrl={connection.installUrl}
        />
      ) : null}
    </Card>
  );
}

function SourceBlock({
  applicationId,
  source,
  canEdit,
  canDeploy,
  onEdit,
}: {
  applicationId: string;
  source: SourceView;
  canEdit: boolean;
  canDeploy: boolean;
  onEdit: () => void;
}) {
  const t = useT(messages);
  const ta = useT(appMessages);
  const tc = useT(common);
  const router = useRouter();
  const [busy, setBusy] = useState<'check' | 'deploy' | 'unlink' | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/applications/${applicationId}/sources/${source.id}`;

  async function call(kind: 'check' | 'deploy' | 'unlink', url: string, init: RequestInit) {
    setBusy(kind);
    setError(null);
    const response = await fetch(url, init);
    setBusy(null);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return false;
    }
    return true;
  }

  async function check() {
    if (await call('check', `${base}/check`, { method: 'POST' })) {
      toast({ title: t('toast.checking'), tone: 'accent' });
      router.refresh();
    }
  }

  async function deploy() {
    if (await call('deploy', `${base}/deploy`, { method: 'POST' })) {
      toast({ title: t('toast.deploying'), tone: 'accent' });
      router.refresh();
    }
  }

  async function unlink() {
    if (await call('unlink', base, { method: 'DELETE' })) {
      setUnlinking(false);
      toast({ title: t('toast.unlinked', { repository: source.repository }), tone: 'ok' });
      router.refresh();
    }
  }

  const watched = source.watchPaths.length > 0 ? source.watchPaths : null;

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-border p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <GitBranch aria-hidden className="size-4 text-text-3" />
        <a
          href={branchHref(source.repository, source.branch)}
          target="_blank"
          rel="noreferrer"
          className="mono link font-medium"
        >
          {source.repository}
        </a>
        <CodeBadge>{source.branch}</CodeBadge>
        <Badge variant="accent">{t(`mode.${source.mode}`)}</Badge>
        {source.enabled ? null : (
          <Badge variant="warn" dot>
            {t('source.paused')}
          </Badge>
        )}
      </div>

      <KeyValue
        items={[
          {
            key: 'spec',
            term: t('source.spec'),
            value: <span className="mono">{source.specPath}</span>,
          },
          {
            key: 'watch',
            term: t('source.watch'),
            value: watched ? (
              <span className="mono">{watched.join(', ')}</span>
            ) : (
              <span className="mono text-text-2">
                {t('source.watch.default', { paths: source.defaultWatchPaths.join(', ') })}
              </span>
            ),
          },
          {
            key: 'targets',
            term: t('source.targets'),
            value: (
              <span className="flex flex-wrap justify-end gap-1.5">
                {source.targets.map((target) => (
                  <Badge key={target.targetId} variant="outline">
                    {target.targetName}
                    <span className="text-text-3"> · {ta(`runtime.${target.runtime}`)}</span>
                  </Badge>
                ))}
              </span>
            ),
          },
          {
            key: 'commit',
            term: t('source.lastSeen'),
            value: source.lastSeenSha ? (
              <span className="flex flex-wrap items-center justify-end gap-x-2">
                <a
                  href={commitHref(source.repository, source.lastSeenSha)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono link"
                >
                  {source.lastSeenSha.slice(0, 7)}
                </a>
                {source.checkedAgo ? (
                  <span className="t-cap text-text-3">
                    {t('source.checked', { when: source.checkedAgo })}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-text-3">{tc('none')}</span>
            ),
          },
        ]}
      />

      {source.lastSeenSha === null && source.enabled && !source.lastError ? (
        <p className="t-cap text-text-3">{t('source.never')}</p>
      ) : null}
      {source.lastError ? (
        <Alert variant="warn" title={t('source.error')}>
          <span className="break-words">{source.lastError}</span>
        </Alert>
      ) : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      {source.proposals.map((proposal) => (
        <Proposal
          key={proposal.id}
          proposal={proposal}
          commitUrl={proposal.commitUrl ?? commitHref(source.repository, proposal.sha)}
          canDeploy={canDeploy}
        />
      ))}

      {canEdit || canDeploy ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'check'}
            onClick={() => void check()}
          >
            <RefreshCw aria-hidden />
            {t('action.check')}
          </Button>
          {canDeploy ? (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'deploy'}
              onClick={() => void deploy()}
            >
              <Rocket aria-hidden />
              {t('action.deploy')}
            </Button>
          ) : null}
          {canEdit ? (
            <>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={onEdit}>
                <Pencil aria-hidden />
                {t('action.edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-text"
                onClick={() => {
                  setError(null);
                  setUnlinking(true);
                }}
              >
                <Unlink aria-hidden />
                {t('action.unlink')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={unlinking}
        onOpenChange={setUnlinking}
        level="trace"
        icon={<Unlink />}
        title={t('unlink.title', { repository: source.repository })}
        consequences={[
          t('unlink.polling', { branch: source.branch }),
          t('unlink.running'),
          ...(source.proposals.length > 0 ? [t('unlink.pending')] : []),
        ]}
        confirmLabel={t('unlink.confirm')}
        pending={busy === 'unlink'}
        error={unlinking ? error : null}
        onConfirm={unlink}
      />
    </section>
  );
}

/**
 * Un commit en attente : ce qu'il change, sous les yeux, et les deux gestes
 * possibles. Valider déploie l'AppSpec telle qu'elle a été lue au commit.
 */
function Proposal({
  proposal,
  commitUrl,
  canDeploy,
}: {
  proposal: ProposalView;
  commitUrl: string;
  canDeploy: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sha = proposal.sha.slice(0, 7);

  async function decide(decision: 'approve' | 'dismiss') {
    setBusy(decision);
    setError(null);
    const response = await fetch(`/api/source-proposals/${proposal.id}/${decision}`, {
      method: 'POST',
    });
    setBusy(null);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    toast({
      title: t(decision === 'approve' ? 'proposal.approved' : 'proposal.dismissed', { sha }),
      tone: decision === 'approve' ? 'accent' : 'ok',
    });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-warn-line bg-warn-soft p-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GitCommitHorizontal aria-hidden className="size-4 text-warn-text" />
        <span className="t-sm font-semibold text-text">
          <a href={commitUrl} target="_blank" rel="noreferrer" className="link">
            {t('proposal.title', { sha })}
          </a>
        </span>
        {proposal.receivedAgo ? (
          <span className="t-cap text-text-3">
            {t('proposal.received', { when: proposal.receivedAgo })}
          </span>
        ) : null}
      </div>
      {proposal.commitMessage ? (
        <p className="t-sm text-text-2">
          <span className="line-clamp-2 break-words">{proposal.commitMessage.split('\n')[0]}</span>
          {proposal.commitAuthor ? (
            <span className="text-text-3">
              {' '}
              {t('proposal.by', { author: proposal.commitAuthor })}
            </span>
          ) : null}
        </p>
      ) : null}
      <p className="t-sm text-text-2">
        {proposal.reason === 'infra' ? t('proposal.reason.infra') : t('proposal.reason.manual')}
      </p>
      {proposal.changes.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {proposal.changes.map((change) => (
            <li
              key={`${change.path}:${change.change}`}
              className="flex flex-wrap items-center gap-2"
            >
              <Badge variant={change.kind === 'infra' ? 'warn' : 'idle'}>
                {t(`proposal.kind.${change.kind}`)}
              </Badge>
              <span className="mono t-sm text-text">{change.path}</span>
              <span className="t-cap text-text-3">{t(`proposal.change.${change.change}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {canDeploy ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={busy === 'approve'} onClick={() => void decide('approve')}>
            <Rocket aria-hidden />
            {t('proposal.approve')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={busy === 'dismiss'}
            onClick={() => void decide('dismiss')}
          >
            {t('proposal.dismiss')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
