'use client';

import * as React from 'react';
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
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Aide sur l'AppSpec — contenu statique, aucune donnée serveur.
 *
 * Le composant `ui/dialog.tsx` reste neutre et réutilisable ; tout ce qui parle
 * d'AppSpec vit ici. Le contenu suit `packages/core/src/spec/app-spec.ts` et les
 * deux rendus `drivers/docker/render.ts` et `drivers/k3s/render.ts` : chaque
 * contrainte citée est celle du schéma Zod, pas une approximation.
 */

type Props = {
  /** Libellé du déclencheur. Le défaut convient à la plupart des pages. */
  label?: string;
  className?: string;
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
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

const FIELDS: Array<{ name: string; role: string; constraint: React.ReactNode }> = [
  {
    name: 'name',
    role: "Identifie l'application. Sert de préfixe partout.",
    constraint: (
      <>
        slug en kebab-case, 2 à 48 caractères : minuscules, chiffres et tirets (
        <Code>demo-api</Code>).
      </>
    ),
  },
  {
    name: 'version',
    role: "Version de l'application, figée dans chaque déploiement.",
    constraint: (
      <>
        semver 2.0.0 — <Code>1.4.2</Code>, pré-version et build acceptés.
      </>
    ),
  },
  {
    name: 'services[]',
    role: 'Les processus qui composent l’application.',
    constraint: <>au moins un.</>,
  },
  {
    name: 'services[].name',
    role: 'Nom du service. C’est aussi son nom sur le réseau interne.',
    constraint: <>même slug que <Code>name</Code>, unique dans la spec.</>,
  },
  {
    name: 'services[].source',
    role: 'D’où vient le code : une image déjà publiée, ou des sources à construire.',
    constraint: (
      <>
        union discriminée sur <Code>type</Code>. <Code>image</Code> → <Code>ref</Code> (le tag,
        1 à 512 caractères). <Code>dockerfile</Code> → <Code>context</Code> (répertoire relatif
        au bundle envoyé sur la cible) et <Code>dockerfile</Code> (relatif au contexte, défaut{' '}
        <Code>Dockerfile</Code>).
      </>
    ),
  },
  {
    name: 'services[].port',
    role: 'Le port sur lequel le service écoute, dans son conteneur.',
    constraint: <>entier, 1 à 65535.</>,
  },
  {
    name: 'services[].exposed',
    role: 'Désigne la porte d’entrée de l’application.',
    constraint: <>booléen, défaut <Code>false</Code>. Exactement un service à <Code>true</Code>.</>,
  },
  {
    name: 'services[].replicas',
    role: 'Nombre d’instances souhaitées.',
    constraint: <>entier, 1 à 50, défaut <Code>1</Code>.</>,
  },
  {
    name: 'services[].env',
    role: 'Variables d’environnement, valeurs littérales. Rien de sensible.',
    constraint: (
      <>
        objet. Clés en <Code>MAJUSCULES_AVEC_UNDERSCORES</Code>, valeurs de 4096 caractères au
        plus. Défaut <Code>{'{}'}</Code>.
      </>
    ),
  },
  {
    name: 'services[].secrets',
    role: 'Noms des valeurs sensibles. Les valeurs vivent ailleurs, chiffrées.',
    constraint: (
      <>
        tableau de noms, même forme que les clés d’<Code>env</Code>. Défaut <Code>[]</Code>.
        Jamais de valeur ici.
      </>
    ),
  },
  {
    name: 'services[].resources',
    role: 'Ce que le service demande à la machine.',
    constraint: (
      <>
        <Code>cpuMilli</Code> 10 à 64000 (défaut 500), <Code>memoryMi</Code> 16 à 262144
        (défaut 512).
      </>
    ),
  },
  {
    name: 'services[].healthcheck',
    role: 'Comment savoir que le service est vivant.',
    constraint: (
      <>
        <Code>path</Code> commence par <Code>/</Code> (défaut <Code>/</Code>),{' '}
        <Code>port</Code> facultatif (défaut : le <Code>port</Code> du service),{' '}
        <Code>intervalSec</Code> 1 à 300 (défaut 10), <Code>timeoutSec</Code> 1 à 120 (défaut 5),{' '}
        <Code>retries</Code> 1 à 50 (défaut 3).
      </>
    ),
  },
  {
    name: 'services[].volumes',
    role: 'Ce qui doit survivre au redémarrage du service.',
    constraint: (
      <>
        <Code>name</Code> slug, unique dans le service ; <Code>mountPath</Code> absolu ;{' '}
        <Code>size</Code> facultative, au format <Code>10Gi</Code> / <Code>500Mi</Code>.
      </>
    ),
  },
  {
    name: 'services[].dependsOn',
    role: 'Ce qui doit être prêt avant ce service.',
    constraint: (
      <>
        tableau de noms de services. Défaut <Code>[]</Code>. Pas d’auto-référence, pas de cycle.
      </>
    ),
  },
  {
    name: 'ingress',
    role: 'Le nom de domaine par lequel on joint l’application. Bloc facultatif.',
    constraint: (
      <>
        <Code>host</Code> facultatif, 1 à 253 caractères — absent, le panel expose sur un port
        alloué, sans domaine. <Code>tls</Code> booléen, défaut <Code>false</Code>.{' '}
        <Code>targetService</Code> obligatoire : le slug d’un service de la spec.
      </>
    ),
  },
];

const GUARDS: Array<{ rule: string; why: string }> = [
  {
    rule: 'Exactement un service porte `exposed: true`',
    why: 'Zéro service exposé : personne ne peut joindre l’application. Deux : le panel ne sait plus lequel publier, ni lequel sonder.',
  },
  {
    rule: 'Les noms de services sont uniques',
    why: 'Le nom est aussi l’adresse réseau interne. Deux services homonymes rendraient `API_URL=http://api:8080` ambigu.',
  },
  {
    rule: 'Chaque `dependsOn` désigne un service existant',
    why: 'Une dépendance vers un service absent bloquerait le démarrage sans jamais aboutir. Un service ne peut pas non plus dépendre de lui-même.',
  },
  {
    rule: 'Le graphe `dependsOn` n’a pas de cycle',
    why: 'Parcours en profondeur du graphe. `api → db → api` n’a pas d’ordre de démarrage : le message d’erreur nomme le cycle trouvé.',
  },
  {
    rule: '`ingress.targetService` désigne un service existant',
    why: 'Sinon la route publique pointerait dans le vide, et l’erreur n’apparaîtrait qu’au déploiement.',
  },
  {
    rule: 'Une clé n’est jamais à la fois dans `env` et dans `secrets`',
    why: 'Deux origines pour une même variable, dont une en clair dans la spec. On refuse plutôt que de choisir à votre place.',
  },
];

const MAPPING: Array<{ field: React.ReactNode; docker: React.ReactNode; k3s: React.ReactNode }> = [
  {
    field: <Code>name</Code>,
    docker: (
      <>
        projet Compose <Code>app-{'{slug}'}</Code>, réseau <Code>app-{'{slug}'}-net</Code>
      </>
    ),
    k3s: (
      <>
        namespace <Code>app-{'{slug}'}</Code>
      </>
    ),
  },
  {
    field: <Code>version</Code>,
    docker: (
      <>
        tag de l’image construite, label <Code>tp.version</Code>
      </>
    ),
    k3s: (
      <>
        tag de l’image, label <Code>app.kubernetes.io/version</Code>
      </>
    ),
  },
  {
    field: <Code>services[]</Code>,
    docker: (
      <>
        une entrée sous <Code>services:</Code>
      </>
    ),
    k3s: (
      <>
        un <Code>Deployment</Code> et un <Code>Service</Code> de type <Code>ClusterIP</Code>
      </>
    ),
  },
  {
    field: (
      <>
        <Code>source</Code> = <Code>image</Code>
      </>
    ),
    docker: (
      <>
        <Code>image:</Code>
      </>
    ),
    k3s: (
      <>
        <Code>image:</Code>
      </>
    ),
  },
  {
    field: (
      <>
        <Code>source</Code> = <Code>dockerfile</Code>
      </>
    ),
    docker: (
      <>
        <Code>build: {'{ context, dockerfile }'}</Code>, image bâtie sur la cible
      </>
    ),
    k3s: (
      <>
        image bâtie sur le node, <Code>imagePullPolicy: IfNotPresent</Code>
      </>
    ),
  },
  {
    field: <Code>port</Code>,
    docker: (
      <>
        <Code>expose:</Code>
      </>
    ),
    k3s: (
      <>
        <Code>containerPort</Code> et port du <Code>Service</Code>
      </>
    ),
  },
  {
    field: <Code>exposed</Code>,
    docker: (
      <>
        <Code>ports: &quot;{'<port alloué>'}:{'<port>'}&quot;</Code>, plus une règle UFW
      </>
    ),
    k3s: <>aucun port hôte — l’entrée passe par l’Ingress</>,
  },
  {
    field: <Code>replicas</Code>,
    docker: (
      <>
        <Code>deploy.replicas</Code> (au-delà de 1)
      </>
    ),
    k3s: (
      <>
        <Code>spec.replicas</Code>
      </>
    ),
  },
  {
    field: <Code>env</Code>,
    docker: (
      <>
        <Code>environment:</Code>
      </>
    ),
    k3s: (
      <>
        <Code>ConfigMap</Code> <Code>{'{service}'}-env</Code>, injectée par <Code>envFrom</Code>
      </>
    ),
  },
  {
    field: <Code>secrets[]</Code>,
    docker: (
      <>
        fichier <Code>.env</Code> déposé en <Code>0600</Code> — jamais dans le{' '}
        <Code>compose.yml</Code>
      </>
    ),
    k3s: (
      <>
        <Code>Secret</Code> <Code>{'{service}'}-secrets</Code>, manifest écrit en{' '}
        <Code>0600</Code>
      </>
    ),
  },
  {
    field: <Code>resources</Code>,
    docker: (
      <>
        <Code>deploy.resources.limits</Code> (<Code>cpus</Code>, <Code>memory</Code>)
      </>
    ),
    k3s: (
      <>
        <Code>requests</Code> et <Code>limits</Code> du conteneur
      </>
    ),
  },
  {
    field: <Code>healthcheck</Code>,
    docker: (
      <>
        <Code>healthcheck:</Code> — sonde HTTP pour le service exposé, test TCP pour les autres
      </>
    ),
    k3s: (
      <>
        <Code>readinessProbe</Code> et <Code>livenessProbe</Code> — <Code>httpGet</Code> ou{' '}
        <Code>tcpSocket</Code>, même règle
      </>
    ),
  },
  {
    field: <Code>volumes[]</Code>,
    docker: (
      <>
        volume nommé <Code>app-{'{slug}'}-{'{service}'}-{'{volume}'}</Code>
      </>
    ),
    k3s: (
      <>
        <Code>PersistentVolumeClaim</Code> sur la classe <Code>local-path</Code> ;{' '}
        <Code>size</Code> devient la demande de stockage (défaut <Code>1Gi</Code>)
      </>
    ),
  },
  {
    field: <Code>dependsOn</Code>,
    docker: (
      <>
        <Code>depends_on</Code> avec <Code>condition: service_healthy</Code>
      </>
    ),
    k3s: <>ordre d’application des manifests ; la readiness fait le reste</>,
  },
  {
    field: (
      <>
        <Code>ingress.host</Code> / <Code>tls</Code>
      </>
    ),
    docker: <>route Traefik posée par le ProxyProvider, hors du compose</>,
    k3s: (
      <>
        <Code>Ingress</Code> de classe <Code>traefik</Code>, bloc <Code>tls</Code> si demandé
      </>
    ),
  },
];

export function AppSpecHelpDialog({ label = "Qu'est-ce qu'une AppSpec ?", className }: Props) {
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
          <DialogTitle>Qu&apos;est-ce qu&apos;une AppSpec&nbsp;?</DialogTitle>
          <DialogDescription>
            La description neutre d&apos;une application. Elle dit ce que
            l&apos;application <em>est</em>, jamais comment on la déploie.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 text-sm">
          <Section title="L’idée directrice">
            <p className="text-muted-foreground">
              Une AppSpec est un JSON. Elle décrit des services, leurs ports, leurs variables,
              leurs volumes. Elle ne connaît ni Docker ni Kubernetes : aucun champ ne peut être
              rattaché à un runtime. Pas de <Code>restart_policy</Code>, pas d’
              <Code>image_pull_policy</Code>, pas de <Code>namespace</Code>.
            </p>
            <p className="text-muted-foreground">
              La traduction vers un <Code>compose.yml</Code> ou vers des manifests Kubernetes a
              lieu au moment du déploiement, dans le driver. Conséquence recherchée : la même
              AppSpec se déploie sur Docker Compose ou sur K3s en changeant un seul champ —{' '}
              <strong className="text-foreground font-medium">
                le runtime de la cible, qui n’est pas dans la spec
              </strong>
              .
            </p>
          </Section>

          <Section title="Les champs">
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Champ</th>
                  <th className="px-3 py-2 font-medium">À quoi il sert</th>
                  <th className="px-3 py-2 font-medium">Contraintes</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((field) => (
                  <tr key={field.name} className="border-t align-top">
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{field.name}</td>
                    <td className="text-muted-foreground px-3 py-2">{field.role}</td>
                    <td className="text-muted-foreground px-3 py-2">{field.constraint}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <p className="text-muted-foreground text-xs">
              Les champs sans valeur explicite prennent leur défaut à la validation. Une spec
              minimale tient donc en quelques lignes.
            </p>
          </Section>

          <Section title="Les six garde-fous">
            <p className="text-muted-foreground">
              Ce ne sont pas des types, mais des règles croisées vérifiées par Zod avant tout
              enregistrement. Une spec qui en viole une est refusée, et l’erreur nomme le champ
              fautif.
            </p>
            <ol className="space-y-2">
              {GUARDS.map((guard, index) => (
                <li key={guard.rule} className="flex gap-3">
                  <span className="bg-muted text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  <div className="space-y-0.5">
                    <div className="text-foreground font-medium">{guard.rule}</div>
                    <p className="text-muted-foreground text-xs">{guard.why}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <Section title="Ce qu’elle devient, selon le runtime">
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">AppSpec</th>
                  <th className="px-3 py-2 font-medium">Docker Compose</th>
                  <th className="px-3 py-2 font-medium">Kubernetes (K3s)</th>
                </tr>
              </thead>
              <tbody>
                {MAPPING.map((row, index) => (
                  <tr key={index} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{row.field}</td>
                    <td className="text-muted-foreground px-3 py-2">{row.docker}</td>
                    <td className="text-muted-foreground px-3 py-2">{row.k3s}</td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">
                Le point le plus parlant est ce qui n’a{' '}
                <strong className="text-foreground font-medium">aucun</strong> champ dans la
                spec. La politique de redémarrage (<Code>restart: unless-stopped</Code> côté
                Compose) et le contexte de sécurité (<Code>runAsNonRoot</Code>, UID 1000,{' '}
                <Code>capabilities: drop ALL</Code> côté Kubernetes) sont décidés par le driver.
                C’est délibéré : ce sont des décisions de runtime, et les exprimer dans la spec
                la rattacherait à un moteur d’exécution.
              </p>
            </div>
          </Section>

          <Section title="Un exemple minimal">
            <p className="text-muted-foreground">
              Une image publiée, un seul service, pas d’ingress. Le panel expose alors sur un
              port alloué sur la cible. Les <Code>{'//'}</Code> sont des commentaires
              d’explication : JSON ne les accepte pas, retirez-les avant de coller.
            </p>
            <pre className="bg-muted/50 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
              <code>{SIMPLE_EXAMPLE}</code>
            </pre>
          </Section>

          <Section title="Un exemple complet">
            <p className="text-muted-foreground">
              Trois services, des sources à construire, des secrets, un volume persistant, des
              dépendances et un nom de domaine. Extrait, les valeurs par défaut en moins.
            </p>
            <pre className="bg-muted/50 overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
              <code>{FULLSTACK_EXAMPLE}</code>
            </pre>
            <p className="text-muted-foreground text-xs">
              <Code>front</Code> dépend d’<Code>api</Code>, qui dépend de <Code>postgres</Code>{' '}
              : le graphe est acyclique, un seul service est exposé, et{' '}
              <Code>DATABASE_PASSWORD</Code> n’apparaît que dans <Code>secrets</Code>. Les six
              garde-fous passent.
            </p>
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

const SIMPLE_EXAMPLE = `{
  "name": "demo-api",              // slug : minuscules, chiffres, tirets
  "version": "1.0.0",              // semver
  "services": [
    {
      "name": "api",
      "source": {                  // union sur "type" : image | dockerfile
        "type": "image",
        "ref": "docker.io/library/nginx:1.29-alpine"
      },
      "port": 80,                  // port d'écoute dans le conteneur
      "exposed": true,             // exactement un service à true
      "env": { "NODE_ENV": "production" },
      "healthcheck": {             // sondé sur "/" toutes les 5 s, 10 essais
        "path": "/",
        "intervalSec": 5,
        "timeoutSec": 3,
        "retries": 10
      },
      "resources": { "cpuMilli": 500, "memoryMi": 256 }
    }
  ]
}`;

const FULLSTACK_EXAMPLE = `{
  "name": "boutique",
  "version": "2.3.1",
  "services": [
    {
      "name": "front",
      "source": {                            // sources bâties sur la cible
        "type": "dockerfile",
        "context": "./front",
        "dockerfile": "Dockerfile"
      },
      "port": 3000,
      "exposed": true,                       // la porte d'entrée
      "replicas": 2,
      "env": { "API_URL": "http://api:8080" }, // le nom du service EST l'hôte
      "dependsOn": ["api"]
    },
    {
      "name": "api",
      "source": { "type": "dockerfile", "context": "./api",
                  "dockerfile": "docker/Dockerfile" },
      "port": 8080,
      "env": { "DATABASE_HOST": "postgres" },
      "secrets": ["DATABASE_PASSWORD", "JWT_SECRET"], // noms seuls, pas de valeurs
      "volumes": [
        { "name": "uploads", "mountPath": "/var/lib/app/uploads", "size": "5Gi" }
      ],
      "dependsOn": ["postgres"]
    },
    {
      "name": "postgres",
      "source": { "type": "image", "ref": "postgres:16-alpine" },
      "port": 5432,
      "secrets": ["POSTGRES_PASSWORD"],
      "healthcheck": { "port": 5432, "intervalSec": 5, "retries": 10 },
      "volumes": [
        { "name": "data", "mountPath": "/var/lib/postgresql/data", "size": "20Gi" }
      ]
    }
  ],
  "ingress": {                               // facultatif
    "host": "boutique.example.com",
    "tls": true,
    "targetService": "front"                 // doit exister dans services[]
  }
}`;
