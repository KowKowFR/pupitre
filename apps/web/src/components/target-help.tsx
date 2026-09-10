'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Aide sur les machines cibles — contenu statique, aucune donnée serveur.
 *
 * Même parti pris que `components/appspec-help.tsx` et `jobs/jobs-help.tsx` :
 * le composant `ui/dialog` reste neutre, tout ce qui parle de cible vit ici.
 * Chaque commande citée est celle des scripts du dépôt
 * (`scripts/setup-test-target.sh`, `scripts/test-target/`), et chaque contrôle
 * décrit est celui de `packages/core/src/ssh/preflight.ts` — dans son ordre
 * d'exécution réel. Les messages d'erreur sont recopiés depuis
 * `packages/core/src/ssh/{client,errors}.ts` et les `DriverError` des drivers.
 */

type Props = {
  label?: string;
  className?: string;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono text-[0.8em]">
      {children}
    </code>
  );
}

/** Un tableau large ne doit jamais élargir la modale : il défile chez lui. */
function ScrollableTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-xs">{children}</table>
    </div>
  );
}

function Shell({ children }: { children: string }) {
  return (
    <pre className="bg-muted/50 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

/** Ce que fait chaque côté. C'est la confusion la plus fréquente. */
const ROLES: Array<{ topic: string; panel: React.ReactNode; target: React.ReactNode }> = [
  {
    topic: 'Rôle',
    panel: <>Orchestre. Il décide, trace, chiffre, ordonnance.</>,
    target: <>Héberge. Elle exécute les conteneurs et sert le trafic.</>,
  },
  {
    topic: 'Où tourne le code de vos applications',
    panel: <>Nulle part. Le panel n’exécute aucune application déployée.</>,
    target: (
      <>
        Ici, et seulement ici. Les images sont même <strong>construites sur la cible</strong>{' '}
        — il n’y a pas de registry entre les deux.
      </>
    ),
  },
  {
    topic: 'Ce qui circule entre les deux',
    panel: <>Une session SSH ouverte par le worker, à la demande.</>,
    target: (
      <>
        Des fichiers déposés sous <Code>/opt/bootstrap/apps/{'{slug}'}/{'{version}'}</Code> et des
        commandes <Code>docker compose</Code> ou <Code>kubectl</Code>.
      </>
    ),
  },
  {
    topic: 'Qui doit être joignable de qui',
    panel: <>Le panel n’a besoin d’aucun port ouvert vers la cible autre que SSH.</>,
    target: (
      <>
        Le <strong>worker</strong> doit joindre <Code>host:port</Code>. Votre navigateur, lui,
        ne parle jamais à la cible.
      </>
    ),
  },
  {
    topic: 'Si le panel tombe',
    panel: <>Plus de déploiement, plus de supervision.</>,
    target: <>Les applications déjà déployées continuent de tourner. Elles ne dépendent pas de lui.</>,
  },
];

const FIELDS: Array<{ name: string; role: React.ReactNode; wrong: React.ReactNode }> = [
  {
    name: 'Nom',
    role: (
      <>
        Étiquette humaine, 2 à 80 caractères. <strong>Unique en base.</strong> C’est ce nom qui
        apparaît dans les logs de déploiement et les avertissements du pare-feu.
      </>
    ),
    wrong: (
      <>
        Nom déjà pris → <Code>409</Code> «&nbsp;Une cible se nomme déjà «&nbsp;…&nbsp;»&nbsp;».
      </>
    ),
  },
  {
    name: 'Hôte',
    role: (
      <>
        IP ou nom DNS, passé tel quel à la connexion SSH. Il est résolu{' '}
        <strong>depuis le conteneur worker</strong>, pas depuis votre poste.
      </>
    ),
    wrong: (
      <>
        Un nom qui ne résout que sur votre machine, ou un <Code>127.0.0.1</Code> qui désigne le
        worker lui-même : «&nbsp;Connexion SSH impossible vers … après 3 tentatives&nbsp;».
      </>
    ),
  },
  {
    name: 'Port',
    role: (
      <>
        Port de <Code>sshd</Code>, 22 par défaut. Le triplet (hôte, port, utilisateur) est
        unique en base — deux lignes ne peuvent pas décrire la même machine.
      </>
    ),
    wrong: (
      <>
        Triplet déjà pris → <Code>409</Code> «&nbsp;Une cible pointe déjà vers
        user@host:port&nbsp;».
      </>
    ),
  },
  {
    name: 'Utilisateur SSH',
    role: (
      <>
        Le compte qui exécutera <em>tout</em> : les <Code>docker build</Code>, les{' '}
        <Code>docker compose up</Code>, les <Code>kubectl apply</Code>, les scanners. Le
        formulaire propose <Code>root</Code> ; un compte dédié membre du groupe{' '}
        <Code>docker</Code> est préférable.
      </>
    ),
    wrong: (
      <>
        Un compte qui ne peut pas parler au démon Docker fait échouer le contrôle{' '}
        <Code>docker</Code> du preflight avec «&nbsp;daemon injoignable&nbsp;», pas la
        connexion.
      </>
    ),
  },
  {
    name: 'Authentification',
    role: (
      <>
        <Code>key</Code> : vous collez une <strong>clé privée</strong>. <Code>password</Code> :
        vous collez un mot de passe. Un seul credential est stocké par cible.
      </>
    ),
    wrong: (
      <>
        Coller la clé <em>publique</em> au lieu de la privée →
        «&nbsp;Authentification SSH refusée&nbsp;». Une clé protégée par passphrase échoue aussi
        (voir plus bas).
      </>
    ),
  },
  {
    name: 'Élévation sudo',
    role: (
      <>
        <Code>nopasswd</Code> enrobe la commande en <Code>sudo -n -- sh -c …</Code> ;{' '}
        <Code>password</Code> en <Code>sudo -S -p &apos;&apos; -- sh -c …</Code>, le mot de passe
        étant poussé par <strong>stdin</strong> — jamais sur la ligne de commande, donc jamais
        dans <Code>ps</Code>.
      </>
    ),
    wrong: (
      <>
        <strong>Le piège</strong> : <Code>password</Code> avec une authentification par{' '}
        <Code>key</Code> lève une <Code>SshConfigError</Code> — il n’y a aucun mot de passe à
        donner à sudo. Les deux vont ensemble.
      </>
    ),
  },
  {
    name: 'Clé privée / Mot de passe',
    role: (
      <>
        Chiffré en <strong>AES-256-GCM</strong> avant insertion. 32 768 caractères au plus. En
        édition, laisser le champ vide conserve le credential déjà en base.
      </>
    ),
    wrong: (
      <>
        Le champ est obligatoire à la création. Il n’est jamais relu : le récupérer plus tard
        est impossible, il faut le remplacer.
      </>
    ),
  },
  {
    name: 'Plage de ports publiables',
    role: (
      <>
        Bornes comprises, entre 1024 et 65535, début ≤ fin. Défaut 30000-32767, la plage{' '}
        <Code>nodePort</Code> de Kubernetes — inoccupée sur une machine standard.
      </>
    ),
    wrong: (
      <>
        Une plage inversée est refusée deux fois : par Zod, puis par la contrainte{' '}
        <Code>targets_port_range_check</Code> en base. Une plage trop étroite épuise les ports
        (section suivante).
      </>
    ),
  },
  {
    name: 'Étiquettes',
    role: (
      <>
        Une paire <Code>clé=valeur</Code> par ligne, libre : <Code>env=prod</Code>,{' '}
        <Code>zone=eu-west</Code>. Purement descriptif.
      </>
    ),
    wrong: <>Une ligne sans <Code>=</Code> est ignorée en silence, pas rejetée.</>,
  },
];

/** Dans l'ordre où `runPreflight()` les exécute. 15 s de délai par contrôle. */
const CHECKS: Array<{ key: string; what: React.ReactNode; failure: React.ReactNode }> = [
  {
    key: 'ssh',
    what: (
      <>
        Ouvre la session et mesure la latence. Trois tentatives, backoff 500&nbsp;ms / 1&nbsp;s /
        2&nbsp;s sur échec réseau — <strong>aucune</strong> sur échec d’authentification.
      </>
    ),
    failure: (
      <>
        <strong>Seul échec fatal.</strong> La cible passe en <Code>unreachable</Code> et aucun
        autre contrôle n’est tenté : sans session, ils n’ont pas de sens.
      </>
    ),
  },
  {
    key: 'os',
    what: (
      <>
        <Code>uname -a</Code> et <Code>/etc/os-release</Code>.
      </>
    ),
    failure: <>Informatif. N’empêche rien.</>,
  },
  {
    key: 'sudo',
    what: (
      <>
        <Code>sudo -n true</Code> puis <Code>command -v sudo</Code>. Le détail vaut réponse :
        «&nbsp;sudo sans mot de passe&nbsp;», «&nbsp;sudo présent, mot de passe requis&nbsp;» ou
        «&nbsp;sudo absent&nbsp;».
      </>
    ),
    failure: (
      <>
        Sans sudo, le pare-feu n’est pas lisible et <Code>/opt/bootstrap</Code> ne pourra pas
        être créé si <Code>/opt</Code> appartient à root.
      </>
    ),
  },
  {
    key: 'tools',
    what: (
      <>
        Un seul aller-retour : <Code>command -v</Code> sur <Code>ufw</Code>, <Code>curl</Code>,{' '}
        <Code>git</Code>, <Code>docker</Code>, <Code>kubectl</Code>.
      </>
    ),
    failure: (
      <>
        Aucun outil n’est obligatoire. L’absence conditionne simplement les contrôles suivants.
      </>
    ),
  },
  {
    key: 'firewall',
    what: (
      <>
        <Code>ufw status</Code> via sudo, et compte les règles portant le commentaire{' '}
        <Code>bootstrap-tp:</Code> — celles que le panel a posées, distinctes de celles de
        l’administrateur.
      </>
    ),
    failure: (
      <>
        «&nbsp;ufw absent&nbsp;» ou «&nbsp;installé mais inactif&nbsp;» n’est pas bloquant. Le
        panel <strong>n’active jamais</strong> un pare-feu lui-même.
      </>
    ),
  },
  {
    key: 'docker',
    what: (
      <>
        <Code>docker info --format &apos;{'{{.ServerVersion}}'}&apos;</Code> et{' '}
        <Code>docker compose version --short</Code>.
      </>
    ),
    failure: (
      <>
        «&nbsp;binaire absent&nbsp;» : rien n’est installé. «&nbsp;daemon injoignable&nbsp;» :
        le binaire est là mais le compte ne parle pas au socket, ou <Code>dockerd</Code> est
        arrêté. C’est presque toujours le groupe <Code>docker</Code>.
      </>
    ),
  },
  {
    key: 'k3s',
    what: (
      <>
        <Code>kubectl get nodes -o json</Code> : nombre de nodes, nodes prêts, version du
        kubelet.
      </>
    ),
    failure: (
      <>
        «&nbsp;kubectl présent mais aucun cluster joignable&nbsp;» : le plus souvent{' '}
        <Code>/etc/rancher/k3s/k3s.yaml</Code> n’est pas <em>lisible</em> par le compte de
        déploiement (voir les pannes fréquentes).
      </>
    ),
  },
  {
    key: 'disk',
    what: (
      <>
        <Code>df -Pk /</Code> — le format POSIX, stable, contrairement à <Code>df -h</Code>.
      </>
    ),
    failure: (
      <>
        Informatif ici. Au déploiement, le driver exige <strong>1 Gio</strong> disponible.
      </>
    ),
  },
  {
    key: 'memory',
    what: (
      <>
        <Code>free -m</Code>, ligne <Code>Mem:</Code>.
      </>
    ),
    failure: <>Informatif.</>,
  },
];

const FAILURES: Array<{ symptom: React.ReactNode; cause: React.ReactNode }> = [
  {
    symptom: (
      <>
        <Code>Permission denied (publickey)</Code>, ou du panel :
        «&nbsp;Authentification SSH refusée (clé ou mot de passe invalide, ou passphrase
        manquante)&nbsp;»
      </>
    ),
    cause: (
      <>
        Quatre causes, par ordre de fréquence. (1) La <strong>clé publique</strong> a été collée
        au lieu de la privée. (2) La clé privée est <strong>protégée par une passphrase</strong>{' '}
        : le panel ne stocke qu’un secret par cible et ne peut pas la fournir — regénérez une
        clé dédiée sans passphrase. (3) Les permissions : <Code>700</Code> sur{' '}
        <Code>~/.ssh</Code>, <Code>600</Code> sur <Code>authorized_keys</Code>, le tout possédé
        par le compte. (4) Le compte est <strong>verrouillé</strong> (<Code>!</Code> dans{' '}
        <Code>/etc/shadow</Code>) : <Code>sshd</Code> le refuse même par clé.
      </>
    ),
  },
  {
    symptom: (
      <>
        «&nbsp;Connexion SSH impossible vers <em>host</em>:<em>port</em> après 3
        tentatives&nbsp;»
      </>
    ),
    cause: (
      <>
        Réseau, DNS ou TCP — l’authentification n’a même pas été tentée. Le nom est résolu par
        le <strong>conteneur worker</strong> : un hostname de votre <Code>/etc/hosts</Code>, ou
        un <Code>localhost</Code> qui désigne votre poste, n’existent pas pour lui.
      </>
    ),
  },
  {
    symptom: (
      <>
        Preflight vert, mais le détail sudo dit «&nbsp;sudo présent, mot de passe requis&nbsp;»
      </>
    ),
    cause: (
      <>
        <Code>sudo -n true</Code> a renvoyé un code non nul. Le compte n’a pas de règle{' '}
        <Code>NOPASSWD</Code>. Tant que <Code>/opt/bootstrap</Code> est écrivable, les
        déploiements passent quand même ; l’ouverture de port UFW, elle, échouera.
      </>
    ),
  },
  {
    symptom: (
      <>
        <Code>SshConfigError</Code> : «&nbsp;sudo_method «&nbsp;password&nbsp;» exige une
        authentification par mot de passe&nbsp;»
      </>
    ),
    cause: (
      <>
        La cible est déclarée en authentification par clé <em>et</em> en sudo par mot de passe.
        Il n’y a alors aucun mot de passe à pousser dans <Code>sudo -S</Code>. Passez la cible
        en <Code>nopasswd</Code>, ou authentifiez-vous par mot de passe.
      </>
    ),
  },
  {
    symptom: (
      <>
        Contrôle <Code>docker</Code> : «&nbsp;daemon injoignable :
        permission denied … /var/run/docker.sock&nbsp;»
      </>
    ),
    cause: (
      <>
        Le compte n’est pas dans le groupe <Code>docker</Code>, ou l’a rejoint dans une session
        déjà ouverte — l’appartenance à un groupe n’est lue qu’à l’ouverture de session.
        Déconnectez-vous, reconnectez-vous, relancez le preflight.
      </>
    ),
  },
  {
    symptom: (
      <>
        Contrôle <Code>k3s</Code> : «&nbsp;kubectl présent mais aucun cluster joignable&nbsp;»
      </>
    ),
    cause: (
      <>
        Le driver n’utilise <strong>pas</strong> sudo pour <Code>kubectl</Code> : il exporte{' '}
        <Code>KUBECONFIG=/etc/rancher/k3s/k3s.yaml</Code> uniquement si ce fichier est{' '}
        <em>lisible</em> par le compte. K3s l’écrit en <Code>0600 root</Code> par défaut.
        Installez K3s avec <Code>--write-kubeconfig-mode 644</Code>, ou déposez une copie dans{' '}
        <Code>~/.kube/config</Code>.
      </>
    ),
  },
  {
    symptom: (
      <>
        «&nbsp;Aucun port libre entre <em>min</em> et <em>max</em> sur «&nbsp;…&nbsp;» :
        N&nbsp;port(s) réservés en base se sont révélés occupés&nbsp;»
      </>
    ),
    cause: (
      <>
        La base a accordé des ports, mais la cible les avait déjà en écoute — un service
        installé à la main, que la base ne peut pas connaître. Le driver relâche la réservation
        et rejoue, jusqu’à épuisement. Élargissez la plage de la cible, ou libérez les ports.
      </>
    ),
  },
  {
    symptom: (
      <>
        «&nbsp;Racine de déploiement inutilisable&nbsp;» /
        «&nbsp;<Code>/opt/bootstrap</Code> n’est pas écrivable et sudo a échoué&nbsp;»
      </>
    ),
    cause: (
      <>
        <Code>/opt</Code> appartient à root sur une machine standard. Le premier déploiement a
        besoin d’une élévation pour créer l’arborescence et la donner au compte ; les suivants
        n’en ont plus besoin. Sans <Code>NOPASSWD</Code>, créez le répertoire à la main.
      </>
    ),
  },
  {
    symptom: (
      <>
        Log de déploiement : «&nbsp;⚠ ufw inactif sur <em>cible</em> — aucune règle posée pour le
        port N&nbsp;»
      </>
    ),
    cause: (
      <>
        Ce n’est pas une erreur. UFW étant inactif, il ne filtre rien et le port est joignable
        de toute façon. Le panel n’active jamais un pare-feu : couper la session SSH qui pilote
        la machine est un risque réel.
      </>
    ),
  },
  {
    symptom: (
      <>
        Suppression refusée : «&nbsp;Cette cible porte N déploiement(s) actif(s)&nbsp;»
      </>
    ),
    cause: (
      <>
        Supprimer la ligne laisserait des conteneurs orphelins sur une machine que le panel ne
        saurait plus joindre. Détruisez les déploiements d’abord.
      </>
    ),
  },
];

export function TargetHelpDialog({ label = 'Qu’est-ce qu’une cible ?', className }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs underline underline-offset-4 outline-none focus-visible:ring-[3px]',
            className,
          )}
        >
          {label}
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Qu&apos;est-ce qu&apos;une cible&nbsp;?</DialogTitle>
          <DialogDescription>
            Une machine Linux jointe en SSH, sur laquelle le panel déploie. Le panel orchestre —
            la cible héberge.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 text-sm">
          <Section title="Le panel n’est pas l’application déployée">
            <p className="text-muted-foreground">
              Déclarer une cible, c’est donner au panel de quoi ouvrir une session SSH sur une
              machine qui vous appartient. Rien n’est installé sur elle à ce moment-là : la
              création n’écrit qu’une ligne en base. La machine n’est touchée qu’au premier
              preflight, et vraiment utilisée qu’au premier déploiement.
            </p>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Le panel</th>
                  <th className="px-3 py-2 font-medium">La cible</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((row) => (
                  <tr key={row.topic} className="border-t align-top">
                    <td className="text-foreground px-3 py-2 font-medium">{row.topic}</td>
                    <td className="text-muted-foreground px-3 py-2">{row.panel}</td>
                    <td className="text-muted-foreground px-3 py-2">{row.target}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">
                <strong className="text-foreground font-medium">
                  Le formulaire ne demande pas de runtime.
                </strong>{' '}
                Vous ne déclarez pas «&nbsp;cette machine est une cible Docker&nbsp;» : c’est le
                preflight qui découvre ce qui est installé, et le renseigne dans les badges
                «&nbsp;Docker ✓ / K3s ✗&nbsp;». Le runtime est une décision du{' '}
                <em>déploiement</em>, pas de la déclaration — c’est ce qui permet de redéployer la
                même application sur l’autre moteur sans rien retoucher ici. En l’état, l’écran de
                déploiement ne propose que les cibles dont le preflight a vu Docker.
              </p>
            </div>
          </Section>

          <Section title="Ce qu’il faut préparer sur la machine">
            <p className="text-muted-foreground">
              Quatre choses, et rien d’autre : un compte, sa clé, un moteur de conteneurs
              joignable par ce compte, et de quoi élever les privilèges quand c’est nécessaire.
              Les commandes ci-dessous sont l’équivalent Debian/Ubuntu de ce que fait la cible de
              test du dépôt (<Code>scripts/test-target/</Code>, en Alpine).
            </p>
            <Shell>{PREPARE_SCRIPT}</Shell>
            <p className="text-muted-foreground text-xs">
              <strong className="text-foreground font-medium">Deux pièges dans ce bloc.</strong>{' '}
              L’appartenance au groupe <Code>docker</Code> n’est lue qu’à l’ouverture d’une
              session : tant que vous n’êtes pas ressorti, <Code>docker info</Code> continue de
              répondre «&nbsp;permission denied&nbsp;». Et l’ordre d’UFW n’est pas négociable —
              autoriser le port 22 <em>avant</em> d’activer, sinon la politique{' '}
              <Code>deny incoming</Code> coupe la session qui pilote la machine, et il n’y a plus
              personne pour la rouvrir.
            </p>
          </Section>

          <Section title="La clé SSH">
            <p className="text-muted-foreground">
              Générez une paire <strong>dédiée au panel</strong>, sans passphrase. Ce n’est pas du
              laxisme : le panel stocke un seul secret par cible et n’a nulle part où mettre une
              passphrase, donc une clé protégée échoue à la connexion. Une clé dédiée se révoque
              en retirant une ligne d’<Code>authorized_keys</Code>, sans toucher à la vôtre.
            </p>
            <Shell>{KEY_SCRIPT}</Shell>
            <p className="text-muted-foreground">
              Dans le formulaire, on colle <strong>la clé privée</strong> — le fichier{' '}
              <em>sans</em> <Code>.pub</Code>, en-têtes{' '}
              <Code>-----BEGIN OPENSSH PRIVATE KEY-----</Code> compris. La publique reste sur la
              machine cible.
            </p>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">
                Elle est chiffrée en <strong className="text-foreground font-medium">
                  AES-256-GCM
                </strong>{' '}
                avant insertion, sous une clé dérivée de <Code>MASTER_KEY</Code> par HKDF-SHA256.
                La valeur en base a la forme <Code>v1:iv:authTag:ciphertext</Code>. Les lectures
                de l’API passent par une projection de colonnes où{' '}
                <Code>encrypted_credential</Code> n’existe pas : la réponse HTTP ne peut pas la
                contenir, même par oubli de filtrage. Le seul point de déchiffrement du projet est
                le handler <Code>target:preflight</Code> du worker, au moment d’ouvrir la session.
                Conséquence à assumer : <strong>le credential ne se relit jamais</strong>. Pour en
                changer, on le remplace.
              </p>
            </div>
          </Section>

          <Section title="Chaque champ du formulaire">
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Champ</th>
                  <th className="px-3 py-2 font-medium">Ce que le panel en fait</th>
                  <th className="px-3 py-2 font-medium">Si c’est faux</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((field) => (
                  <tr key={field.name} className="border-t align-top">
                    <td className="text-foreground px-3 py-2 font-medium whitespace-nowrap">
                      {field.name}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">{field.role}</td>
                    <td className="text-muted-foreground px-3 py-2">{field.wrong}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
          </Section>

          <Section title="La plage de ports, à part">
            <p className="text-muted-foreground">
              Elle mérite sa section parce qu’elle est le seul champ du formulaire qui décrit
              quelque chose d’extérieur au panel : ce que cette machine-là accepte de publier.
              Une application déployée en Docker Compose et exposée y réserve un port, sur lequel
              le driver publie et pose une règle UFW commentée{' '}
              <Code>bootstrap-tp:{'{slug}'}</Code>.
            </p>
            <ul className="text-muted-foreground list-disc space-y-1.5 pl-5">
              <li>
                <strong className="text-foreground font-medium">
                  L’anti-collision n’est pas un <Code>if</Code>.
                </strong>{' '}
                C’est la contrainte unique <Code>port_allocations (target_id, port)</Code>.
                L’allocation ne fait jamais «&nbsp;SELECT puis INSERT&nbsp;» : elle insère, et une
                violation renvoie le perdant au tirage suivant. Deux workers simultanés ne peuvent
                pas obtenir le même port.
              </li>
              <li>
                <strong className="text-foreground font-medium">
                  La base ne connaît pas la machine.
                </strong>{' '}
                Un service installé à la main qui écoute déjà sur le port tiré est invisible pour
                elle. Le driver le constate après coup (<Code>ss -tlnH</Code>, ou{' '}
                <Code>netstat -tln</Code> sur les images sans <Code>iproute2</Code>), abandonne la
                réservation et rejoue en excluant ce port.
              </li>
              <li>
                <strong className="text-foreground font-medium">
                  Le pare-feu est une seconde barrière, pas la même.
                </strong>{' '}
                Le panel ouvre le port sur UFW s’il est actif et si sudo le permet. Un pare-feu
                <em>hors</em> de la machine — groupe de sécurité d’un hébergeur, box — est hors de
                sa portée : c’est à vous d’y ouvrir la plage.
              </li>
              <li>
                <strong className="text-foreground font-medium">
                  Le worker a sa propre plage.
                </strong>{' '}
                <Code>DRIVER_PORT_RANGE</Code> décrit ce que l’environnement du worker peut
                atteindre. Les deux sont vraies : c’est <strong>l’intersection</strong> qui est
                retenue. Si elles ne se recouvrent pas, la plage de la cible l’emporte et le log
                du déploiement le dit.
              </li>
              <li>
                Une plage étroite se remplit vite : la cible de test du dépôt tient sur dix ports
                (30000-30009), soit dix applications exposées. Le panneau d’une cible affiche la
                jauge et la table application → port.
              </li>
            </ul>
          </Section>

          <Section title="Le preflight, contrôle par contrôle">
            <p className="text-muted-foreground">
              Le preflight est une tâche BullMQ, pas un appel HTTP : le bouton
              «&nbsp;Tester la connexion&nbsp;» l’enfile et suit la tâche. Règle de conception —{' '}
              <strong className="text-foreground font-medium">
                chaque contrôle est indépendant
              </strong>
              . Un <Code>kubectl</Code> absent marque K3s indisponible, il ne fait pas échouer le
              preflight. Chaque contrôle dispose de 15 secondes.
            </p>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Contrôle</th>
                  <th className="px-3 py-2 font-medium">Ce qu’il lance</th>
                  <th className="px-3 py-2 font-medium">Ce que son échec veut dire</th>
                </tr>
              </thead>
              <tbody>
                {CHECKS.map((check, index) => (
                  <tr key={check.key} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-muted-foreground mr-1.5 text-[0.7rem] tabular-nums">
                        {index + 1}.
                      </span>
                      <code className="text-foreground font-mono text-[0.75rem]">{check.key}</code>
                    </td>
                    <td className="text-muted-foreground px-3 py-2">{check.what}</td>
                    <td className="text-muted-foreground px-3 py-2">{check.failure}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <p className="text-muted-foreground text-xs">
              Le statut qui en sort tient en trois valeurs.{' '}
              <Code>ok</Code>&nbsp;: au moins un runtime exploitable — Docker disponible, ou K3s
              avec un node prêt — et aucun contrôle en échec. <Code>degraded</Code>&nbsp;: la
              machine répond, mais rien n’y est déployable, ou un contrôle a échoué.{' '}
              <Code>unreachable</Code>&nbsp;: la session SSH n’a pas pu s’ouvrir. Le rapport
              complet est conservé et relisible sur la page de la cible.
            </p>
          </Section>

          <Section title="De la machine nue à la première application">
            <ol className="space-y-2.5">
              {TUTORIAL.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="bg-muted text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="text-foreground font-medium">{step.title}</div>
                    <div className="text-muted-foreground text-xs">{step.body}</div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-muted-foreground text-xs">
              Sans machine sous la main, <Code>./scripts/setup-test-target.sh</Code> monte un
              conteneur docker-in-docker qui porte son propre démon Docker, y installe une clé
              jetable et enregistre la cible — les étapes 1 à 7 en une commande.
            </p>
          </Section>

          <Section title="Les pannes fréquentes">
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Ce que vous lisez</th>
                  <th className="px-3 py-2 font-medium">Ce que c’est</th>
                </tr>
              </thead>
              <tbody>
                {FAILURES.map((failure, index) => (
                  <tr key={index} className="border-t align-top">
                    <td className="text-foreground px-3 py-2 md:w-2/5">{failure.symptom}</td>
                    <td className="text-muted-foreground px-3 py-2">{failure.cause}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
          </Section>
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              Fermer
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TUTORIAL: Array<{ title: string; body: React.ReactNode }> = [
  {
    title: 'Une machine Linux joignable en SSH depuis le worker',
    body: (
      <>
        VM, VPS, serveur physique. Vérifiez depuis le conteneur qui déploie, pas depuis votre
        poste&nbsp;: <Code>docker compose exec worker sh -lc &apos;nc -z 10.0.0.12 22&apos;</Code>
        . C’est lui qui ouvrira la session.
      </>
    ),
  },
  {
    title: 'Un compte de déploiement dédié',
    body: (
      <>
        Pas <Code>root</Code> si vous pouvez l’éviter&nbsp;:{' '}
        <Code>sudo adduser --disabled-password --gecos &apos;&apos; deploy</Code>. Il portera
        toutes les commandes du panel.
      </>
    ),
  },
  {
    title: 'La clé, sans passphrase, déposée sur la machine',
    body: (
      <>
        <Code>ssh-keygen -t ed25519 -N &apos;&apos; -f ~/.ssh/tp-deploy</Code> puis{' '}
        <Code>ssh-copy-id -i ~/.ssh/tp-deploy.pub deploy@10.0.0.12</Code>. Testez avec{' '}
        <Code>ssh -i ~/.ssh/tp-deploy deploy@10.0.0.12 true</Code> avant d’aller plus loin.
      </>
    ),
  },
  {
    title: 'Docker, ou K3s, ou les deux',
    body: (
      <>
        Le panel n’installe rien. Pour Docker, ajoutez le compte au groupe <Code>docker</Code> —
        sans quoi tout le reste échouera sur «&nbsp;daemon injoignable&nbsp;». Pour K3s,
        installez-le avec un kubeconfig lisible (<Code>--write-kubeconfig-mode 644</Code>).
      </>
    ),
  },
  {
    title: 'sudo sans mot de passe',
    body: (
      <>
        Nécessaire pour créer <Code>/opt/bootstrap</Code> au premier déploiement et pour poser
        les règles UFW. Vérifiez exactement ce que vérifie le preflight&nbsp;:{' '}
        <Code>sudo -n true</Code>.
      </>
    ),
  },
  {
    title: 'Le pare-feu, si vous en avez un',
    body: (
      <>
        Ouvrez 22, puis la plage que vous déclarerez au panel. Si le filtrage est en amont
        (groupe de sécurité, box), c’est là qu’il faut ouvrir&nbsp;: UFW n’y peut rien.
      </>
    ),
  },
  {
    title: 'Déclarer la cible dans le panel',
    body: (
      <>
        Le formulaire de cette page. Nom, hôte, port, compte, clé privée collée, sudo{' '}
        <Code>nopasswd</Code>, et une plage de ports qui corresponde à ce que vous venez
        d’ouvrir.
      </>
    ),
  },
  {
    title: 'Lancer le preflight',
    body: (
      <>
        Bouton «&nbsp;Tester la connexion&nbsp;», depuis la liste ou la page de la cible. Vous
        attendez des badges «&nbsp;Docker ✓&nbsp;» ou «&nbsp;K3s ✓&nbsp;» et un statut{' '}
        <Code>ok</Code>. Un statut <Code>degraded</Code> avec deux runtimes absents signifie que
        la machine répond mais que rien n’y est déployable.
      </>
    ),
  },
  {
    title: 'Créer une application',
    body: (
      <>
        <em>Applications → Nouvelle application</em>, depuis une description ou un JSON. Une
        AppSpec ne connaît ni Docker ni Kubernetes&nbsp;; la modale{' '}
        «&nbsp;Qu’est-ce qu’une AppSpec&nbsp;?&nbsp;» de cette page-là détaille les champs.
      </>
    ),
  },
  {
    title: 'Déployer, et regarder les étapes',
    body: (
      <>
        Choisissez la cible — seules celles dont le preflight a vu Docker sont proposées — et la
        politique de scan. Le déploiement est une tâche&nbsp;: la page de suivi montre les étapes
        à gauche et les logs en direct à droite. Une cible qui porte un déploiement vivant n’est
        plus supprimable, c’est voulu.
      </>
    ),
  },
];

const PREPARE_SCRIPT = `# 1 — un compte dédié pour le panel
sudo adduser --disabled-password --gecos '' deploy

# 2 — Docker, et surtout : le compte parle au démon SANS sudo
curl -fsSL https://get.docker.com | sh        # script officiel Docker
sudo usermod -aG docker deploy                # ← indispensable
#    ou, pour une cible Kubernetes :
curl -sfL https://get.k3s.io | \\
  INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
#    644 n'est pas cosmétique : le driver lit /etc/rancher/k3s/k3s.yaml
#    sans sudo, et K3s l'écrit en 0600 root par défaut.

# 3 — sudo sans mot de passe (création de /opt/bootstrap, règles UFW)
echo 'deploy ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/deploy
sudo chmod 0440 /etc/sudoers.d/deploy

# 4 — le pare-feu. L'ORDRE COMPTE : autoriser 22 AVANT d'activer.
sudo ufw allow 22/tcp
sudo ufw allow 30000:32767/tcp                # la plage que vous déclarerez
sudo ufw --force enable

# 5 — se reconnecter, puis vérifier ce que le preflight vérifiera
exit
ssh -i ~/.ssh/tp-deploy deploy@10.0.0.12 '
  sudo -n true && echo "sudo   : nopasswd ok"
  docker info --format "{{.ServerVersion}}"
  docker compose version --short
'`;

const KEY_SCRIPT = `# sur VOTRE poste — une paire dédiée, sans passphrase (-N '')
ssh-keygen -t ed25519 -N '' -C 'bootstrap-tp' -f ~/.ssh/tp-deploy

# la publique part sur la cible
ssh-copy-id -i ~/.ssh/tp-deploy.pub deploy@10.0.0.12

# … ou à la main, avec les permissions exactes qu'exige sshd
#   mkdir -p ~/.ssh && chmod 700 ~/.ssh
#   cat >> ~/.ssh/authorized_keys        # coller tp-deploy.pub
#   chmod 600 ~/.ssh/authorized_keys
#   chown -R deploy:deploy ~/.ssh

# vérifier AVANT de remplir le formulaire
ssh -i ~/.ssh/tp-deploy deploy@10.0.0.12 true && echo 'clé acceptée'

# c'est le contenu de CE fichier-ci que l'on colle dans le formulaire
cat ~/.ssh/tp-deploy`;
