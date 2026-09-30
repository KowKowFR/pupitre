'use client';

import * as React from 'react';
import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { cn } from '@/lib/utils';

/**
 * Champ complet : intitulé, contrôle, erreur, aide — dans cet ordre, comme
 * sur la planche des formulaires. L'erreur passe avant l'aide parce que c'est
 * elle qu'on doit lire en premier quand elle existe.
 *
 * Le contrôle passé en enfant reçoit son `id`, `aria-invalid` et
 * `aria-describedby` : l'appelant n'a pas à câbler l'accessibilité à la main,
 * et ne peut donc pas l'oublier.
 */
export function Field({
  label,
  help,
  error,
  optional = false,
  htmlFor,
  className,
  children,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const t = useT(chrome);
  const generated = React.useId();
  const child = React.Children.count(children) === 1 && React.isValidElement(children) ? children : null;
  const childProps = (child?.props ?? {}) as { id?: string; 'aria-describedby'?: string };
  const id = htmlFor ?? childProps.id ?? generated;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy =
    [childProps['aria-describedby'], error ? errorId : null, help ? helpId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  const control = child
    ? React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
      })
    : children;

  return (
    <div data-slot="field" className={cn('field', className)}>
      <label htmlFor={id} className="label">
        {label}
        {optional ? <span className="opt">{t('field.optional')}</span> : null}
      </label>
      {control}
      {error ? (
        <span id={errorId} className="err" role="alert">
          <CircleAlert aria-hidden />
          <span>{error}</span>
        </span>
      ) : null}
      {help ? (
        <span id={helpId} className="help">
          {help}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Secret : toujours vide à l'édition — le panel ne renvoie jamais un secret
 * enregistré au navigateur. Quand une valeur existe déjà (`stored`), le
 * placeholder dit qu'un champ vide la conserve. Le bouton Afficher ne montre
 * que ce qu'on est en train de taper.
 */
export function SecretInput({
  stored = false,
  className,
  placeholder,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'> & { stored?: boolean }) {
  const t = useT(chrome);
  const [shown, setShown] = React.useState(false);
  return (
    <span className="affix has-end">
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete={props.autoComplete ?? 'new-password'}
        spellCheck={false}
        placeholder={placeholder ?? (stored ? t('secret.keep') : undefined)}
        className={cn('input mono !pl-[11px]', className)}
      />
      <span className="affix-end">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {shown ? t('secret.hide') : t('secret.show')}
        </button>
      </span>
    </span>
  );
}

/**
 * Code à usage unique : six cases, un espace après la troisième. Le collage
 * d'un code entier se répartit ; Retour arrière recule d'une case. Un champ
 * caché porte la valeur complète pour les formulaires classiques (`name`).
 */
export function OtpInput({
  value,
  onChange,
  name,
  autoFocus = false,
  disabled = false,
  invalid = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  name?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const t = useT(chrome);
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? '');

  function setAt(index: number, digit: string) {
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join('').replace(/\s/g, ''));
  }

  function focus(index: number) {
    refs.current[Math.max(0, Math.min(5, index))]?.focus();
  }

  return (
    <div role="group" aria-label={t('otp.label')} className={cn('otp', className)}>
      {digits.map((digit, index) => (
        <React.Fragment key={index}>
          {index === 3 ? <span className="otp-gap" aria-hidden /> : null}
          <input
            ref={(node) => {
              refs.current[index] = node;
            }}
            className="input"
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={1}
            value={digit}
            disabled={disabled}
            autoFocus={autoFocus && index === 0}
            aria-label={t('otp.digit', { index: index + 1 })}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              const typed = event.target.value.replace(/\D/g, '');
              if (typed.length > 1) {
                // Saisie automatique du système ou collage : on répartit.
                onChange(typed.slice(0, 6));
                focus(typed.length);
                return;
              }
              setAt(index, typed);
              if (typed) focus(index + 1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !digit) focus(index - 1);
              if (event.key === 'ArrowLeft') focus(index - 1);
              if (event.key === 'ArrowRight') focus(index + 1);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
              if (!pasted) return;
              event.preventDefault();
              onChange(pasted);
              focus(pasted.length);
            }}
          />
        </React.Fragment>
      ))}
      {name ? <input type="hidden" name={name} value={value} /> : null}
    </div>
  );
}
