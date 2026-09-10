'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { RuntimesAvailable, TargetHealth } from '@tp/core';
import { EmptyState } from '@/components/empty-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { FormatSettings } from '@/lib/format';
import { RuntimeBadges, StatusBadge, formatPreflightDate } from './runtime-badges';
import { usePreflight } from './use-preflight';

export type TargetRow = {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  sudoMethod: 'nopasswd' | 'password';
  labels: Record<string, string>;
  runtimesAvailable: RuntimesAvailable;
  status: TargetHealth;
  lastPreflightAt: string | null;
};

type Props = {
  targets: TargetRow[];
  canRunPreflight: boolean;
  canDelete: boolean;
  /**
   * Fuseau et locale descendus du serveur. Ce composant est client : sans cette
   * prop il formaterait avec le fuseau du navigateur, et le rendu ne
   * correspondrait plus à celui du serveur — erreur d'hydratation garantie.
   */
  format: FormatSettings;
};

export function TargetsTable({ targets, canRunPreflight, canDelete, format }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { run, phaseOf, isRunning } = usePreflight({ onError: setError });

  async function remove(target: TargetRow) {
    setError(null);
    if (!window.confirm(`Supprimer la cible « ${target.name} » (${target.host}) ?`)) return;

    const response = await fetch(`/api/targets/${target.id}`, { method: 'DELETE' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      return;
    }
    router.refresh();
  }

  if (targets.length === 0) {
    return (
      <EmptyState
        title="Aucune machine cible"
        hint="Déclarez une machine avec son accès SSH, puis lancez un preflight : le panel y détectera Docker, K3s et les outils de scan."
      />
    );
  }

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cible</TableHead>
              <TableHead>Runtimes</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Dernier test ({format.timezone})</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {targets.map((target) => {
              const phase = phaseOf(target.id);
              return (
                <TableRow key={target.id}>
                  <TableCell>
                    <Link
                      href={`/targets/${target.id}`}
                      className="text-[0.8125rem] font-medium text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-signal-edge"
                    >
                      {target.name}
                    </Link>
                    <div className="font-mono text-[0.6875rem] text-ink-faint">
                      {target.sshUser}@{target.host}:{target.port}
                    </div>
                  </TableCell>
                  <TableCell>
                    <RuntimeBadges runtimes={target.runtimesAvailable} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={target.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs text-ink-muted tabular-nums">
                    {phase ? (
                      <span className="flex items-center gap-1.5 text-signal">
                        <span className="size-1.5 animate-signal-pulse rounded-full bg-signal" />
                        {phase}
                      </span>
                    ) : (
                      formatPreflightDate(target.lastPreflightAt, format)
                    )}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    {canRunPreflight ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isRunning(target.id)}
                        onClick={() => void run(target.id)}
                      >
                        {isRunning(target.id) ? 'Test en cours…' : 'Tester la connexion'}
                      </Button>
                    ) : null}
                    {canDelete ? (
                      <Button size="sm" variant="ghost" onClick={() => void remove(target)}>
                        Supprimer
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
