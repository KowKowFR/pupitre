'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { RuntimesAvailable, TargetHealth } from '@pupitre/core';
import { EmptyState } from '@/components/empty-state';
import { TargetLabelChip, TargetLabelList, sortedLabelEntries } from '@/components/target-label';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
import type { FormatSettings } from '@/lib/format';
import { RuntimeBadges, StatusBadge, formatPreflightDate } from './runtime-badges';
import { usePreflight } from './use-preflight';

export type TargetRow = {
  id: string;
  name: string;
  description: string | null;
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
  /**
   * Filtres lus dans l'URL **par le serveur**, pas par `useSearchParams`.
   *
   * Le filtrage vit côté client, mais son état initial doit être connu au
   * moment du rendu serveur : sinon la première peinture montre le parc entier
   * puis le réduit, et une fiche qui pointe vers `/targets?label=env%3Dprod`
   * afficherait brièvement des cibles qu'on n'a pas demandées.
   */
  initialQuery: string;
  initialLabels: string[];
};

/** En-dessous, un champ de recherche encombre plus qu'il ne sert. */
const SEARCH_THRESHOLD = 5;

/** Ce qu'une ligne de tableau peut porter d'étiquettes sans se déformer. */
const ROW_LABEL_MAX = 3;

/** Accents et casse ignorés : on cherche « acmé » en tapant « acme ». */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export function TargetsTable({
  targets,
  canRunPreflight,
  canDelete,
  format,
  initialQuery,
  initialLabels,
}: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<string[]>(initialLabels);
  const { run, phaseOf, isRunning } = usePreflight({ onError: setError });

  /*
   * Le filtre est reporté dans l'URL, mais par l'API History plutôt que par le
   * routeur : la page est en `force-dynamic`, donc un `router.replace` relance
   * le rendu serveur — un aller-retour complet à chaque frappe, pour un
   * filtrage qui s'exécute déjà en mémoire. `replaceState` s'intègre au routeur
   * Next tout en restant local, et l'URL reste partageable.
   */
  useEffect(() => {
    const params = new URLSearchParams();
    const trimmed = query.trim();
    if (trimmed) params.set('q', trimmed);
    for (const pair of selected) params.append('label', pair);
    const search = params.toString();
    window.history.replaceState(
      null,
      '',
      search ? `${window.location.pathname}?${search}` : window.location.pathname,
    );
  }, [query, selected]);

  /*
   * Facettes : toutes les paires présentes dans le parc, les plus portées
   * d'abord. Trier par fréquence met `env=prod` avant `contact=n.durand` —
   * l'étiquette qui découpe le parc en deux est plus utile comme filtre que
   * celle qui n'en désigne qu'une machine.
   */
  const facets = useMemo(() => {
    const counts = new Map<string, { key: string; value: string; count: number }>();
    for (const target of targets) {
      for (const [key, value] of Object.entries(target.labels)) {
        const pair = `${key}=${value}`;
        const seen = counts.get(pair);
        if (seen) seen.count += 1;
        else counts.set(pair, { key, value, count: 1 });
      }
    }
    return [...counts.entries()]
      .sort(
        ([pairA, a], [pairB, b]) => b.count - a.count || pairA.localeCompare(pairB, 'fr'),
      )
      .map(([pair, entry]) => ({ pair, ...entry }));
  }, [targets]);

  /*
   * Deux paires de la même clé se lisent en OU, deux clés différentes en ET.
   *
   * C'est la convention des recherches à facettes, et c'est la seule qui donne
   * un résultat utile : « env=prod ET env=staging » ne désigne jamais rien,
   * alors que « (env=prod OU env=staging) ET client=acme » est exactement la
   * question qu'on se pose devant un parc.
   */
  const selectedByKey = useMemo(() => {
    const groups = new Map<string, Set<string>>();
    for (const pair of selected) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const key = pair.slice(0, separator);
      const group = groups.get(key) ?? new Set<string>();
      group.add(pair.slice(separator + 1));
      groups.set(key, group);
    }
    return groups;
  }, [selected]);

  const selectedPairs = useMemo(() => new Set(selected), [selected]);

  const visible = useMemo(() => {
    const needle = fold(query.trim());
    return targets.filter((target) => {
      for (const [key, values] of selectedByKey) {
        const own = target.labels[key];
        if (own === undefined || !values.has(own)) return false;
      }
      if (!needle) return true;
      // La recherche couvre la description et les étiquettes, pas seulement le
      // nom : c'est précisément là qu'on a écrit à quoi sert la machine.
      const haystack = fold(
        [
          target.name,
          target.description ?? '',
          `${target.sshUser}@${target.host}:${target.port}`,
          sortedLabelEntries(target.labels)
            .map(([key, value]) => `${key}=${value}`)
            .join(' '),
        ].join(' '),
      );
      return haystack.includes(needle);
    });
  }, [targets, query, selectedByKey]);

  function toggleLabel(pair: string) {
    setSelected((current) =>
      current.includes(pair) ? current.filter((item) => item !== pair) : [...current, pair],
    );
  }

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

  const showSearch = targets.length >= SEARCH_THRESHOLD || query !== '';
  const showFilters = showSearch || facets.length > 0;
  const filtering = selected.length > 0 || query.trim() !== '';

  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-3">
        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {/*
          Le filtrage est intégralement en mémoire. Un parc réaliste — quelques
          dizaines de machines — est déjà chargé en entier par `listTargets` :
          repasser par le serveur pour retirer trois lignes coûterait un
          aller-retour et une requête SQL pour rien, et rendrait la frappe
          saccadée. Le jour où le parc ne tient plus sur une page, c'est la
          pagination qu'il faudra, et le filtre suivra côté serveur avec elle.
        */}
        {showFilters ? (
          <div className="flex flex-col gap-2 border-b border-line pb-3">
            <div className="flex flex-wrap items-center gap-2">
              {showSearch ? (
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filtrer : nom, hôte, description, étiquette…"
                  aria-label="Filtrer les machines cibles"
                  className="h-8 w-full max-w-xs text-xs"
                />
              ) : null}
              {facets.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {facets.map((facet) => (
                    <TargetLabelChip
                      key={facet.pair}
                      labelKey={facet.key}
                      value={facet.value}
                      active={selectedPairs.has(facet.pair)}
                      onToggle={() => toggleLabel(facet.pair)}
                    />
                  ))}
                </div>
              ) : null}
              {filtering ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setQuery('');
                    setSelected([]);
                  }}
                >
                  Tout afficher
                </Button>
              ) : null}
            </div>
            {filtering ? (
              <p className="text-xs text-ink-muted" role="status">
                {visible.length} cible{visible.length > 1 ? 's' : ''} sur {targets.length}
              </p>
            ) : null}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-muted">
            Aucune cible ne correspond à ce filtre.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cible</TableHead>
                <TableHead>Runtimes</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Dernier test</TableHead>
                <TableActionsHead>Actions</TableActionsHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((target) => {
                const phase = phaseOf(target.id);
                return (
                  <TableRow key={target.id}>
                    <TableCell className="max-w-[24rem] align-top">
                      <Link
                        href={`/targets/${target.id}`}
                        className="text-[0.8125rem] font-medium text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-signal-edge"
                      >
                        {target.name}
                      </Link>
                      <div className="font-mono text-[0.6875rem] text-ink-faint">
                        {target.sshUser}@{target.host}:{target.port}
                      </div>
                      {/*
                        Une ligne, pas deux : dans une liste dense la description
                        sert à reconnaître la machine, pas à la documenter. Le
                        texte intégral reste au survol, et sur la fiche.
                      */}
                      {target.description ? (
                        <p
                          className="mt-1 line-clamp-1 text-xs text-ink-muted"
                          title={target.description}
                        >
                          {target.description}
                        </p>
                      ) : null}
                      <TargetLabelList
                        labels={target.labels}
                        max={ROW_LABEL_MAX}
                        className="mt-1.5"
                        onToggle={toggleLabel}
                        activePairs={selectedPairs}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <RuntimeBadges runtimes={target.runtimesAvailable} />
                    </TableCell>
                    <TableCell className="align-top">
                      <StatusBadge status={target.status} />
                    </TableCell>
                    <TableCell className="align-top font-mono text-xs text-ink-muted tabular-nums">
                      {phase ? (
                        <span className="flex items-center gap-1.5 text-signal">
                          <span className="size-1.5 animate-signal-pulse rounded-full bg-signal" />
                          {phase}
                        </span>
                      ) : (
                        formatPreflightDate(target.lastPreflightAt, format)
                      )}
                    </TableCell>
                    <TableActions className="space-x-2 align-top whitespace-nowrap">
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
                    </TableActions>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {/*
          Le fuseau vit ici et non dans l'en-tête de colonne : « Dernier test
          (Europe/Paris) » gonflait cette colonne d'une centaine de pixels, ce
          qui suffisait à repousser la colonne d'actions hors de l'écran sur un
          portable. L'information est la même, elle ne coûte plus une colonne.
        */}
        <p className="text-ink-faint text-xs">
          Horodatages en {format.timezone}.
        </p>
      </CardContent>
    </Card>
  );
}
