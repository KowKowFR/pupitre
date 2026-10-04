'use client';

import * as React from 'react';
import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import { cn } from '@/lib/utils';
import { HelpTip } from './help-tip';

/**
 * Where a field's help reads: under the control (`inline`, by default), or folded
 * into a tooltip next to the label (`tip`). A dense screen — the settings —
 * chooses `tip` once for all its fields.
 */
const FieldHelpContext = React.createContext<'inline' | 'tip'>('inline');

export function FieldHelpMode({
  mode,
  children,
}: {
  mode: 'inline' | 'tip';
  children: React.ReactNode;
}) {
  return <FieldHelpContext.Provider value={mode}>{children}</FieldHelpContext.Provider>;
}

/** The help mode in force, for helps set by hand outside a `Field`. */
export function useFieldHelpMode(): 'inline' | 'tip' {
  return React.useContext(FieldHelpContext);
}

/**
 * A complete field: label, control, error, help — in this order, as on the
 * forms board. The error comes before the help because it is the one to read
 * first when it exists.
 *
 * The control passed as a child receives its `id`, `aria-invalid` and
 * `aria-describedby`: the caller does not have to wire accessibility by hand, and
 * therefore cannot forget it.
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
  const helpMode = React.useContext(FieldHelpContext);
  const generated = React.useId();
  const child =
    React.Children.count(children) === 1 && React.isValidElement(children) ? children : null;
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
        {help && helpMode === 'tip' ? <HelpTip>{help}</HelpTip> : null}
      </label>
      {control}
      {error ? (
        <span id={errorId} className="err" role="alert">
          <CircleAlert aria-hidden />
          <span>{error}</span>
        </span>
      ) : null}
      {help ? (
        // Folded into a tooltip, the help stays the control's description for a screen
        // reader: it is there, simply out of view.
        <span id={helpId} className={helpMode === 'tip' ? 'sr-only' : 'help'}>
          {help}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A secret: always empty when editing — the panel never sends a saved secret back
 * to the browser. When a value already exists (`stored`), the placeholder says
 * that an empty field keeps it. The Show button only shows what is being typed.
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
 * A one-time code: six cells, a space after the third. Pasting a whole code
 * spreads it; Backspace moves back one cell. A hidden field carries the complete
 * value for classic forms (`name`).
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
                // The system's autofill or a paste: we spread it.
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
