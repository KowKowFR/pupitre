'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export type TargetFormValues = {
  id?: string;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  authMethod: 'key' | 'password';
  sudoMethod: 'nopasswd' | 'password';
  portRangeStart: number;
  portRangeEnd: number;
  labels: Record<string, string>;
};

const EMPTY: TargetFormValues = {
  name: '',
  host: '',
  port: 22,
  sshUser: 'root',
  authMethod: 'key',
  sudoMethod: 'nopasswd',
  portRangeStart: 30_000,
  portRangeEnd: 32_767,
  labels: {},
};

function labelsToText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function textToLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key && value) labels[key] = value;
  }
  return labels;
}

/** Ce que l'API rend après création. Seuls les champs dont l'appelant se sert. */
export type CreatedTarget = { id: string; name: string };

export type TargetFormProps = {
  initial?: TargetFormValues;
  /**
   * Point d'extension pour l'assistant de démarrage : la création reste
   * exactement la même — `POST /api/targets`, mêmes champs, même 409, même
   * audit — seule la suite change. Sans ce rappel, le formulaire quitte la
   * page, ce qui n'a aucun sens au milieu d'un parcours guidé.
   * Absent : comportement d'origine, inchangé.
   */
  onCreated?: (target: CreatedTarget) => void;
  /** `null` retire le bouton « Annuler » — un parcours guidé a sa propre sortie. */
  onCancel?: (() => void) | null;
  submitLabel?: string;
};

export function TargetForm({ initial, onCreated, onCancel, submitLabel }: TargetFormProps) {
  const router = useRouter();
  const values = initial ?? EMPTY;
  const isEdit = Boolean(values.id);

  const [authMethod, setAuthMethod] = useState(values.authMethod);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const form = new FormData(event.currentTarget);
    const credential = String(form.get('credential') ?? '').trim();

    const payload: Record<string, unknown> = {
      name: String(form.get('name') ?? '').trim(),
      host: String(form.get('host') ?? '').trim(),
      port: Number(form.get('port') ?? 22),
      sshUser: String(form.get('sshUser') ?? '').trim(),
      authMethod: String(form.get('authMethod') ?? 'key'),
      sudoMethod: String(form.get('sudoMethod') ?? 'nopasswd'),
      portRangeStart: Number(form.get('portRangeStart') ?? 30_000),
      portRangeEnd: Number(form.get('portRangeEnd') ?? 32_767),
      labels: textToLabels(String(form.get('labels') ?? '')),
    };

    // En édition, un champ laissé vide conserve le credential déjà en base :
    // il n'est jamais pré-rempli, donc jamais réémis vers le navigateur.
    if (credential) payload.credential = credential;
    else if (!isEdit) {
      setError(authMethod === 'key' ? 'La clé privée est requise.' : 'Le mot de passe est requis.');
      setPending(false);
      return;
    }

    const response = await fetch(isEdit ? `/api/targets/${values.id}` : '/api/targets', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      setError(body.error?.message ?? `Échec (HTTP ${response.status})`);
      setPending(false);
      return;
    }

    const target = (await response.json()) as CreatedTarget;
    if (onCreated) {
      setPending(false);
      onCreated(target);
      return;
    }
    router.push(`/targets/${target.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Nom</Label>
          <Input id="name" name="name" defaultValue={values.name} required minLength={2} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sshUser">Utilisateur SSH</Label>
          <Input id="sshUser" name="sshUser" defaultValue={values.sshUser} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="host">Hôte</Label>
          <Input id="host" name="host" defaultValue={values.host} placeholder="10.0.0.12" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="port">Port</Label>
          <Input id="port" name="port" type="number" min={1} max={65535} defaultValue={values.port} required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="authMethod">Authentification</Label>
          <Select
            id="authMethod"
            name="authMethod"
            defaultValue={values.authMethod}
            onChange={(event) => setAuthMethod(event.target.value as 'key' | 'password')}
          >
            <option value="key">Clé privée</option>
            <option value="password">Mot de passe</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sudoMethod">Élévation sudo</Label>
          <Select id="sudoMethod" name="sudoMethod" defaultValue={values.sudoMethod}>
            <option value="nopasswd">sudo sans mot de passe</option>
            <option value="password">sudo avec mot de passe</option>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="credential">
          {authMethod === 'key' ? 'Clé privée SSH' : 'Mot de passe'}
        </Label>
        {authMethod === 'key' ? (
          <textarea
            id="credential"
            name="credential"
            rows={8}
            spellCheck={false}
            autoComplete="off"
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
            className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-ink outline-none transition-[border-color,box-shadow] duration-100 ease-out placeholder:text-ink-faint focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-signal/25"
          />
        ) : (
          <Input id="credential" name="credential" type="password" autoComplete="new-password" />
        )}
        <p className="text-xs text-ink-muted">
          Chiffré en AES-256-GCM avant insertion. Jamais renvoyé par l&apos;API, jamais journalisé.
          {isEdit ? ' Laissez vide pour conserver le credential actuel.' : ''}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Plage de ports publiables</Label>
        <div className="flex items-center gap-2">
          <Input
            id="portRangeStart"
            name="portRangeStart"
            type="number"
            min={1024}
            max={65535}
            defaultValue={values.portRangeStart}
            required
            className="w-32"
          />
          <span className="text-sm text-ink-faint">→</span>
          <Input
            id="portRangeEnd"
            name="portRangeEnd"
            type="number"
            min={1024}
            max={65535}
            defaultValue={values.portRangeEnd}
            required
            className="w-32"
          />
        </div>
        <p className="text-xs text-ink-muted">
          Ce que le pare-feu de cette machine laisse passer. Chaque application déployée en
          Docker y réserve un port, garanti unique par la base.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="labels">Étiquettes</Label>
        <textarea
          id="labels"
          name="labels"
          rows={3}
          defaultValue={labelsToText(values.labels)}
          placeholder={'env=prod\nzone=eu-west'}
          className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-ink outline-none transition-[border-color,box-shadow] duration-100 ease-out placeholder:text-ink-faint focus-visible:border-signal focus-visible:ring-[3px] focus-visible:ring-signal/25"
        />
        <p className="text-xs text-ink-muted">Une paire <code>clé=valeur</code> par ligne.</p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending
            ? 'Enregistrement…'
            : (submitLabel ?? (isEdit ? 'Enregistrer' : 'Créer la cible'))}
        </Button>
        {onCancel === null ? null : (
          <Button type="button" variant="ghost" onClick={onCancel ?? (() => router.back())}>
            Annuler
          </Button>
        )}
      </div>
    </form>
  );
}
