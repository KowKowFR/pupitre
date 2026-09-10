'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  DEFAULT_UI_SCAN_CONFIG,
  FAIL_ON_LABELS,
  SCANNERS,
  SCANNER_KEYS,
  failOnSchema,
  type FailOn,
  type ScannerKey,
} from '@tp/core';
import { EmptyState } from '@/components/empty-state';
import { Alert } from '@/components/ui/alert';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
  canConfigureScan,
}: {
  items: ApplicationRow[];
  targets: DeployTarget[];
  canDeploy: boolean;
  canDelete: boolean;
  canConfigureScan: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});

  // Politique de scan appliquée au prochain déploiement. Le formulaire arrive
  // avec les trois cases cochées ; l'API, elle, ne scanne rien par défaut.
  const [scanners, setScanners] = useState<ScannerKey[]>(
    canConfigureScan ? [...DEFAULT_UI_SCAN_CONFIG.scanners] : [],
  );
  const [failOn, setFailOn] = useState<FailOn>(
    canConfigureScan ? DEFAULT_UI_SCAN_CONFIG.failOn : 'NONE',
  );
  // Cochée par défaut : perdre une version qui marchait parce qu'on a oublié
  // une case est le mauvais défaut.
  const [autoRollback, setAutoRollback] = useState(true);

  function toggleScanner(key: ScannerKey) {
    setScanners((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key],
    );
  }

  async function deploy(application: ApplicationRow) {
    const targetId = selection[application.id] ?? targets[0]?.id;
    if (!targetId) {
      setError('Aucune cible déployable. Lancez un preflight depuis /targets.');
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
        scanConfig: { scanners, failOn },
        autoRollback,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setBusy(null);
      return;
    }

    // La route répond 202 sans attendre : on file droit sur la page de suivi.
    const { id } = (await response.json()) as { id: string };
    router.push(`/deployments/${id}`);
  }

  async function remove(application: ApplicationRow) {
    if (!window.confirm(`Supprimer l'application « ${application.slug} » ?`)) return;
    setBusy(application.id);
    setError(null);

    const response = await fetch(`/api/applications/${application.id}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setBusy(null);
      return;
    }
    setBusy(null);
    router.refresh();
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="Aucune application"
        hint="Décrivez une application — services, image, port exposé — ou laissez l'IA en proposer une AppSpec que vous relirez avant de déployer."
      />
    );
  }

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {canDeploy && canConfigureScan ? (
          <ScanPolicyForm
            scanners={scanners}
            failOn={failOn}
            onToggle={toggleScanner}
            onFailOn={setFailOn}
          />
        ) : null}

        {canDeploy ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border border-line bg-surface-2/50 px-3 py-2.5">
            <span className="eyebrow text-ink-faint">Cycle de vie</span>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                name="auto-rollback"
                checked={autoRollback}
                onChange={(event) => setAutoRollback(event.target.checked)}
              />
              Rollback automatique en cas d&apos;échec
            </label>
            <span className="text-xs text-ink-faint">
              {autoRollback
                ? 'Un healthcheck raté ramène la version précédente, si elle existe.'
                : 'Un healthcheck raté laisse le déploiement en échec, en l’état.'}
            </span>
          </div>
        ) : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Application</TableHead>
              <TableHead>Services</TableHead>
              <TableHead>Exposition</TableHead>
              <TableHead className="text-right">Actions</TableHead>
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
                    <span className="text-ink-faint">port alloué</span>
                  )}
                </TableCell>
                <TableCell className="space-x-2 text-right">
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
                        {busy === application.id ? 'Envoi…' : 'Déployer'}
                      </Button>
                    </>
                  ) : null}
                  {canDelete ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === application.id}
                      onClick={() => void remove(application)}
                    >
                      Supprimer
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {canDeploy && targets.length === 0 ? (
          <p className="text-xs text-warn">
            Aucune cible avec un runtime exploitable. Lancez un preflight depuis{' '}
            <code className="font-mono">/targets</code>.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Politique de scan du prochain déploiement.
 *
 * Les libellés viennent de `SCANNERS`, la table de données de `@tp/core` : cette
 * UI ne connaît aucun scanner par son nom, et un quatrième outil apparaîtrait
 * ici sans qu'on touche ce fichier.
 */
function ScanPolicyForm({
  scanners,
  failOn,
  onToggle,
  onFailOn,
}: {
  scanners: ScannerKey[];
  failOn: FailOn;
  onToggle: (key: ScannerKey) => void;
  onFailOn: (value: FailOn) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-line bg-surface-2/50 px-3 py-2.5">
      <span className="eyebrow text-ink-faint">Analyse de sécurité</span>

      <div className="flex flex-wrap items-center gap-4">
        {SCANNER_KEYS.map((key) => (
          <label
            key={key}
            className="flex cursor-pointer items-center gap-2 text-xs text-ink"
            title={SCANNERS[key].description}
          >
            <input
              type="checkbox"
              name={`scanner-${key}`}
              checked={scanners.includes(key)}
              onChange={() => onToggle(key)}
            />
            {SCANNERS[key].label}
          </label>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs text-ink">
        Politique
        <Select
          className="inline-flex h-8 w-56"
          value={failOn}
          onChange={(event) => onFailOn(failOnSchema.parse(event.target.value))}
        >
          {failOnSchema.options.map((option) => (
            <option key={option} value={option}>
              {FAIL_ON_LABELS[option]}
            </option>
          ))}
        </Select>
      </label>

      {scanners.length === 0 ? (
        <span className="text-xs text-warn">Aucun scanner : l&apos;étape sera sautée.</span>
      ) : null}
    </div>
  );
}
