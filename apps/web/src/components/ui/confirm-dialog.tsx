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
import { withSlot } from '@/lib/rich';

/**
 * A confirmation dialog, in three levels (see `lib/confirm.ts`).
 *
 * The title is a **question that names the object and the place** ("Destroy blog
 * on prod-1?"), the body lists the consequences as bullets, the footer carries
 * "Cancel" then the verb. For a destructive action, the focus starts on Cancel:
 * Enter by reflex destroys nothing.
 *
 * The dialog does not close by itself when `onConfirm` fails: the caller shows
 * the error in `error`, and the operator can try again or cancel.
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
  /** What is going to happen, one consequence per bullet. */
  consequences?: React.ReactNode[];
  /** Free content under the consequences (options, log note…). */
  children?: React.ReactNode;
  confirmLabel: React.ReactNode;
  pendingLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** Level 3: the exact name to type again. */
  retypeName?: string;
  /** The input field's label, when the default wording does not suit. */
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
          // Destructive: the focus starts on Cancel. Level 3: in the field.
          if (needsName) return;
          if (destructive) {
            event.preventDefault();
            cancelRef.current?.focus();
          }
        }}
      >
        {/*
          The content is unmounted on closing: the name input therefore starts
          empty again at each opening, without a reset effect.
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
              {retypeLabel ??
                withSlot(
                  (name) => t('confirm.retype', { name }),
                  <span className="mono">{retypeName}</span>,
                )}
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
        <Button
          variant={confirmVariant(level)}
          disabled={!unlocked}
          loading={pending}
          onClick={() => void onConfirm()}
        >
          {pending && pendingLabel ? pendingLabel : confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
