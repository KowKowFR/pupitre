'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type DialogTone,
} from '@/components/ui/dialog';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { common } from '@/i18n/messages/common';
import { confirmMatches, confirmVariant, type ConfirmLevel } from '@/lib/confirm';

/**
 * Dialogue de confirmation, en trois niveaux (voir `lib/confirm.ts`).
 *
 * Le titre est une **question qui nomme l'objet et le lieu** (« Détruire blog
 * sur prod-1 ? »), le corps liste les conséquences à puces, le pied porte
 * « Annuler » puis le verbe. Pour une action destructive, le focus démarre
 * sur Annuler : Entrée par réflexe ne détruit rien.
 *
 * Le dialogue ne ferme pas de lui-même quand `onConfirm` échoue : l'appelant
 * affiche l'erreur dans `error`, et l'opérateur peut réessayer ou annuler.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  level,
  title,
  description,
  consequences,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel,
  retypeName,
  retypeLabel,
  onConfirm,
  pending = false,
  error,
  icon,
  tone,
  size,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: ConfirmLevel;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Ce qui va se passer, une conséquence par puce. */
  consequences?: React.ReactNode[];
  /** Contenu libre sous les conséquences (options, note de journal…). */
  children?: React.ReactNode;
  confirmLabel: React.ReactNode;
  pendingLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** Niveau 3 : le nom exact à retaper. */
  retypeName?: string;
  /** Intitulé du champ de saisie, quand la formule par défaut ne convient pas. */
  retypeLabel?: React.ReactNode;
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
  error?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: DialogTone;
  size?: 'default' | 'wide';
}) {
  const destructive = level !== 'reversible';
  const needsName = level === 'data' && Boolean(retypeName);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent
        role="alertdialog"
        size={size}
        onOpenAutoFocus={(event) => {
          // Destructif : le focus démarre sur Annuler. Niveau 3 : dans le champ.
          if (needsName) return;
          if (destructive) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }}
      >
        {/*
          Le contenu est démonté à la fermeture : la saisie du nom repart donc
          vide à chaque ouverture, sans effet de remise à zéro.
        */}
        <ConfirmBody
          level={level}
          title={title}
          description={description}
          consequences={consequences}
          confirmLabel={confirmLabel}
          pendingLabel={pendingLabel}
          cancelLabel={cancelLabel}
          retypeName={needsName ? retypeName : undefined}
          retypeLabel={retypeLabel}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
          pending={pending}
          error={error}
          icon={icon ?? (destructive ? <Trash2 /> : undefined)}
          tone={tone ?? (destructive ? 'danger' : 'accent')}
          cancelRef={cancelRef}
        >
          {children}
        </ConfirmBody>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmBody({
  level,
  title,
  description,
  consequences,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel,
  retypeName,
  retypeLabel,
  onConfirm,
  onCancel,
  pending,
  error,
  icon,
  tone,
  cancelRef,
}: {
  level: ConfirmLevel;
  title: React.ReactNode;
  description?: React.ReactNode;
  consequences?: React.ReactNode[];
  children?: React.ReactNode;
  confirmLabel: React.ReactNode;
  pendingLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  retypeName?: string;
  retypeLabel?: React.ReactNode;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  pending: boolean;
  error?: React.ReactNode;
  icon?: React.ReactNode;
  tone: DialogTone;
  cancelRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const t = useT(chrome);
  const tc = useT(common);
  const [typed, setTyped] = React.useState('');
  const inputId = React.useId();
  const unlocked = retypeName === undefined || confirmMatches(typed, retypeName);

  return (
    <>
      <DialogHeader icon={icon} tone={tone}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        {consequences && consequences.length > 0 ? (
          <ul className="bul flex flex-col gap-1">
            {consequences.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        ) : null}
        {children}
        {retypeName !== undefined ? (
          <div className="field">
            <label htmlFor={inputId} className="label">
              {retypeLabel ?? t('confirm.retype', { name: retypeName })}
            </label>
            <input
              id={inputId}
              className="input mono"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              aria-describedby={`${inputId}-help`}
            />
            <span id={`${inputId}-help`} className="help">
              {t('confirm.retypeHelp')}
            </span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="err">
            {error}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button ref={cancelRef} variant="ghost" disabled={pending} onClick={onCancel}>
          {cancelLabel ?? tc('cancel')}
        </Button>
        <Button variant={confirmVariant(level)} disabled={!unlocked} loading={pending} onClick={() => void onConfirm()}>
          {pending && pendingLabel ? pendingLabel : confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
