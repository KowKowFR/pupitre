'use client';

import * as React from 'react';
import Link from 'next/link';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useT } from '@/i18n/client';
import { chrome } from '@/i18n/messages/chrome';
import {
  dismissToast,
  getToasts,
  removeToast,
  subscribeToasts,
  type ToastItem,
  type ToastTone,
} from '@/lib/toast';

const ICON: Record<ToastTone, React.ComponentType<{ 'aria-hidden'?: boolean }>> = {
  ok: CircleCheck,
  accent: Info,
  warn: TriangleAlert,
  danger: CircleAlert,
};

const ICON_COLOR: Record<ToastTone, string> = {
  ok: 'text-ok',
  accent: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
};

/**
 * The toasts stack, at the bottom right. Rendered once, in the shell.
 * `aria-live="polite"`: a toast announces itself without interrupting; an error
 * goes `role="alert"`.
 */
export function Toaster() {
  const t = useT(chrome);
  const toasts = React.useSyncExternalStore(subscribeToasts, getToasts, () => EMPTY);
  return (
    <section
      aria-label={t('toast.region')}
      aria-live="polite"
      className="toasts pointer-events-none"
    >
      {toasts.map((item) => (
        <Toast key={item.id} item={item} dismissLabel={t('toast.dismiss')} />
      ))}
    </section>
  );
}

const EMPTY: ToastItem[] = [];

function Toast({ item, dismissLabel }: { item: ToastItem; dismissLabel: string }) {
  const Icon = ICON[item.tone];
  const [paused, setPaused] = React.useState(false);
  const remaining = React.useRef(item.life);
  const startedAt = React.useRef(0);

  // The timer follows the bar: it stops on hover and resumes where it was, so that
  // the bar never lies about the time left.
  React.useEffect(() => {
    if (item.life === null || item.closing) return;
    if (paused) {
      remaining.current = Math.max(0, (remaining.current ?? 0) - (Date.now() - startedAt.current));
      return;
    }
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => dismissToast(item.id), remaining.current ?? 0);
    return () => window.clearTimeout(timer);
  }, [item.id, item.life, item.closing, paused]);

  return (
    <div
      role={item.tone === 'danger' ? 'alert' : 'status'}
      data-state={item.closing ? 'closed' : 'open'}
      className="toast pointer-events-auto"
      style={item.life ? ({ '--toast-life': `${item.life}ms` } as React.CSSProperties) : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onAnimationEnd={(event) => {
        if (item.closing && event.target === event.currentTarget) removeToast(item.id);
      }}
    >
      <span className={`mt-px ${ICON_COLOR[item.tone]}`}>
        <Icon aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-text">{item.title}</span>
        {item.description ? <span className="t-cap text-text-3">{item.description}</span> : null}
        {item.action ? (
          item.action.href ? (
            <Link
              href={item.action.href as never}
              className="link mt-1 w-fit text-[12.5px] font-medium"
              onClick={() => dismissToast(item.id)}
            >
              {item.action.label}
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn-link mt-1 w-fit text-[12.5px]"
              onClick={() => {
                item.action?.onClick?.();
                dismissToast(item.id);
              }}
            >
              {item.action.label}
            </button>
          )
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-label={dismissLabel}
        onClick={() => dismissToast(item.id)}
      >
        <X aria-hidden className="!size-3.5" />
      </button>
      {item.life ? (
        <span
          className="bar"
          aria-hidden
          style={paused ? { animationPlayState: 'paused' } : undefined}
        />
      ) : null}
    </div>
  );
}
