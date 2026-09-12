import { stringify } from 'yaml';
import { MANAGED_BY } from './render.js';

/**
 * Le constructeur d'images du runtime K3s.
 *
 * ── Le problème ──────────────────────────────────────────────────────────────
 *
 * CLAUDE.md a tranché : « build des images sur la machine cible, pas de
 * registry ». Sur une cible Docker, le démon sait construire *et* stocker, et
 * le tour est joué. Sur un nœud K3s il n'y a pas de démon Docker : containerd
 * sait exécuter une image et `k3s ctr` sait en importer une, mais **personne ne
 * sait en construire une**. Il manquait donc la moitié du geste.
 *
 * ── Ce qu'on apporte, et pourquoi celui-là ───────────────────────────────────
 *
 * BuildKit, déployé **dans le cluster** par le driver lui-même. Trois raisons
 * de le préférer aux autres candidats :
 *
 * - **kaniko** ne sait pas écrire dans le containerd du nœud : il pousse vers
 *   un registry, ou il écrit un tar. Sans registry, on retombe sur le tar — et
 *   kaniko n'est plus maintenu depuis 2024. Aucun gain sur BuildKit.
 * - **`nerdctl build`** suppose nerdctl *et* buildkitd installés sur le nœud.
 *   Le panel ne provisionne pas ses cibles ; il n'a aucun moyen de les y poser.
 * - **BuildKit en pod** ne suppose rien du nœud sinon un cluster qui accepte un
 *   pod privilégié. Le cluster tire l'image du constructeur lui-même. C'est le
 *   seul candidat qui n'exige aucune installation préalable.
 *
 * ── Worker OCI, et non worker containerd ─────────────────────────────────────
 *
 * BuildKit sait parler directement au containerd du nœud
 * (`--containerd-worker`) : l'image construite atterrirait alors *toute seule*
 * dans l'espace `k8s.io`, sans tar intermédiaire. C'est la solution élégante,
 * et elle a été essayée en premier. Elle échoue, et pas pour une broutille :
 *
 *   1. les étapes `RUN` sont exécutées par le shim de containerd, qui tourne
 *      **sur l'hôte**. Les montages que buildkitd prépare dans le pod ne lui
 *      sont pas visibles : « failed to mount rootfs component » ;
 *   2. les rendre visibles exige `mountPropagation: Bidirectional` sur
 *      `/var/lib/buildkit`, ce que kubelet refuse si la racine du nœud n'est
 *      pas un montage partagé. Mesuré sur la cible de test :
 *      « path "/var/lib/buildkit" is mounted on "/" but it is not a shared
 *      mount ».
 *
 * Un nœud Linux sous systemd a bien `/` en `shared` — mais pas un nœud en
 * conteneur, et on n'a aucun moyen de le savoir avant d'essayer. Le worker OCI
 * exécute `runc` **à l'intérieur du pod** : rien à propager, rien à supposer de
 * la topologie de montage du nœud, et aucun chemin de données containerd à
 * deviner. On paie ce choix d'un aller-retour par un tar OCI, que
 * `k3s ctr images import` reprend ensuite — exactement le geste que le driver
 * faisait déjà après `docker save`.
 *
 * ── Le tar ne transite pas par le réseau ─────────────────────────────────────
 *
 * `kubectl exec ... -- cat` le lit depuis le pod et le tube l'envoie directement
 * dans `k3s ctr images import`, sur la même machine. Rien n'est poussé nulle
 * part : la décision « pas de registry » tient.
 */

/**
 * Un namespace à part, et non `kube-system`.
 *
 * Le constructeur n'appartient à aucune application — il sert toutes les
 * cibles d'un même cluster — mais il n'appartient pas non plus au cluster :
 * c'est le panel qui l'a posé, et `SYSTEM_NAMESPACES` protège précisément
 * `kube-system` de ce que le panel y ferait.
 */
export const BUILDER_NAMESPACE = `${MANAGED_BY}-build`;

export const BUILDER_DEPLOYMENT = 'buildkitd';

/**
 * Version épinglée, jamais `latest` : le constructeur fait partie de la chaîne
 * de fabrication des images déployées. Une image qui change sous nos pieds
 * changerait le résultat d'un déploiement sans qu'aucune AppSpec ait bougé.
 */
export const BUILDKIT_IMAGE = 'moby/buildkit:v0.28.1';

/** Volume de travail du pod : contexte reçu et tar produit. */
const WORK_DIR = '/work';
const CONTEXT_DIR = `${WORK_DIR}/context`;
const IMAGE_TAR = `${WORK_DIR}/image.tar`;

/** Délimiteur du heredoc qui porte les manifests. Quoté : aucune expansion. */
const HEREDOC = 'PUPITRE_BUILDER_MANIFEST';

/**
 * Échappement POSIX en quotes simples.
 *
 * Dupliqué depuis `driver.ts` pour la raison qui y est déjà écrite : un module
 * qui fabrique des commandes ne doit pas dépendre du module qui les exécute.
 */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function builderNamespaceManifest(): string {
  return stringify({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: BUILDER_NAMESPACE,
      labels: { 'app.kubernetes.io/managed-by': MANAGED_BY },
    },
  });
}

/**
 * Le `spec` du pod constructeur, seul et complet.
 *
 * Isolé parce que le preflight en a besoin **hors** de son Deployment : le
 * contrôle d'admission PodSecurity valide des Pods, pas des contrôleurs. Un
 * `--dry-run=server` sur le Deployment sort en code 0 avec un simple
 * avertissement sur stderr, même sous `enforce=restricted` — mesuré. Le même
 * `spec` soumis en Pod est refusé net, code 1. C'est donc celui-là qu'on
 * soumet.
 */
function builderPodSpec(): Record<string, unknown> {
  return {
    containers: [
      {
        name: BUILDER_DEPLOYMENT,
        image: BUILDKIT_IMAGE,
        args: [
          // Worker OCI : `runc` tourne dans ce pod. Voir l'en-tête du
          // module pour ce que le worker containerd aurait exigé du nœud.
          '--oci-worker=true',
          '--containerd-worker=false',
          '--addr=unix:///run/buildkit/buildkitd.sock',
        ],
        // BuildKit crée des namespaces et monte des overlays : sans
        // privilège, aucune étape `RUN` ne démarre. C'est le prix du
        // constructeur, et c'est ce que le preflight vérifie que
        // l'admission du cluster accepte.
        securityContext: { privileged: true },
        volumeMounts: [
          { name: 'buildkit', mountPath: '/var/lib/buildkit' },
          { name: 'work', mountPath: WORK_DIR },
        ],
        // Le seul état qui fasse foi : buildctl répond, donc le worker est
        // enregistré. Un pod « Running » dont le daemon n'a pas fini de
        // s'enregistrer ferait échouer le premier build.
        readinessProbe: {
          exec: { command: ['buildctl', 'debug', 'workers'] },
          initialDelaySeconds: 2,
          periodSeconds: 3,
          failureThreshold: 40,
        },
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
        },
      },
    ],
    volumes: [
      // `emptyDir` et non PVC : le cache de couches vit aussi longtemps que le
      // pod, ce qui suffit à enchaîner les services d'une même AppSpec sans
      // retélécharger chaque image de base. Un PVC ferait survivre le cache aux
      // redémarrages, au prix d'un volume que personne ne réclamerait jamais —
      // arbitrage assumé.
      { name: 'buildkit', emptyDir: {} },
      { name: 'work', emptyDir: {} },
    ],
  };
}

/**
 * Le Pod que le preflight soumet à l'admission, et qu'il ne crée jamais.
 *
 * Même `spec` que le constructeur réel, à la lettre : un contrôle qui
 * porterait sur autre chose ne prouverait rien.
 */
export function builderAdmissionProbeManifest(): string {
  return stringify({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: `${BUILDER_DEPLOYMENT}-preflight`,
      namespace: BUILDER_NAMESPACE,
    },
    spec: builderPodSpec(),
  });
}

export function builderDeploymentManifest(): string {
  return stringify({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: BUILDER_DEPLOYMENT,
      namespace: BUILDER_NAMESPACE,
      // Volontairement **sans** `app.kubernetes.io/managed-by` : ce label rend
      // une charge « gérée par le panel » aux yeux de l'écran des charges, qui
      // refuse alors de la supprimer en renvoyant vers la destruction du
      // déploiement correspondant — or il n'y en a aucun. Le constructeur doit
      // au contraire rester supprimable à la main : le prochain build le
      // repose. Le nom du namespace dit déjà d'où il vient.
      labels: {
        'app.kubernetes.io/name': BUILDER_DEPLOYMENT,
        'app.kubernetes.io/component': 'image-builder',
      },
    },
    spec: {
      replicas: 1,
      // `Recreate` et non `RollingUpdate` : deux buildkitd se disputeraient le
      // verrou de `--root`, et le nouveau planterait sur « could not lock
      // buildkitd.lock ». Mesuré, pas supposé.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: { 'app.kubernetes.io/name': BUILDER_DEPLOYMENT } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': BUILDER_DEPLOYMENT } },
        spec: builderPodSpec(),
      },
    },
  });
}

/** `kubectl apply` alimenté par un heredoc : rien à déposer sur la cible. */
export function applyManifestCommand(manifest: string, dryRun = false): string {
  return [
    `kubectl apply ${dryRun ? '--dry-run=server ' : ''}-f - <<'${HEREDOC}'`,
    manifest.trimEnd(),
    HEREDOC,
  ].join('\n');
}

export function rolloutStatusCommand(timeout: string): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} rollout status ` +
    `deploy/${BUILDER_DEPLOYMENT} --timeout=${timeout}`
  );
}

/**
 * Le contexte de build voyage par l'entrée standard de `kubectl exec`.
 *
 * Il est déjà sur le nœud — `upload()` l'y a déposé — mais dans le système de
 * fichiers du **nœud**, pas dans celui du pod. Un `hostPath` le rendrait
 * visible sans copie ; on ne le fait pas, parce qu'un `hostPath` sur la racine
 * de déploiement donnerait au constructeur la lecture de toutes les releases de
 * toutes les applications, secrets rendus compris. Un tar dans un tube ne
 * transmet que le contexte du service qu'on construit.
 */
export function pushContextCommand(hostContextDir: string): string {
  const unpack = `rm -rf ${CONTEXT_DIR} && mkdir -p ${CONTEXT_DIR} && tar -xf - -C ${CONTEXT_DIR}`;
  return (
    `tar -C ${quote(hostContextDir)} -cf - . | ` +
    `kubectl -n ${BUILDER_NAMESPACE} exec -i deploy/${BUILDER_DEPLOYMENT} -- sh -c ${quote(unpack)}`
  );
}

/**
 * `--output type=oci` plutôt que `type=image` : le worker OCI n'a pas de
 * magasin d'images où enregistrer le résultat. Le nom voyage dans l'index du
 * tar, et c'est lui que `ctr images import` reprendra.
 */
export function buildCommand(tag: string, dockerfile: string): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} exec deploy/${BUILDER_DEPLOYMENT} -- ` +
    'buildctl build --frontend dockerfile.v0 ' +
    `--local context=${CONTEXT_DIR} --local dockerfile=${CONTEXT_DIR} ` +
    `--opt filename=${quote(dockerfile)} ` +
    `--output ${quote(`type=oci,name=${tag},dest=${IMAGE_TAR}`)}`
  );
}

/**
 * Le tar sort du pod et entre dans containerd sans toucher le disque du nœud.
 *
 * `-n k8s.io` est explicite alors que `k3s ctr` l'a déjà par défaut : c'est
 * **le** point du problème. Une image importée dans un autre espace de noms est
 * invisible du kubelet, et le pod resterait en `ImagePullBackOff` en cherchant
 * sur docker.io une image qui est déjà sur la machine.
 */
export function importCommand(): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} exec deploy/${BUILDER_DEPLOYMENT} -- cat ${IMAGE_TAR} | ` +
    'k3s ctr -n k8s.io images import -'
  );
}

/** Le tar pèse le poids de l'image : on ne le laisse pas dans le pod. */
export function discardTarCommand(): string {
  return (
    `kubectl -n ${BUILDER_NAMESPACE} exec deploy/${BUILDER_DEPLOYMENT} -- ` +
    `rm -f ${IMAGE_TAR}`
  );
}
