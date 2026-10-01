'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Boxes, Ellipsis, LayoutGrid, Plus, Rocket, Trash2 } from 'lucide-react';
import type { ProxyCapabilities } from '@pupitre/core';
import { AppSpecHelp } from '@/components/appspec-help';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { DomainsField, toRouteInputs, type DomainDraft } from '@/components/proxy/domains-field';
import { Badge, CodeBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDrawerSelection } from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SwitchField } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { IconButton } from '@/components/ui/tooltip';
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { applications as messages } from '@/i18n/messages/applications';
import { hrefWithSelection } from '@/lib/drawer-url';
import type { NewApplicationAi } from '@/lib/new-application';
import { toast } from '@/lib/toast';
import {
  FirstDeployBackup,
  firstDeployPayload,
  type FirstDeployBackupChoice,
} from '@/components/backups/first-deploy-backup';
import { ApplicationDrawer } from './application-drawer';
import { NewApplicationDrawer } from './new/new-application-drawer';
import { DeleteApplicationDialog } from './delete-dialog';

export type ServiceRow = {
  name: string;
  port: number;
  exposed: boolean;
  replicas: number;
  health: { path: string; interval: number; retries: number } | null;
  dependsOn: string[];
  volumes: string[];
  secrets: string[];
};

export type ApplicationRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string;
  services: ServiceRow[];
  ingress: { host: string | null; service: string; tls: boolean } | null;
  /** `null` : la session ne lit pas les déploiements. */
  live: Array<{ id: string; targetName: string; health: string; ago: string | null }> | null;
  /** La politique de sauvegarde est-elle réglée, et y a-t-il quelque chose à sauvegarder ? */
  backup: { configured: boolean; hasData: boolean };
  /** Ce que la vérification des images a trouvé ; `null` : rien à signaler. */
  imageUpdates: { outdated: number; newerTags: number } | null;
  /** Ses domaines, par cible — ce que le prochain déploiement gardera. */
  domains: Record<string, DomainDraft[]>;
};

export type DeployTarget = {
  id: string;
  name: string;
  host: string;
  runtimes: Array<'docker' | 'k3s'>;
  dockerVersion: string | null;
  k3sVersion: string | null;
  healthy: boolean;
  /** Son reverse proxy, s'il en a un : c'est lui qui servira les domaines. */
  proxy: { description: string; capabilities: ProxyCapabilities; via?: string | null } | null;
};

type ApiError = { error?: { message?: string } };

/**
 * Le catalogue. Une ligne par application ; un clic ouvre son aperçu, où l'on
 * relit ce qui va tourner et d'où l'on déploie. La fiche reste le lieu de
 * l'historique des versions et des secrets.
 */
export function ApplicationsView({
  items,
  targets,
  canCreate,
  canDeploy,
  canDelete,
  ai,
  backupOptions,
}: {
  items: ApplicationRow[];
  targets: DeployTarget[];
  canCreate: boolean;
  canDeploy: boolean;
  canDelete: boolean;
  /** L'état de la génération par IA, pour « Nouvelle application ». `null` sans `application:create`. */
  ai: NewApplicationAi | null;
  /** Le choix de sauvegarde au premier déploiement — `null` sans `backup:manage`. */
  backupOptions: { hasDestination: boolean } | null;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const router = useRouter();
  const search = useSearchParams();
  // Cochée par défaut : perdre une version qui marchait parce qu'on a oublié
  // une case est le mauvais défaut.
  const [autoRollback, setAutoRollback] = useState(true);
  const [firstBackup, setFirstBackup] = useState<FirstDeployBackupChoice>({
    enabled: true,
    beforeDeploy: true,
  });
  // Les domaines saisis, par application et par cible : changer de cible dans
  // le tiroir ne perd pas ce qui a été tapé pour l'autre.
  const [domainDrafts, setDomainDrafts] = useState<Record<string, DomainDraft[]>>({});
  const [deleting, setDeleting] = useState<ApplicationRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drawer = useDrawerSelection(
    'app',
    items.map((item) => item.slug),
  );
  const current = items.find((item) => item.slug === drawer.selected) ?? null;
  // La palette arrive ici avec `?app=…&deploy=1` : l'aperçu s'ouvre sur le
  // déploiement.
  const focusDeploy = search.get('deploy') === '1';
  // « Nouvelle application » vit dans l'URL comme l'aperçu : `?add=new` l'ouvre
  // depuis la palette ou l'ancienne adresse `/applications/new`.
  const adding = useDrawerSelection('add');
  const pathname = usePathname();

  /** L'application enregistrée : le tiroir de création se ferme, son aperçu s'ouvre. */
  function saved(application: { id: string; name: string }) {
    const withoutAdd = hrefWithSelection(pathname, window.location.search, 'add', null);
    const query = withoutAdd.includes('?') ? withoutAdd.slice(withoutAdd.indexOf('?')) : '';
    window.history.replaceState(
      null,
      '',
      application.name ? hrefWithSelection(pathname, query, 'app', application.name) : withoutAdd,
    );
    toast({
      title: t('toast.created', { name: application.name }),
      description: t('toast.created.detail'),
      tone: 'ok',
    });
    router.refresh();
  }

  /**
   * Le premier déploiement d'une application qui a des données, et dont la
   * politique n'a jamais été réglée : on propose d'activer sa sauvegarde.
   */
  function offersBackupChoice(application: ApplicationRow): boolean {
    return (
      backupOptions !== null &&
      application.backup.hasData &&
      !application.backup.configured &&
      (application.live === null || application.live.length === 0)
    );
  }

  /**
   * Les domaines proposés : ceux déjà posés sur cette cible ; à défaut, au
   * premier déploiement sur elle, celui de l'AppSpec. Une application qui y
   * tourne sans domaine n'en reçoit pas d'office : on les lui avait retirés.
   */
  function domainsFor(application: ApplicationRow, target: DeployTarget): DomainDraft[] {
    const drafted = domainDrafts[`${application.id}:${target.id}`];
    if (drafted) return drafted;
    const existing = application.domains[target.id];
    if (existing && existing.length > 0) return existing;
    const deployedThere =
      application.live?.some((live) => live.targetName === target.name) ?? false;
    if (application.ingress?.host && !deployedThere) {
      return [
        {
          hostname: application.ingress.host,
          tls: application.ingress.tls && (target.proxy?.capabilities.https ?? false),
        },
      ];
    }
    return [];
  }

  async function deploy(application: ApplicationRow, targetId: string, runtime: 'docker' | 'k3s') {
    const target = targets.find((candidate) => candidate.id === targetId);
    setBusy(true);
    setError(null);
    const response = await fetch('/api/deployments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        applicationId: application.id,
        targetId,
        runtime,
        proxy: 'traefik',
        autoRollback,
        ...(target?.proxy ? { domains: toRouteInputs(domainsFor(application, target)) } : {}),
        ...(offersBackupChoice(application)
          ? firstDeployPayload(firstBackup, backupOptions?.hasDestination ?? false)
          : {}),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      setError(body.error?.message ?? tc('http.failure', { status: response.status }));
      return;
    }
    // La route répond 202 sans attendre : le run est enfilé, on le dit, et on
    // donne le lien pour le suivre.
    const { id, number } = (await response.json()) as { id: string; number: number };
    toast({
      title: t('toast.deployed', { slug: application.slug, version: application.version }),
      description: t('toast.deployed.detail', { number }),
      tone: 'accent',
      action: { label: t('toast.follow'), href: `/deployments/${id}` },
    });
    drawer.close();
    router.refresh();
  }

  return (
    <>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          <>
            <AppSpecHelp />
            {canCreate ? (
              <>
                <Button asChild variant="secondary">
                  <Link href="/catalog">
                    <LayoutGrid aria-hidden />
                    {t('action.catalog')}
                  </Link>
                </Button>
                <Button onClick={() => adding.open('new')}>
                  <Plus aria-hidden />
                  {t('action.new')}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {canDeploy && items.length > 0 ? (
        <div className="card flex flex-wrap items-center gap-4 px-4 py-3">
          <SwitchField
            label={t('lifecycle.autoRollback')}
            help={t('lifecycle.scope')}
            checked={autoRollback}
            onChange={(event) => setAutoRollback(event.target.checked)}
            className="min-w-[280px] flex-1"
          />
          <span className="vsep max-md:hidden" />
          <span className="t-cap max-w-[420px] text-text-3">{t('lifecycle.note')}</span>
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={t('empty.title')}
          hint={t('empty.hint')}
          action={
            canCreate ? (
              <>
                <Button onClick={() => adding.open('new')}>
                  <Plus aria-hidden />
                  {t('action.new')}
                </Button>
                <Button asChild variant="secondary">
                  <Link href="/catalog">
                    <LayoutGrid aria-hidden />
                    {t('action.catalog')}
                  </Link>
                </Button>
              </>
            ) : undefined
          }
        />
      ) : (
        <section className="card overflow-hidden">
          <Table label={t('page.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('column.application')}</TableHead>
                <TableHead>{t('column.services')}</TableHead>
                <TableHead>{t('column.exposure')}</TableHead>
                <TableHead>{t('column.inService')}</TableHead>
                <TableHead>
                  <span className="sr-only">{tc('column.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((application) => (
                <TableRow
                  key={application.id}
                  interactive
                  selected={drawer.selected === application.slug}
                  onClick={() => drawer.open(application.slug)}
                >
                  <TableCell>
                    <span className="flex flex-col">
                      <button
                        type="button"
                        className="cellname w-fit text-left hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          drawer.open(application.slug);
                        }}
                      >
                        {application.slug}
                      </button>
                      <span className="mono text-[11.5px] text-text-3">{application.version}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <ServiceChips services={application.services} />
                  </TableCell>
                  <TableCell>
                    {application.ingress?.host ? (
                      <span className="mono text-[12px] text-text-2">{application.ingress.host}</span>
                    ) : (
                      <span className="text-text-3">{t('exposure.allocatedPort')}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {application.live === null ? (
                      <span className="text-text-3">{tc('none')}</span>
                    ) : application.live.length > 0 ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="mono text-[12px] text-text-2">
                          {application.live.map((entry) => entry.targetName).join(', ')}
                        </span>
                        {application.imageUpdates?.outdated ? (
                          <Badge variant="warn" dot>
                            {t('row.imagesOutdated', { count: application.imageUpdates.outdated })}
                          </Badge>
                        ) : application.imageUpdates?.newerTags ? (
                          <Badge variant="accent">{t('row.imagesNewer')}</Badge>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-text-3">{t('inService.never')}</span>
                    )}
                  </TableCell>
                  <TableCell className="r" onClick={(event) => event.stopPropagation()}>
                    <span className="inline-flex items-center gap-0.5">
                      {canDeploy ? (
                        <IconButton
                          label={t('row.deploy')}
                          size="icon-sm"
                          onClick={() => drawer.open(application.slug)}
                        >
                          <Rocket />
                        </IconButton>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton label={t('row.more')} size="icon-sm">
                            <Ellipsis />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/applications/${application.id}`}>{t('row.open')}</Link>
                          </DropdownMenuItem>
                          {canDelete ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem destructive onSelect={() => setDeleting(application)}>
                                <Trash2 aria-hidden />
                                {t('row.delete')}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="pager">
            {t('table.count', { count: items.length })}
            <span className="ml-auto max-sm:hidden">{t('table.legend')}</span>
          </div>
        </section>
      )}

      {canCreate && ai ? (
        <NewApplicationDrawer
          open={adding.selected !== null}
          ai={ai}
          targets={targets}
          backupOptions={backupOptions}
          onClose={adding.close}
          onSaved={saved}
        />
      ) : null}

      <ApplicationDrawer
        application={current}
        onOpenChange={(open) => (open ? undefined : drawer.close())}
        onPrevious={drawer.onPrevious}
        onNext={drawer.onNext}
        targets={targets}
        canDeploy={canDeploy}
        canDelete={canDelete}
        autoRollback={autoRollback}
        onAutoRollbackChange={setAutoRollback}
        backupChoice={
          current && offersBackupChoice(current) ? (
            <FirstDeployBackup
              value={firstBackup}
              onChange={setFirstBackup}
              hasDestination={backupOptions?.hasDestination ?? false}
            />
          ) : null
        }
        domainsChoice={(target) =>
          current ? (
            <DomainsField
              targetId={target.id}
              targetName={target.name}
              proxy={target.proxy}
              value={domainsFor(current, target)}
              onChange={(value) =>
                setDomainDrafts((previous) => ({
                  ...previous,
                  [`${current.id}:${target.id}`]: value,
                }))
              }
            />
          ) : null
        }
        focusDeploy={focusDeploy}
        busy={busy}
        error={error}
        onDeploy={(targetId, runtime) => (current ? deploy(current, targetId, runtime) : undefined)}
        onDelete={() => setDeleting(current)}
      />

      {/* La confirmation NOMME ce qui disparaît — cible, projet, port — plutôt
          que de demander « êtes-vous sûr ? ». */}
      {deleting !== null ? (
        <DeleteApplicationDialog
          application={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onDeleted={() => {
            toast({ title: t('toast.deleted', { slug: deleting.slug }), tone: 'ok' });
            setDeleting(null);
            drawer.close();
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Les services d'une application ; l'exposé en badge plein, les autres en code. */
export function ServiceChips({ services }: { services: ServiceRow[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {services.map((service) =>
        service.exposed ? (
          <Badge key={service.name} variant="accent" className="mono">
            {service.name}
          </Badge>
        ) : (
          <CodeBadge key={service.name}>{service.name}</CodeBadge>
        ),
      )}
    </span>
  );
}
