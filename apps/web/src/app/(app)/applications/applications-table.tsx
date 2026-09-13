'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableActions,
  TableActionsHead,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';
import { DeleteApplicationDialog } from './delete-dialog';

export type ApplicationRow = {
  id: string;
  slug: string;
  description: string | null;
  version: string;
  services: string[];
  exposedService: string;
  ingressHost: string | null;
  createdAt: string;
};

export type DeployTarget = {
  id: string;
  name: string;
  host: string;
  runtimes: Array<'docker' | 'k3s'>;
};

type ApiError = { error?: { message?: string } };

export function ApplicationsTable({
  items,
  targets,
  canDeploy,
  canDelete,
}: {
  items: ApplicationRow[];
  targets: DeployTarget[];
  canDeploy: boolean;
  canDelete: boolean;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  /** Application dont on est en train de confirmer la suppression, s'il y en a une. */
  const [deleting, setDeleting] = useState<ApplicationRow | null>(null);

  // Politique de scan appliquée au prochain déploiement. Le formulaire arrive
  // avec les trois cases cochées ; l'API, elle, ne scanne rien par défaut.
  // Cochée par défaut : perdre une version qui marchait parce qu'on a oublié
  // une case est le mauvais défaut.
  const [autoRollback, setAutoRollback] = useState(true);

  async function deploy(application: ApplicationRow) {
    const targetId = selection[application.id] ?? targets[0]?.id;
    if (!targetId) {
      setError(t('deploy.noDockerTarget'));
      return;
    }

    setBusy(application.id);
    setError(null);

    const response = await fetch('/api/deployments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        applicationId: application.id,
        targetId,
        runtime: 'docker',
        proxy: 'traefik',
        autoRollback,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      setBusy(null);
      return;
    }

    // La route répond 202 sans attendre : on file droit sur la page de suivi.
    const { id } = (await response.json()) as { id: string };
    router.push(`/deployments/${id}`);
  }

  if (items.length === 0) {
    return (
      <EmptyState title={t('empty.title')} hint={t('empty.hint')} />
    );
  }

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {canDeploy ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-line bg-surface-2/50 px-3 py-2.5">
            <span className="eyebrow text-ink-faint">{t('lifecycle.title')}</span>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                name="auto-rollback"
                checked={autoRollback}
                onChange={(event) => setAutoRollback(event.target.checked)}
              />
              {t('lifecycle.autoRollback')}
            </label>
            <span className="text-xs text-ink-faint">
              {autoRollback ? t('lifecycle.autoRollback.on') : t('lifecycle.autoRollback.off')}
            </span>
            <span className="w-full text-xs text-ink-faint">{t('lifecycle.note')}</span>
          </div>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('column.application')}</TableHead>
              <TableHead>{t('column.services')}</TableHead>
              <TableHead>{t('column.exposure')}</TableHead>
              <TableActionsHead>{tc('column.actions')}</TableActionsHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((application) => (
              <TableRow key={application.id}>
                <TableCell>
                  <Link
                    href={`/applications/${application.id}`}
                    className="text-[0.8125rem] font-medium text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-signal-edge"
                  >
                    {application.slug}
                  </Link>
                  <div className="font-mono text-[0.6875rem] text-ink-faint">
                    v{application.version}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {application.services.map((service) => (
                      service === application.exposedService ? (
                        <Badge key={service} variant="default" className="font-mono">
                          {service}
                        </Badge>
                      ) : (
                        <CodeBadge key={service}>{service}</CodeBadge>
                      )
                    ))}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs text-ink-muted">
                  {application.ingressHost ?? (
                    <span className="text-ink-faint">{t('exposure.allocatedPort')}</span>
                  )}
                </TableCell>
                <TableActions className="space-x-2 whitespace-nowrap">
                  {canDeploy && targets.length > 0 ? (
                    <>
                      <Select
                        className="inline-flex h-8 w-44"
                        value={selection[application.id] ?? targets[0]?.id}
                        onChange={(event) =>
                          setSelection((current) => ({
                            ...current,
                            [application.id]: event.target.value,
                          }))
                        }
                      >
                        {targets.map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.name}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        disabled={busy === application.id}
                        onClick={() => void deploy(application)}
                      >
                        {busy === application.id ? t('action.sending') : t('action.deploy')}
                      </Button>
                    </>
                  ) : null}
                  {canDelete ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === application.id}
                      onClick={() => setDeleting(application)}
                    >
                      {tc('delete')}
                    </Button>
                  ) : null}
                </TableActions>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {canDeploy && targets.length === 0 ? (
          <p className="text-xs text-warn">
            {t('warn.noDockerTarget.before')}
            <code className="font-mono">/targets</code>
            {t('warn.noDockerTarget.after')}
          </p>
        ) : null}

        {/* La confirmation NOMME ce qui disparaît — cible, projet Compose, port
            — plutôt que de demander « êtes-vous sûr ? ». */}
        {deleting !== null ? (
          <DeleteApplicationDialog
            application={deleting}
            open
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
            onDeleted={() => {
              setDeleting(null);
              router.refresh();
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

