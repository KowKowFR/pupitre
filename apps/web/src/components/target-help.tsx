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
import { useT } from '@/i18n/client';
import { common } from '@/i18n/messages/common';
import { targetHelp } from '@/i18n/messages/target-help';
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
 *
 * Le texte, lui, vit dans `i18n/messages/target-help.ts` : cent cinquante
 * phrases dont aucune ne s'affiche tant que la modale n'est pas ouverte. Ce
 * fichier n'en garde que la structure — les tableaux, l'ordre des sections —
 * et les deux blocs shell, qui sont du code à copier, pas de la prose.
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

/**
 * Le balisage en ligne des messages, rendu.
 *
 * Une entrée de dictionnaire est une chaîne : elle ne peut pas porter de JSX.
 * Quatre marques suffisent pourtant à tout ce que cette aide met en forme —
 * `` `code` ``, `**gras**`, `__gras de tête__`, `*italique*` — et les rendre
 * ici évite de découper chaque phrase en cinq clés que le traducteur devrait
 * réassembler dans l'ordre de sa langue.
 *
 * Récursif, parce qu'un gras de tête contient parfois du code
 * (« L'anti-collision n'est pas un `if`. »). Le contenu d'un `` `…` `` ne l'est
 * pas : c'est du code, on ne le relit pas.
 */
const INLINE = /(`[^`]+`|__[^_]+__|\*\*[^*]+\*\*|\*[^*]+\*)/;

function rich(text: string): React.ReactNode {
  return text.split(INLINE).map((part, index) => {
    if (!part) return null;
    if (part.startsWith('`')) return <Code key={index}>{part.slice(1, -1)}</Code>;
    if (part.startsWith('__')) {
      return (
        <strong key={index} className="text-foreground font-medium">
          {rich(part.slice(2, -2))}
        </strong>
      );
    }
    if (part.startsWith('**')) return <strong key={index}>{rich(part.slice(2, -2))}</strong>;
    if (part.startsWith('*')) return <em key={index}>{rich(part.slice(1, -1))}</em>;
    return part;
  });
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
const ROLES = ['role', 'code', 'wire', 'reach', 'down'] as const;

const FIELDS = [
  'name',
  'host',
  'port',
  'user',
  'auth',
  'sudo',
  'credential',
  'portRange',
  'labels',
] as const;

/** Dans l'ordre où `runPreflight()` les exécute. 15 s de délai par contrôle. */
const CHECKS = ['ssh', 'os', 'sudo', 'tools', 'firewall', 'docker', 'k3s', 'disk', 'memory'] as const;

const FAILURES = [
  'publickey',
  'connect',
  'sudoPassword',
  'sudoConfig',
  'dockerSock',
  'kubeconfig',
  'noPort',
  'deployRoot',
  'ufwInactive',
  'deleteRefused',
] as const;

const TUTORIAL = [
  'machine',
  'account',
  'key',
  'runtime',
  'sudo',
  'firewall',
  'declare',
  'preflight',
  'app',
  'deploy',
] as const;

/** Les puces de la section « plage de ports », dans l'ordre de lecture. */
const PORT_NOTES = ['collision', 'blind', 'firewall', 'workerRange', 'narrow'] as const;

export function TargetHelpDialog({ label, className }: Props) {
  const t = useT(targetHelp);
  const tc = useT(common);

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
          {label ?? t('trigger.label')}
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-6 text-sm">
          <Section title={t('roles.title')}>
            <p className="text-muted-foreground">{t('roles.intro')}</p>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">{t('roles.column.panel')}</th>
                  <th className="px-3 py-2 font-medium">{t('roles.column.target')}</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((row) => (
                  <tr key={row} className="border-t align-top">
                    <td className="text-foreground px-3 py-2 font-medium">
                      {t(`role.${row}.topic`)}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`role.${row}.panel`))}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`role.${row}.target`))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">{rich(t('roles.callout'))}</p>
            </div>
          </Section>

          <Section title={t('prepare.title')}>
            <p className="text-muted-foreground">{rich(t('prepare.intro'))}</p>
            <Shell>{PREPARE_SCRIPT}</Shell>
            <p className="text-muted-foreground text-xs">{rich(t('prepare.traps'))}</p>
          </Section>

          <Section title={t('key.title')}>
            <p className="text-muted-foreground">{rich(t('key.intro'))}</p>
            <Shell>{KEY_SCRIPT}</Shell>
            <p className="text-muted-foreground">{rich(t('key.paste'))}</p>
            <div className="bg-muted/40 rounded-md border px-3 py-2">
              <p className="text-muted-foreground text-xs">{rich(t('key.crypto'))}</p>
            </div>
          </Section>

          <Section title={t('fields.title')}>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('fields.column.field')}</th>
                  <th className="px-3 py-2 font-medium">{t('fields.column.role')}</th>
                  <th className="px-3 py-2 font-medium">{t('fields.column.wrong')}</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((field) => (
                  <tr key={field} className="border-t align-top">
                    <td className="text-foreground px-3 py-2 font-medium whitespace-nowrap">
                      {t(`field.${field}.name`)}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`field.${field}.role`))}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`field.${field}.wrong`))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
          </Section>

          <Section title={t('ports.title')}>
            <p className="text-muted-foreground">{rich(t('ports.intro'))}</p>
            <ul className="text-muted-foreground list-disc space-y-1.5 pl-5">
              {PORT_NOTES.map((note) => (
                <li key={note}>{rich(t(`ports.${note}`))}</li>
              ))}
            </ul>
          </Section>

          <Section title={t('checks.title')}>
            <p className="text-muted-foreground">{rich(t('checks.intro'))}</p>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('checks.column.check')}</th>
                  <th className="px-3 py-2 font-medium">{t('checks.column.what')}</th>
                  <th className="px-3 py-2 font-medium">{t('checks.column.failure')}</th>
                </tr>
              </thead>
              <tbody>
                {CHECKS.map((check, index) => (
                  <tr key={check} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="text-muted-foreground mr-1.5 text-[0.7rem] tabular-nums">
                        {index + 1}.
                      </span>
                      <code className="text-foreground font-mono text-[0.75rem]">{check}</code>
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`check.${check}.what`))}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`check.${check}.failure`))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
            <p className="text-muted-foreground text-xs">{rich(t('checks.status'))}</p>
          </Section>

          <Section title={t('tutorial.title')}>
            <ol className="space-y-2.5">
              {TUTORIAL.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="bg-muted text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="text-foreground font-medium">{t(`step.${step}.title`)}</div>
                    <div className="text-muted-foreground text-xs">
                      {rich(t(`step.${step}.body`))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-muted-foreground text-xs">{rich(t('tutorial.shortcut'))}</p>
          </Section>

          <Section title={t('failures.title')}>
            <ScrollableTable>
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('failures.column.symptom')}</th>
                  <th className="px-3 py-2 font-medium">{t('failures.column.cause')}</th>
                </tr>
              </thead>
              <tbody>
                {FAILURES.map((failure) => (
                  <tr key={failure} className="border-t align-top">
                    <td className="text-foreground px-3 py-2 md:w-2/5">
                      {rich(t(`failure.${failure}.symptom`))}
                    </td>
                    <td className="text-muted-foreground px-3 py-2">
                      {rich(t(`failure.${failure}.cause`))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </ScrollableTable>
          </Section>
        </DialogBody>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              {tc('close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Les deux blocs suivants sont du shell, pas de la prose : ils se copient tels
 * quels dans un terminal. Ni les commandes ni leurs commentaires ne se
 * traduisent — un `# 1 — a dedicated account` dans un panel anglais donnerait
 * un script qui ne correspond plus à celui du dépôt.
 */

// i18n-ignore — du shell à copier-coller, commentaires compris : c'est un
// fichier, pas une phrase. Voir le commentaire ci-dessus.
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
ssh -i ~/.ssh/pupitre-deploy deploy@10.0.0.12 '
  sudo -n true && echo "sudo   : nopasswd ok"
  docker info --format "{{.ServerVersion}}"
  docker compose version --short
'`;

// i18n-ignore — même raison que `PREPARE_SCRIPT` : du shell, pas de la prose.
const KEY_SCRIPT = `# sur VOTRE poste — une paire dédiée, sans passphrase (-N '')
ssh-keygen -t ed25519 -N '' -C 'pupitre' -f ~/.ssh/pupitre-deploy

# la publique part sur la cible
ssh-copy-id -i ~/.ssh/pupitre-deploy.pub deploy@10.0.0.12

# … ou à la main, avec les permissions exactes qu'exige sshd
#   mkdir -p ~/.ssh && chmod 700 ~/.ssh
#   cat >> ~/.ssh/authorized_keys        # coller pupitre-deploy.pub
#   chmod 600 ~/.ssh/authorized_keys
#   chown -R deploy:deploy ~/.ssh

# vérifier AVANT de remplir le formulaire
ssh -i ~/.ssh/pupitre-deploy deploy@10.0.0.12 true && echo 'clé acceptée'

# c'est le contenu de CE fichier-ci que l'on colle dans le formulaire
cat ~/.ssh/pupitre-deploy`;
