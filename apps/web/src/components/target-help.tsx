'use client';

import {
  ArrowLeftRight,
  KeyRound,
  ListChecks,
  ListOrdered,
  Network,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import {
  HelpBlock,
  HelpCallout,
  HelpDrawer,
  HelpList,
  HelpSection,
  HelpSteps,
  HelpTable,
  rich,
} from '@/components/help-drawer';
import { useT } from '@/i18n/client';
import { targetHelp } from '@/i18n/messages/target-help';

/**
 * Aide sur les machines cibles — contenu statique, aucune donnée serveur.
 *
 * Un tiroir du kit d'aide (`components/help-drawer.tsx`) : il s'ouvre à côté
 * du formulaire qu'il explique. Chaque commande citée est celle des scripts du
 * dépôt (`scripts/setup-test-target.sh`, `scripts/test-target/`), et chaque
 * contrôle décrit est celui de `packages/core/src/ssh/preflight.ts` — dans son
 * ordre d'exécution réel. Les messages d'erreur sont recopiés depuis
 * `packages/core/src/ssh/{client,errors}.ts` et les `DriverError` des drivers.
 *
 * Le texte vit dans `i18n/messages/target-help.ts` ; ce fichier n'en garde que
 * la structure, les teintes, et les deux blocs shell, qui sont du code à
 * copier, pas de la prose.
 */

type Props = {
  label?: string;
  className?: string;
};

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
const CHECKS = [
  'ssh',
  'os',
  'sudo',
  'tools',
  'firewall',
  'docker',
  'k3s',
  'disk',
  'memory',
] as const;

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

export function TargetHelp({ label, className }: Props) {
  const t = useT(targetHelp);

  return (
    <HelpDrawer
      triggerLabel={label ?? t('trigger.label')}
      title={t('dialog.title')}
      description={t('dialog.description')}
      className={className}
    >
      <HelpSection icon={ArrowLeftRight} title={t('roles.title')}>
        <p>{t('roles.intro')}</p>
        <HelpTable
          columns={[
            { key: 'topic', label: '' },
            { key: 'panel', label: t('roles.column.panel'), tone: 'accent' },
            { key: 'target', label: t('roles.column.target'), tone: 'ok' },
          ]}
          rows={ROLES.map((row) => ({
            key: row,
            cells: [
              t(`role.${row}.topic`),
              rich(t(`role.${row}.panel`)),
              rich(t(`role.${row}.target`)),
            ],
          }))}
        />
        <HelpCallout tone="accent">{rich(t('roles.callout'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={Terminal} title={t('prepare.title')}>
        <p>{rich(t('prepare.intro'))}</p>
        <HelpBlock>{PREPARE_SCRIPT}</HelpBlock>
        <HelpCallout tone="warn">{rich(t('prepare.traps'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={KeyRound} title={t('key.title')}>
        <p>{rich(t('key.intro'))}</p>
        <HelpBlock>{KEY_SCRIPT}</HelpBlock>
        <p>{rich(t('key.paste'))}</p>
        <HelpCallout tone="ok">{rich(t('key.crypto'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={ListChecks} title={t('fields.title')}>
        <HelpTable
          columns={[
            { key: 'field', label: t('fields.column.field'), nowrap: true },
            { key: 'role', label: t('fields.column.role') },
            { key: 'wrong', label: t('fields.column.wrong'), tone: 'warn' },
          ]}
          rows={FIELDS.map((field) => ({
            key: field,
            cells: [
              t(`field.${field}.name`),
              rich(t(`field.${field}.role`)),
              rich(t(`field.${field}.wrong`)),
            ],
          }))}
        />
      </HelpSection>

      <HelpSection icon={Network} title={t('ports.title')}>
        <p>{rich(t('ports.intro'))}</p>
        <HelpList
          items={PORT_NOTES.map((note) => ({ key: note, content: rich(t(`ports.${note}`)) }))}
        />
      </HelpSection>

      <HelpSection icon={ShieldCheck} tone="ok" title={t('checks.title')}>
        <p>{rich(t('checks.intro'))}</p>
        <HelpTable
          columns={[
            { key: 'check', label: t('checks.column.check'), nowrap: true },
            { key: 'what', label: t('checks.column.what') },
            { key: 'failure', label: t('checks.column.failure'), tone: 'danger' },
          ]}
          rows={CHECKS.map((check, index) => ({
            key: check,
            cells: [
              <span key="check" className="inline-flex items-center gap-2">
                <span className="grid size-5 place-items-center rounded-full border border-ok-line bg-ok-soft text-[11px] font-semibold text-ok-text tabular-nums">
                  {index + 1}
                </span>
                <code className="mono text-[12px]">{check}</code>
              </span>,
              rich(t(`check.${check}.what`)),
              rich(t(`check.${check}.failure`)),
            ],
          }))}
        />
        <HelpCallout tone="neutral">{rich(t('checks.status'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={ListOrdered} title={t('tutorial.title')}>
        <HelpSteps
          steps={TUTORIAL.map((step) => ({
            key: step,
            title: t(`step.${step}.title`),
            body: rich(t(`step.${step}.body`)),
          }))}
        />
        <HelpCallout tone="accent">{rich(t('tutorial.shortcut'))}</HelpCallout>
      </HelpSection>

      <HelpSection icon={TriangleAlert} tone="danger" title={t('failures.title')}>
        <HelpTable
          columns={[
            { key: 'symptom', label: t('failures.column.symptom'), tone: 'danger' },
            { key: 'cause', label: t('failures.column.cause'), tone: 'ok' },
          ]}
          rows={FAILURES.map((failure) => ({
            key: failure,
            cells: [rich(t(`failure.${failure}.symptom`)), rich(t(`failure.${failure}.cause`))],
          }))}
        />
      </HelpSection>
    </HelpDrawer>
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
