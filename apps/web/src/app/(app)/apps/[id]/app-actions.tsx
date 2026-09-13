'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * Les gestes d'exploitation d'une application en marche.
 *
 * Quatre gestes, et ils ne se ressemblent pas :
 *
 *   Arrêter / Démarrer   coupe et remet le service, sans rien démonter. Le seul
 *                        des quatre qui n'existait pas avant.
 *   Revenir à la v(n-1)  remet en service la release précédente, déjà présente
 *                        sur la machine.
 *   Redéployer           rejoue un pipeline complet depuis la même AppSpec —
 *                        utile quand une image mutable a bougé ou qu'un secret
 *                        a changé.
 *   Détruire             retire l'application de la machine.
 *
 * ── Pourquoi ce composant appelle des routes qui existaient déjà ────────────
 * Rollback, redéploiement et destruction ont chacun leur route, leur
 * permission, leur tâche BullMQ et leur trace d'audit — elles servent l'écran
 * du *déploiement*. En ouvrir des jumelles sous `/api/apps/…` aurait donné deux
 * portes vers le même geste, donc deux endroits où une règle peut diverger. Ce
 * qui manquait n'était pas une route, c'était une porte d'entrée depuis l'écran
 * de l'application, et un dialogue qui dise ce que le geste va faire.
 *
 * ── L'état vient d'une lecture, pas des props ───────────────────────────────
 * Après un arrêt, le bouton doit devenir « Démarrer » sans recharger la page —
 * la console de logs voisine perdrait sa connexion SSE. D'où `GET
 * /api/apps/{id}/state`, relu après chaque geste jusqu'à ce que l'état bascule.
 *
 * ── Les permissions ─────────────────────────────────────────────────────────
 * `canDestroy` correspond exactement à `deployment:destroy`. `canDeploy`
 * couvre les trois autres boutons, dont les routes exigent respectivement
 * `deployment:restart` (arrêt et démarrage), `deployment:rollback` et
 * `deployment:create`. Les rôles livrés ne les dissocient pas — un opérateur a
 * les trois, un observateur aucune — mais un rôle sur mesure le pourrait, et il
 * verrait alors un bouton dont la route le refusera. Le refus est propre et
 * nommé ; c'est le serveur qui fait autorité, jamais l'affichage.
 */

export type AppActionsProps = {
  deploymentId: string;
  applicationId: string;
  applicationSlug: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  canDeploy: boolean;
  canDestroy: boolean;
};

/** Ce que rend `GET /api/apps/{id}/state`. */
type AppState = {
  id: string;
  status: string;
  supervisable: boolean;
  stoppedAt: string | null;
  version: number;
  url: string | null;
  publishedPort: number | null;
  applicationId: string;
  targetId: string;
  targetName: string;
  runtime: 'docker' | 'k3s';
  /** Projet Compose ou namespace, selon le runtime. */
  workspace: string;
  previous: { id: string; version: number } | null;
};

type ApiError = { error?: { message?: string } };

type GestureKey = 'stop' | 'start' | 'rollback' | 'redeploy' | 'destroy';

type Gesture = {
  key: GestureKey;
  label: string;
  /** Libellé pendant que la tâche tourne. */
  busyLabel: string;
  variant: 'default' | 'outline' | 'ghost' | 'destructive';
  /** Empêche le geste et dit pourquoi, sans le cacher. */
  disabledReason: string | null;
  request: { path: string; method: 'POST' | 'DELETE'; body?: unknown };
  confirm: {
    title: string;
    lead: string;
    /** Ce qui va se passer, nommément. */
    consequences: ReactNode[];
    action: string;
    danger: boolean;
    /** Le geste ne se débloque qu'en retapant ce mot. */
    typeToConfirm?: string;
  } | null;
  /**
   * Le geste quitte cet écran plutôt que d'y attendre : un redéploiement crée
   * un nouveau déploiement, et c'est son pipeline qu'il faut regarder.
   */
  navigateTo?: (response: { id?: string }) => string;
};

/** Cadence et plafond de la relecture d'état après un geste. */
const POLL_MS = 2_000;
const POLL_MAX_MS = 3 * 60_000;

/** « le 12/09/2026 à 14:03 » — une date d'arrêt se lit, elle ne se calcule pas. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

export function AppActions({
  deploymentId,
  applicationId,
  applicationSlug,
  targetName,
  runtime,
  canDeploy,
  canDestroy,
}: AppActionsProps): ReactNode {
  const router = useRouter();
  const [state, setState] = useState<AppState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<GestureKey | null>(null);
  const [pending, setPending] = useState<Gesture | null>(null);
  const [typed, setTyped] = useState('');

  const timer = useRef<NodeJS.Timeout | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const read = useCallback(async (): Promise<AppState> => {
    const response = await fetch(`/api/apps/${deploymentId}/state`, { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ApiError;
      throw new Error(body.error?.message ?? `Lecture impossible (HTTP ${response.status})`);
    }
    return (await response.json()) as AppState;
  }, [deploymentId]);

  useEffect(() => {
    read().then(
      (result) => {
        if (alive.current) setState(result);
      },
      (cause: unknown) => {
        if (alive.current) {
          setLoadError(cause instanceof Error ? cause.message : 'Lecture impossible');
        }
      },
    );
  }, [read]);

  /**
   * Attend que l'état bascule.
   *
   * La route rend `202` : elle a enfilé, elle n'a rien exécuté. Le seul témoin
   * fiable de la fin du travail est l'état lu en base, écrit par le worker une
   * fois le geste passé sur la machine. On le relit donc jusqu'à ce qu'il
   * change — et on s'arrête au bout de trois minutes en le disant, plutôt que
   * de tourner en rond devant un worker arrêté.
   */
  const watch = useCallback(
    (before: string, done: string) => {
      const started = Date.now();

      const tick = () => {
        read().then(
          (result) => {
            if (!alive.current) return;
            if (`${result.status}|${result.stoppedAt}` !== before) {
              setState(result);
              setBusy(null);
              setNotice(done);
              // La page serveur porte le bandeau de santé et l'en-tête : ils
              // doivent suivre le geste qu'on vient de passer.
              router.refresh();
              return;
            }
            if (Date.now() - started > POLL_MAX_MS) {
              setBusy(null);
              setError(
                "La tâche n'a rien changé au bout de trois minutes. Elle a pu échouer : " +
                  "le journal d'activité et les logs de l'application le diront.",
              );
              return;
            }
            timer.current = setTimeout(tick, POLL_MS);
          },
          () => {
            // Une lecture ratée n'est pas un échec du geste : on retente.
            if (alive.current) timer.current = setTimeout(tick, POLL_MS);
          },
        );
      };

      timer.current = setTimeout(tick, POLL_MS);
    },
    [read, router],
  );

  const run = useCallback(
    async (gesture: Gesture, current: AppState) => {
      setPending(null);
      setTyped('');
      setError(null);
      setNotice(null);
      setBusy(gesture.key);

      const response = await fetch(gesture.request.path, {
        method: gesture.request.method,
        ...(gesture.request.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(gesture.request.body),
            }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ApiError;
        setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
        setBusy(null);
        return;
      }

      if (gesture.navigateTo) {
        const body = (await response.json().catch(() => ({}))) as { id?: string };
        router.push(gesture.navigateTo(body));
        return;
      }

      watch(`${current.status}|${current.stoppedAt}`, `${gesture.label} : c'est fait.`);
    },
    [router, watch],
  );

  if (loadError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Exploitation</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">{loadError}</Alert>
        </CardContent>
      </Card>
    );
  }

  const stoppedAt = state?.stoppedAt ?? null;
  const gestures = state ? buildGestures({ state, applicationId, applicationSlug, runtime }) : [];
  const visible = gestures.filter((gesture) =>
    gesture.key === 'destroy' ? canDestroy : canDeploy,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Exploitation</CardTitle>
        <CardDescription>
          {state === null
            ? 'Lecture de l’état…'
            : stoppedAt !== null
              ? `Arrêtée le ${formatDate(stoppedAt)} — les données et le port réservé sont ` +
                'conservés, rien n’a été démonté.'
              : `En marche sur ${targetName}, version #${state.version}.`}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {notice ? <Alert variant="success">{notice}</Alert> : null}
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {visible.length === 0 && state !== null ? (
          <Alert>
            Votre rôle ne permet aucun geste sur cette application. La consultation des logs
            reste ouverte.
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {visible.map((gesture) => (
            <Button
              key={gesture.key}
              size="sm"
              variant={gesture.variant}
              disabled={busy !== null || gesture.disabledReason !== null}
              title={gesture.disabledReason ?? undefined}
              onClick={() => {
                if (!state) return;
                if (gesture.confirm) {
                  setTyped('');
                  setPending(gesture);
                  return;
                }
                void run(gesture, state);
              }}
            >
              {busy === gesture.key ? gesture.busyLabel : gesture.label}
            </Button>
          ))}
        </div>

        {/* Une raison de refus ne se cache pas derrière une infobulle : un
            bouton grisé sans explication est une impasse. */}
        {visible
          .filter((gesture) => gesture.disabledReason !== null)
          .map((gesture) => (
            <p key={gesture.key} className="text-[0.8125rem] text-ink-muted">
              <span className="font-medium">{gesture.label}</span> — {gesture.disabledReason}
            </p>
          ))}
      </CardContent>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setTyped('');
          }
        }}
      >
        <DialogContent>
          {pending?.confirm ? (
            <>
              <DialogHeader>
                <DialogTitle>{pending.confirm.title}</DialogTitle>
                <DialogDescription>{pending.confirm.lead}</DialogDescription>
              </DialogHeader>
              <DialogBody className="flex flex-col gap-3">
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[0.8125rem] leading-relaxed">
                  {pending.confirm.consequences.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
                {pending.confirm.typeToConfirm ? (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="app-actions-confirm" className="text-[0.8125rem]">
                      Retapez <strong>{pending.confirm.typeToConfirm}</strong> pour confirmer.
                    </label>
                    <Input
                      id="app-actions-confirm"
                      value={typed}
                      autoComplete="off"
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  </div>
                ) : null}
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPending(null);
                    setTyped('');
                  }}
                >
                  Annuler
                </Button>
                <Button
                  size="sm"
                  variant={pending.confirm.danger ? 'destructive' : 'default'}
                  disabled={
                    pending.confirm.typeToConfirm !== undefined &&
                    typed.trim() !== pending.confirm.typeToConfirm
                  }
                  onClick={() => {
                    if (state) void run(pending, state);
                  }}
                >
                  {pending.confirm.action}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * La table des gestes, dérivée de l'état lu.
 *
 * Elle est une fonction et non un tableau constant parce que chaque libellé
 * nomme quelque chose de concret — la version vers laquelle on revient, le port
 * qui sera rendu, le namespace qui disparaîtra. Un dialogue de confirmation qui
 * dit « êtes-vous sûr ? » ne fait rien confirmer du tout.
 */
function buildGestures({
  state,
  applicationId,
  applicationSlug,
  runtime,
}: {
  state: AppState;
  applicationId: string;
  applicationSlug: string;
  runtime: 'docker' | 'k3s';
}): Gesture[] {
  const stopped = state.stoppedAt !== null;
  const port = state.publishedPort;

  // Ce que le runtime appelle son regroupement. Le mot vient du serveur, qui le
  // tient de la convention partagée : pas de « projet Compose » codé en dur ici.
  const workspaceWord = runtime === 'docker' ? 'le projet Compose' : 'le namespace';

  const lifecycle: Gesture = stopped
    ? {
        key: 'start',
        label: 'Démarrer',
        busyLabel: 'Démarrage…',
        variant: 'default',
        disabledReason: null,
        request: { path: `/api/apps/${state.id}/start`, method: 'POST' },
        // Remettre en marche ne détruit rien et n'interrompt rien : demander
        // confirmation pour ça, c'est apprendre à cliquer sans lire.
        confirm: null,
      }
    : {
        key: 'stop',
        label: 'Arrêter',
        busyLabel: 'Arrêt…',
        variant: 'outline',
        disabledReason: null,
        request: { path: `/api/apps/${state.id}/stop`, method: 'POST' },
        confirm: {
          title: `Arrêter ${applicationSlug} sur ${state.targetName} ?`,
          lead: "Le service devient indisponible jusqu'à ce que vous le redémarriez.",
          consequences: [
            runtime === 'docker'
              ? 'Les conteneurs s’arrêtent. Ils ne sont pas supprimés : ils repartiront avec le même état.'
              : 'Les pods sont retirés (répliques à zéro). Les manifests, eux, restent en place.',
            'Les volumes et leurs données sont conservés.',
            port === null
              ? 'L’adresse publique cessera de répondre.'
              : `Le port ${port} reste réservé à cette application : personne d’autre ne le prendra.`,
            'Aucun redéploiement ne sera nécessaire : « Démarrer » remettra cette même version en service.',
            'La sonde de santé périodique cessera de la surveiller — une application arrêtée n’est pas une panne.',
          ],
          action: 'Arrêter l’application',
          danger: false,
        },
      };

  const rollback: Gesture = {
    key: 'rollback',
    label: state.previous ? `Revenir à la version #${state.previous.version}` : 'Revenir en arrière',
    busyLabel: 'Retour en arrière…',
    variant: 'outline',
    disabledReason: state.previous
      ? null
      : 'aucune version précédente sur cette cible — il n’y a nulle part où revenir. ' +
        'Un redéploiement d’une version antérieure se lance depuis la fiche de l’application.',
    request: { path: `/api/deployments/${state.id}/rollback`, method: 'POST' },
    confirm: state.previous
      ? {
          title: `Revenir à la version #${state.previous.version} ?`,
          lead: `La release #${state.previous.version}, déjà présente sur ${state.targetName}, est remise en service.`,
          consequences: [
            'Aucune image n’est reconstruite et aucun scan n’est rejoué : c’est la release déjà déposée qui repart.',
            'Le déploiement courant passe au statut « rollback effectué » — il reste dans l’historique.',
            'Les volumes ne sont pas touchés : une migration de base déjà passée ne sera pas défaite.',
            ...(stopped
              ? ['Cette application est arrêtée : le retour en arrière la remettra en marche.']
              : []),
          ],
          action: 'Revenir en arrière',
          danger: false,
        }
      : null,
  };

  const redeploy: Gesture = {
    key: 'redeploy',
    label: 'Redéployer cette version',
    busyLabel: 'Mise en file…',
    variant: 'outline',
    disabledReason: null,
    request: {
      path: `/api/applications/${applicationId}/redeploy`,
      method: 'POST',
      body: { versionId: state.id, targetId: state.targetId, autoRollback: true },
    },
    confirm: {
      title: 'Redéployer la même version ?',
      lead:
        'Utile quand une image mutable a bougé ou qu’un secret a changé : la même AppSpec ' +
        'est rejouée de bout en bout.',
      consequences: [
        'Un nouveau déploiement est créé, avec son propre numéro et son propre pipeline.',
        'Les images sont retirées ou reconstruites, et la politique de scan est appliquée à nouveau.',
        'Les services en marche sont remplacés à la fin du pipeline, pas avant.',
        'En cas d’échec du healthcheck, le rollback automatique ramène la version actuelle.',
      ],
      action: 'Lancer le redéploiement',
      danger: false,
    },
    navigateTo: (body) => (body.id ? `/deployments/${body.id}` : `/applications/${applicationId}`),
  };

  const destroy: Gesture = {
    key: 'destroy',
    label: 'Détruire',
    busyLabel: 'Destruction…',
    variant: 'ghost',
    disabledReason: null,
    request: { path: `/api/deployments/${state.id}`, method: 'DELETE' },
    confirm: {
      title: `Détruire ${applicationSlug} sur ${state.targetName} ?`,
      lead: 'L’application est retirée de la machine. Ce geste ne se défait pas.',
      consequences: [
        <>
          {workspaceWord} <code className="font-mono">{state.workspace}</code> est démonté sur{' '}
          <code className="font-mono">{state.targetName}</code>.
        </>,
        'Les volumes et leurs données sont supprimés — base de données comprise.',
        port === null
          ? 'L’entrée d’Ingress est retirée : l’adresse cessera de répondre.'
          : `Le port ${port} est libéré sur la cible et rendu à la réserve : une autre application pourra le prendre.`,
        'Le répertoire de l’application et toutes ses releases sont effacés de la machine.',
        'L’historique des déploiements reste en base — détruire n’est pas purger.',
        'L’application, elle, n’est pas supprimée : vous pourrez la redéployer ici ou ailleurs.',
      ],
      action: 'Détruire',
      danger: true,
      typeToConfirm: applicationSlug,
    },
  };

  return [lifecycle, rollback, redeploy, destroy];
}
